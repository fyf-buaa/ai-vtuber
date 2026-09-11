import type { EventPublisher } from "../domain/types.js";
import {
  OutputBridgeError,
  OutputConfigError,
  publishOutputFailure,
  type OutputClock,
} from "./errors.js";

export type OutputFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OutputRequestDependencies {
  readonly fetch?: OutputFetch | undefined;
  readonly publisher?: EventPublisher | undefined;
  readonly clock?: OutputClock | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBodyBytes?: number | undefined;
}

export interface OutputRequestOptions extends OutputRequestDependencies {
  readonly component: string;
  readonly url: URL;
  readonly init?: RequestInit | undefined;
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

export function parseHttpUrl(value: string, component: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new OutputConfigError(component, `${component} has an invalid API URL`, cause);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutputConfigError(component, `${component} only supports HTTP(S) API URLs`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new OutputConfigError(component, `${component} API URL must not contain credentials`);
  }
  return url;
}

export function appendEndpoint(baseUrl: string, endpoint: string, component: string): URL {
  const base = parseHttpUrl(baseUrl, component);
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const endpointPath = endpoint.replace(/^\/+/, "");
  base.pathname = `${basePath}${endpointPath}`.replace(/\/{2,}/gu, "/");
  base.search = "";
  base.hash = "";
  return base;
}

function safeEndpoint(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

type RequestAbortKind = "external" | "timeout";

interface ActiveOutputRequest {
  readonly options: OutputRequestOptions;
  readonly signal: AbortSignal;
  readonly abortKind: RequestAbortKind | undefined;
  close(): void;
}

function startOutputRequest(options: OutputRequestOptions): ActiveOutputRequest {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new OutputConfigError(
      options.component,
      `${options.component} timeout must be a positive integer`,
    );
  }

  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const detach: Array<() => void> = [];
  let abortKind: RequestAbortKind | undefined;
  const link = (source: AbortSignal, kind: RequestAbortKind): void => {
    const abort = (): void => {
      if (!controller.signal.aborted) {
        abortKind = kind;
        controller.abort(source.reason);
      }
    };
    if (source.aborted) {
      abort();
      return;
    }
    source.addEventListener("abort", abort, { once: true });
    detach.push(() => source.removeEventListener("abort", abort));
  };

  if (options.signal !== undefined) {
    link(options.signal, "external");
  }
  link(timeoutSignal, "timeout");

  return {
    options,
    signal: controller.signal,
    get abortKind() {
      return abortKind;
    },
    close() {
      for (const removeListener of detach) {
        removeListener();
      }
      detach.length = 0;
    },
  };
}

function interruptedRequestError(
  request: ActiveOutputRequest,
  fallbackCause: unknown,
): OutputBridgeError {
  const { options } = request;
  const cause = request.signal.reason ?? fallbackCause;
  if (request.abortKind === "timeout") {
    return new OutputBridgeError(`${options.component} request timed out`, {
      code: "OUTPUT_TIMEOUT",
      component: options.component,
      ...(cause === undefined ? {} : { cause }),
    });
  }
  return new OutputBridgeError(`${options.component} request was aborted`, {
    code: "OUTPUT_ABORTED",
    component: options.component,
    ...(cause === undefined ? {} : { cause }),
  });
}

function waitForRequest<T>(
  request: ActiveOutputRequest,
  operation: () => Promise<T>,
): Promise<T> {
  const { signal } = request;
  if (signal.aborted) {
    return Promise.reject(interruptedRequestError(request, signal.reason));
  }

  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const aborted = (): void => {
    signal.removeEventListener("abort", aborted);
    reject(interruptedRequestError(request, signal.reason));
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) {
    aborted();
    return promise;
  }

  let pending: Promise<T>;
  try {
    pending = operation();
  } catch (cause) {
    signal.removeEventListener("abort", aborted);
    reject(cause);
    return promise;
  }
  void pending.then(
    (result) => {
      signal.removeEventListener("abort", aborted);
      resolve(result);
    },
    (cause: unknown) => {
      signal.removeEventListener("abort", aborted);
      reject(cause);
    },
  );
  return promise;
}

async function fetchChecked(request: ActiveOutputRequest): Promise<Response> {
  const { options } = request;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  try {
    const response = await waitForRequest(request, () => {
      const pending = fetchImpl(options.url, {
        ...options.init,
        signal: request.signal,
      });
      void pending.then(
        (lateResponse) => {
          if (request.signal.aborted) {
            cancelResponseBody(lateResponse, request.signal.reason);
          }
        },
        () => undefined,
      );
      return pending;
    });
    if (!response.ok) {
      const error = new OutputBridgeError(
        `${options.component} API returned HTTP ${response.status}`,
        {
          code: "OUTPUT_RESPONSE_INVALID",
          component: options.component,
          status: response.status,
        },
      );
      cancelResponseBody(response, error);
      throw error;
    }
    return response;
  } catch (cause) {
    const error = cause instanceof OutputBridgeError
      ? cause
      : request.signal.aborted
        ? interruptedRequestError(request, cause)
        : new OutputBridgeError(`${options.component} request failed`, {
            code: "OUTPUT_REQUEST_FAILED",
            component: options.component,
            cause,
          });
    publishOutputFailure(options.publisher, error, options.clock, {
      endpoint: safeEndpoint(options.url),
    });
    throw error;
  }
}

function cancelResponseBody(response: Response, reason: unknown): void {
  if (response.body === null) {
    return;
  }
  try {
    void response.body.cancel(reason).catch(() => undefined);
  } catch {
    // Preserve the actionable response error when cancellation itself fails.
  }
}

function cancelResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  try {
    void reader
      .cancel(reason)
      .catch(() => undefined)
      .finally(() => {
        try {
          reader.releaseLock();
        } catch {
          // A pending read owns the lock until cancellation has settled.
        }
      });
  } catch {
    // Preserve the actionable response error when cancellation itself fails.
  }
}


