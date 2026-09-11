import { SpeechConfigurationError, abortReason } from "./errors.js";
import type { SpeechFetch, SynthesizedAudio } from "./types.js";

const ERROR_BODY_BYTES = 512;
export const DEFAULT_MAX_AUDIO_BYTES = 32 * 1024 * 1024;

export function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  fallback: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal, fallback));
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal, fallback));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let pending: Promise<ReadableStreamReadResult<Uint8Array>>;
    try {
      pending = reader.read();
    } catch (error) {
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
      return;
    }
    void pending.then(
      (result) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function finishResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cancel: boolean,
  reason?: unknown,
): void {
  const release = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // Preserve the status, timeout, or size error.
    }
  };
  if (!cancel) {
    release();
    return;
  }

  let cancellation: Promise<void>;
  try {
    cancellation = reader.cancel(reason);
  } catch {
    release();
    return;
  }
  release();
  void cancellation.catch(() => {
    // Preserve the status, timeout, or size error.
  });
}

export function cancelResponseBody(response: Response, reason: unknown): void {
  if (response.body === null) {
    return;
  }
  try {
    void response.body.cancel(reason).catch(() => undefined);
  } catch {
    // Preserve the cancellation or size error.
  }
}

export function requireHttpUrl(value: unknown, key: string): URL {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SpeechConfigurationError(`${key} must be a non-empty HTTP URL`);
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new SpeechConfigurationError(`${key} is not a valid URL: ${value}`, {
      cause: error,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SpeechConfigurationError(
      `${key} must use http: or https:, received ${url.protocol}`,
    );
  }
  return url;
}

export function appendUrlPath(base: URL, suffix: string): URL {
  const url = new URL(base.href);
  const basePath = url.pathname.replace(/\/+$/u, "");
  const suffixPath = suffix.replace(/^\/+|\/+$/gu, "");
  url.pathname = `${basePath}/${suffixPath}`;
  return url;
}

function normalizeContentType(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === undefined || mediaType.length === 0 ? undefined : mediaType;
}

export function extensionForAudioContentType(
  contentType: string | undefined,
  fallback: string,
): string {
  switch (contentType) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    case "audio/aac":
      return "aac";
    case "audio/mp4":
      return "m4a";
    default:
      return fallback;
  }
}

export async function readBoundedErrorBody(
  response: Response,
  signal: AbortSignal,
  label: string,
): Promise<string> {
  const cancellationMessage = `${label} error response body was cancelled`;
  if (response.body === null) {
    if (signal.aborted) {
      throw abortReason(signal, cancellationMessage);
    }
    return "";
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    if (signal.aborted) {
      throw abortReason(signal, cancellationMessage);
    }
    return "";
  }

  const decoder = new TextDecoder();
  let bytes = 0;
  let completed = false;
  let snippet = "";
  try {
    if (signal.aborted) {
      throw abortReason(signal, cancellationMessage);
    }
    while (bytes < ERROR_BODY_BYTES) {
      const chunk = await readResponseChunk(
        reader,
        signal,
        cancellationMessage,
      );
      if (chunk.done) {
        completed = true;
        break;
      }
      if (chunk.value.byteLength === 0) {
        continue;
      }
      const remaining = ERROR_BODY_BYTES - bytes;
      const selected =
        chunk.value.byteLength <= remaining
          ? chunk.value
          : chunk.value.subarray(0, remaining);
      bytes += selected.byteLength;
      snippet += decoder.decode(selected, { stream: true });
    }
    if (signal.aborted) {
      throw abortReason(signal, cancellationMessage);
    }
  } catch {
    if (signal.aborted) {
      throw abortReason(signal, cancellationMessage);
    }
    // The status is still actionable if a broken response body cannot be read.
  } finally {
    finishResponseReader(reader, !completed);
  }
  snippet += decoder.decode();
  return snippet.replace(/\s+/gu, " ").trim();
}

async function responseError(
  response: Response,
  label: string,
  signal: AbortSignal,
): Promise<Error> {
  const detail = await readBoundedErrorBody(response, signal, label);
  const suffix = detail.length === 0 ? "" : `: ${detail}`;
  return new Error(
    `${label} request failed with HTTP ${response.status} ${response.statusText}${suffix}`,
  );
}

async function* responseBody(
  response: Response,
  label: string,
  signal: AbortSignal,
  maximumBytes: number,
): AsyncGenerator<Uint8Array> {
  const body = response.body;
  if (body === null) {
    throw new Error(`${label} response did not include an audio body`);
  }

  const reader = body.getReader();
  let completed = false;
  let totalBytes = 0;
  let failure: unknown;
  try {
    while (true) {
      const chunk = await readResponseChunk(
        reader,
        signal,
        `${label} request was cancelled`,
      );
      if (signal.aborted) {
        throw abortReason(signal, `${label} request was cancelled`);
      }
      if (chunk.done) {
        completed = true;
        return;
      }
      if (chunk.value.byteLength > maximumBytes - totalBytes) {
        throw new Error(
          `${label} audio exceeds the ${maximumBytes}-byte download limit`,
        );
      }
      if (chunk.value.byteLength > 0) {
        totalBytes += chunk.value.byteLength;
        yield chunk.value;
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    finishResponseReader(reader, !completed, failure);
  }
}

export async function fetchAudio(
  fetchImpl: SpeechFetch,
  label: string,
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  fallbackExtension: string,
  maximumBytes = DEFAULT_MAX_AUDIO_BYTES,
): Promise<SynthesizedAudio> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new SpeechConfigurationError(
      `${label} maximum download size must be a positive safe integer`,
    );
  }
  const response = await fetchImpl(url, { ...init, signal });
  if (signal.aborted) {
    const error = abortReason(signal, `${label} request was cancelled`);
    cancelResponseBody(response, error);
    throw error;
  }
  if (!response.ok) {
    throw await responseError(response, label, signal);
  }
  const declaredLengthValue = response.headers.get("content-length");
  if (declaredLengthValue !== null) {
    const declaredLength = Number(declaredLengthValue);
    if (
      Number.isSafeInteger(declaredLength) &&
      declaredLength > maximumBytes
    ) {
      const error = new Error(
        `${label} audio exceeds the ${maximumBytes}-byte download limit`,
      );
      cancelResponseBody(response, error);
      throw error;
    }
  }

  const contentType = normalizeContentType(response.headers.get("content-type"));
  if (
    contentType !== undefined &&
    (contentType.includes("json") ||
      contentType.startsWith("text/") ||
      contentType.includes("html"))
  ) {
    throw await responseError(
      response,
      `${label} returned ${contentType} instead of audio`,
      signal,
    );
  }

  return {
    extension: extensionForAudioContentType(contentType, fallbackExtension),
    ...(contentType === undefined ? {} : { contentType }),
    stream: responseBody(response, label, signal, maximumBytes),
  };
}
