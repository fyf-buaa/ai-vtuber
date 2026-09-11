import { abortReason } from "../errors.js";
import {
  cancelResponseBody,
  finishResponseReader,
  readBoundedErrorBody,
  readResponseChunk,
  requireHttpUrl,
} from "../http.js";
import type { SpeechFetch } from "../types.js";

export { DEFAULT_MAX_AUDIO_BYTES } from "../http.js";
export const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

function contentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function assertSuccessfulResponse(
  response: Response,
  label: string,
  signal: AbortSignal,
): Promise<void> {
  if (response.ok) {
    return;
  }
  const detail = await readBoundedErrorBody(response, signal, label);
  const suffix = detail.length === 0 ? "" : `: ${detail}`;
  throw new Error(
    `${label} request failed with HTTP ${response.status} ${response.statusText}${suffix}`,
  );
}

export async function readBoundedResponse(
  response: Response,
  label: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    const error = new RangeError(
      `${label} maximum response size must be a positive safe integer`,
    );
    cancelResponseBody(response, error);
    throw error;
  }
  await assertSuccessfulResponse(response, label, signal);
  const declaredLength = contentLength(response);
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    const error = new Error(
      `${label} response exceeds the ${maximumBytes}-byte size limit`,
    );
    cancelResponseBody(response, error);
    throw error;
  }
  if (response.body === null) {
    throw new Error(`${label} response did not include a body`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
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
        break;
      }
      if (chunk.value.byteLength > maximumBytes - total) {
        throw new Error(
          `${label} response exceeds the ${maximumBytes}-byte size limit`,
        );
      }
      if (chunk.value.byteLength > 0) {
        total += chunk.value.byteLength;
        chunks.push(chunk.value);
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    finishResponseReader(reader, !completed, failure);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function fetchJson(
  fetchImpl: SpeechFetch,
  label: string,
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  maximumBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, signal });
  const body = await readBoundedResponse(response, label, maximumBytes, signal);
  if (body.byteLength === 0) {
    throw new Error(`${label} returned an empty JSON response`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

export function remoteHttpUrl(
  value: unknown,
  baseUrl: URL,
  label: string,
  sameOrigin: boolean,
): URL {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} did not return a non-empty audio URL`);
  }
  const candidate = value.trim();
  if (/^[a-zA-Z]:[\\/]/u.test(candidate) || candidate.includes("\\")) {
    throw new Error(`${label} returned an unsafe filesystem path`);
  }

  let url: URL;
  try {
    url = new URL(candidate, baseUrl);
  } catch (error) {
    throw new Error(`${label} returned an invalid audio URL`, { cause: error });
  }
  const checked = requireHttpUrl(url.href, `${label} audio URL`);
  if (checked.username.length > 0 || checked.password.length > 0) {
    throw new Error(`${label} returned an audio URL containing credentials`);
  }
  if (sameOrigin && checked.origin !== baseUrl.origin) {
    throw new Error(`${label} returned a cross-origin audio URL`);
  }
  return checked;
}

export function safeAudioExtension(value: string | undefined, fallback = "wav"): string {
  if (value === undefined) {
    return fallback;
  }
  const cleanPath = value.split(/[?#]/u, 1)[0] ?? "";
  const match = /\.([a-zA-Z0-9]{2,8})$/u.exec(cleanPath);
  return match?.[1]?.toLowerCase() ?? fallback;
}