async function readResponseBytes(
  response: Response,
  request: ActiveOutputRequest,
): Promise<Uint8Array> {
  const { options } = request;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    const error = new OutputConfigError(
      options.component,
      `${options.component} maximum response body size must be a positive integer`,
    );
    cancelResponseBody(response, error);
    throw error;
  }

  if (request.signal.aborted) {
    const error = interruptedRequestError(request, request.signal.reason);
    cancelResponseBody(response, error);
    throw error;
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBodyBytes) {
      const error = new OutputBridgeError(`${options.component} API response is too large`, {
        code: "OUTPUT_RESPONSE_INVALID",
        component: options.component,
      });
      cancelResponseBody(response, error);
      throw error;
    }
  }

  if (response.body === null) {
    throw new OutputBridgeError(`${options.component} API returned an empty body`, {
      code: "OUTPUT_RESPONSE_INVALID",
      component: options.component,
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const result = await waitForRequest(request, () => reader.read());
      if (result.done) {
        completed = true;
        break;
      }

      const chunk = result.value;
      if (chunk.byteLength > maxBodyBytes - totalBytes) {
        throw new OutputBridgeError(`${options.component} API response is too large`, {
          code: "OUTPUT_RESPONSE_INVALID",
          component: options.component,
        });
      }
      if (chunk.byteLength > 0) {
        chunks.push(chunk);
        totalBytes += chunk.byteLength;
      }
    }
  } catch (cause) {
    const error = cause instanceof OutputBridgeError
      ? cause
      : request.signal.aborted
        ? interruptedRequestError(request, cause)
        : cause;
    cancelResponseReader(reader, error);
    throw error;
  } finally {
    if (completed) {
      reader.releaseLock();
    }
  }

  if (request.signal.aborted) {
    throw interruptedRequestError(request, request.signal.reason);
  }
  if (totalBytes === 0) {
    throw new OutputBridgeError(`${options.component} API returned an empty body`, {
      code: "OUTPUT_RESPONSE_INVALID",
      component: options.component,
    });
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function withBodyFailureReporting<T>(
  options: OutputRequestOptions,
  readBody: (response: Response, request: ActiveOutputRequest) => Promise<T>,
  unreadableBodyMessage = `${options.component} API returned an unreadable body`,
): Promise<T> {
  const request = startOutputRequest(options);
  try {
    const response = await fetchChecked(request);
    try {
      return await readBody(response, request);
    } catch (cause) {
      const error = cause instanceof OutputBridgeError
        ? cause
        : new OutputBridgeError(unreadableBodyMessage, {
            code: "OUTPUT_RESPONSE_INVALID",
            component: options.component,
            cause,
          });
      publishOutputFailure(options.publisher, error, options.clock, {
        endpoint: safeEndpoint(options.url),
      });
      throw error;
    }
  } finally {
    request.close();
  }
}

export async function requestBytes(options: OutputRequestOptions): Promise<Uint8Array> {
  return withBodyFailureReporting(options, async (response, request) => {
    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (
      contentType !== undefined
      && !contentType.startsWith("audio/")
      && !contentType.startsWith("application/octet-stream")
    ) {
      const error = new OutputBridgeError(
        `${options.component} API returned a non-audio body`,
        {
          code: "OUTPUT_RESPONSE_INVALID",
          component: options.component,
        },
      );
      cancelResponseBody(response, error);
      throw error;
    }
    return readResponseBytes(response, request);
  });
}

export async function requestJson(
  options: OutputRequestOptions,
): Promise<Readonly<Record<string, unknown>>> {
  return withBodyFailureReporting(options, async (response, request) => {
    const bytes = await readResponseBytes(response, request);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (cause) {
      throw new OutputBridgeError(`${options.component} API returned invalid JSON`, {
        code: "OUTPUT_RESPONSE_INVALID",
        component: options.component,
        cause,
      });
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new OutputBridgeError(`${options.component} API returned an invalid JSON object`, {
        code: "OUTPUT_RESPONSE_INVALID",
        component: options.component,
      });
    }
    return value as Readonly<Record<string, unknown>>;
  });
}

export async function requestAcknowledgement(options: OutputRequestOptions): Promise<void> {
  return withBodyFailureReporting(
    options,
    async (response, request) => {
      const bytes = await readResponseBytes(response, request);
      const text = new TextDecoder().decode(bytes).trim();
      if (text.length === 0) {
        throw new OutputBridgeError(
          `${options.component} API returned an empty acknowledgement`,
          {
            code: "OUTPUT_RESPONSE_INVALID",
            component: options.component,
          },
        );
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("json") || text.startsWith("{")) {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch (cause) {
          throw new OutputBridgeError(`${options.component} API returned invalid JSON`, {
            code: "OUTPUT_RESPONSE_INVALID",
            component: options.component,
            cause,
          });
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new OutputBridgeError(
            `${options.component} API returned an invalid acknowledgement`,
            {
              code: "OUTPUT_RESPONSE_INVALID",
              component: options.component,
            },
          );
        }
        const record = body as Readonly<Record<string, unknown>>;
        if (
          record["success"] === false
          || (
            typeof record["code"] === "number"
            && record["code"] !== 0
            && record["code"] !== 200
          )
          || (
            typeof record["status"] === "string"
            && ["error", "failed", "failure"].includes(record["status"].toLowerCase())
          )
        ) {
          throw new OutputBridgeError(`${options.component} API rejected the request`, {
            code: "OUTPUT_RESPONSE_INVALID",
            component: options.component,
          });
        }
      }
    },
    `${options.component} API returned an unreadable acknowledgement`,
  );
}
