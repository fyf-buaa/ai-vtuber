import { setTimeout as sleepTimer } from "node:timers/promises";

import type {
  AbortableSleep,
  ConfigSnapshotProvider,
  PlatformConfig,
  PlatformConfigInput,
  ReconnectOptions,
} from "./types.js";

export class PlatformConfigurationError extends Error {
  constructor(platform: string, message: string) {
    super(`Platform "${platform}" is not configured: ${message}`);
    this.name = "PlatformConfigurationError";
  }
}

export class PlatformConnectionError extends Error {
  constructor(platform: string, message: string, options?: ErrorOptions) {
    super(`Platform "${platform}" connection failed: ${message}`, options);
    this.name = "PlatformConnectionError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function snapshotConfig(input: PlatformConfigInput): PlatformConfig {
  const value = isSnapshotProvider(input) ? input.snapshot() : input;
  if (!isRecord(value)) {
    throw new TypeError("Platform configuration must be a JSON object");
  }
  return value;
}

function isSnapshotProvider(value: unknown): value is ConfigSnapshotProvider {
  return isRecord(value) && typeof value["snapshot"] === "function";
}

export function recordAt(
  record: Readonly<Record<string, unknown>>,
  ...path: readonly string[]
): Readonly<Record<string, unknown>> | undefined {
  const value = valueAt(record, ...path);
  return isRecord(value) ? value : undefined;
}

export function valueAt(
  record: Readonly<Record<string, unknown>>,
  ...path: readonly string[]
): unknown {
  let value: unknown = record;
  for (const segment of path) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[segment];
  }
  return value;
}

export function stringAt(
  record: Readonly<Record<string, unknown>>,
  ...path: readonly string[]
): string | undefined {
  const value = valueAt(record, ...path);
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function numberAt(
  record: Readonly<Record<string, unknown>>,
  ...path: readonly string[]
): number | undefined {
  const value = valueAt(record, ...path);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function stringArrayAt(
  record: Readonly<Record<string, unknown>>,
  ...path: readonly string[]
): readonly string[] | undefined {
  const value = valueAt(record, ...path);
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

export function firstString(
  record: Readonly<Record<string, unknown>>,
  paths: readonly (readonly string[])[],
): string | undefined {
  for (const path of paths) {
    const value = stringAt(record, ...path);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function positiveInteger(
  value: unknown,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.min(maximum, Math.max(1, Math.trunc(numeric)));
}

export function isPlaceholderSecret(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "xxxx" ||
    normalized === "oauth:xxxx" ||
    normalized.includes("your_api_key") ||
    normalized.includes("replace_me")
  );
}

export function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}

export function abortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException(
    typeof reason === "string" ? reason : "The operation was aborted",
    "AbortError",
  );
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (error instanceof Error && error.name === "AbortError");
}

export const defaultSleep: AbortableSleep = async (milliseconds, signal) => {
  await sleepTimer(milliseconds, undefined, { signal });
};

export function linkAbortSignal(
  external: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (external === undefined) {
    return () => undefined;
  }
  if (external.aborted) {
    controller.abort(external.reason);
    return () => undefined;
  }
  const abort = (): void => controller.abort(external.reason);
  external.addEventListener("abort", abort, { once: true });
  return () => external.removeEventListener("abort", abort);
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly settled: () => boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  let isSettled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (!isSettled) {
        isSettled = true;
        resolvePromise(value);
      }
    },
    reject: (reason) => {
      if (!isSettled) {
        isSettled = true;
        rejectPromise(reason);
      }
    },
    settled: () => isSettled,
  };
}

export const DEFAULT_RECONNECT_OPTIONS: ReconnectOptions = Object.freeze({
  initialDelayMs: 250,
  maximumDelayMs: 5_000,
  maximumAttempts: 8,
  connectionTimeoutMs: 10_000,
  acknowledgementTimeoutMs: 10_000,
  stableConnectionMs: 30_000,
});

export function reconnectOptions(
  config: Readonly<Record<string, unknown>> | undefined,
): ReconnectOptions {
  const source = config ?? {};
  const initialDelayMs = positiveInteger(
    source["initial_delay_ms"],
    DEFAULT_RECONNECT_OPTIONS.initialDelayMs,
    60_000,
  );
  const maximumDelayMs = Math.max(
    initialDelayMs,
    positiveInteger(
      source["maximum_delay_ms"],
      DEFAULT_RECONNECT_OPTIONS.maximumDelayMs,
      300_000,
    ),
  );
  return {
    initialDelayMs,
    maximumDelayMs,
    maximumAttempts: positiveInteger(
      source["maximum_attempts"],
      DEFAULT_RECONNECT_OPTIONS.maximumAttempts,
      100,
    ),
    connectionTimeoutMs: positiveInteger(
      source["connection_timeout_ms"],
      DEFAULT_RECONNECT_OPTIONS.connectionTimeoutMs,
      300_000,
    ),
    acknowledgementTimeoutMs: positiveInteger(
      source["acknowledgement_timeout_ms"],
      DEFAULT_RECONNECT_OPTIONS.acknowledgementTimeoutMs,
      300_000,
    ),
    stableConnectionMs: positiveInteger(
      source["stable_connection_ms"],
      DEFAULT_RECONNECT_OPTIONS.stableConnectionMs,
      3_600_000,
    ),
  };
}

export function backoffDelay(
  attempt: number,
  options: ReconnectOptions,
  random: () => number,
): number {
  const exponential = Math.min(
    options.maximumDelayMs,
    options.initialDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.round(exponential * jitter);
}

export function parseWebSocketListenUrl(
  platform: string,
  rawUrl: string,
): { readonly host: string; readonly port: number; readonly path?: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new PlatformConfigurationError(
      platform,
      `invalid WebSocket listen URL ${JSON.stringify(rawUrl)}`,
    );
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new PlatformConfigurationError(platform, "WebSocket URL must use ws:// or wss://");
  }
  if (url.protocol === "wss:") {
    throw new PlatformConfigurationError(
      platform,
      "local wss:// listeners require TLS termination outside the application; configure ws:// here",
    );
  }
  const port = url.port.length > 0 ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new PlatformConfigurationError(platform, "WebSocket listen port is invalid");
  }
  const result: { host: string; port: number; path?: string } = {
    host: url.hostname,
    port,
  };
  if (url.pathname !== "/") {
    result.path = url.pathname;
  }
  return result;
}

const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;

const JSON_RESPONSE_LIMIT_MESSAGE =
  `JSON response exceeds ${MAX_JSON_RESPONSE_BYTES} bytes`;

function cancelResponseBody(
  body: ReadableStream<Uint8Array> | null,
  reason: unknown,
): void {
  if (body === null) {
    return;
  }
  try {
    void body.cancel(reason).catch(() => undefined);
  } catch {
    // Preserve the actionable size or cancellation error.
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
          // A still-pending read owns the lock until cancellation settles.
        }
      });
  } catch {
    // Preserve the actionable size or cancellation error.
  }
}

function isAbortedSignal(
  signal: AbortSignal | undefined,
): signal is AbortSignal & { readonly aborted: true } {
  return signal?.aborted === true;
}

function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) {
    return reader.read();
  }
  if (signal.aborted) {
    return Promise.reject(abortError(signal.reason));
  }
  const { promise, resolve, reject } =
    Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>();
  const aborted = (): void => {
    signal.removeEventListener("abort", aborted);
    reject(abortError(signal.reason));
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) {
    aborted();
    return promise;
  }
  void reader.read().then(
    (result) => {
      signal.removeEventListener("abort", aborted);
      resolve(result);
    },
    (error: unknown) => {
      signal.removeEventListener("abort", aborted);
      reject(error);
    },
  );
  return promise;
}

export async function readJsonResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted === true) {
    const error = abortError(signal.reason);
    cancelResponseBody(response.body, error);
    throw error;
  }

  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declaredLength = Number(declaredHeader);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
      const error = new Error(JSON_RESPONSE_LIMIT_MESSAGE);
      cancelResponseBody(response.body, error);
      throw error;
    }
  }

  if (response.body === null) {
    return undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const result = await readResponseChunk(reader, signal);
      if (result.done) {
        completed = true;
        break;
      }
      const chunk = result.value;
      if (chunk.byteLength > MAX_JSON_RESPONSE_BYTES - total) {
        throw new Error(JSON_RESPONSE_LIMIT_MESSAGE);
      }
      if (chunk.byteLength > 0) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    }
  } catch (error) {
    const reason = isAbortedSignal(signal) ? abortError(signal.reason) : error;
    cancelResponseReader(reader, reason);
    throw reason;
  } finally {
    if (completed) {
      reader.releaseLock();
    }
  }

  if (isAbortedSignal(signal)) {
    throw abortError(signal.reason);
  }
  if (total === 0) {
    return undefined;
  }

  let bytes: Uint8Array;
  if (chunks.length === 1) {
    bytes = chunks[0]!;
  } else {
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Expected a JSON response, received: ${text.slice(0, 200)}`, {
      cause: error,
    });
  }
}
