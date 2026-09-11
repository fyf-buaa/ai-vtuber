import { lstat, open, realpath } from "node:fs/promises";
import {
  basename,
  delimiter,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { SpeechConfigurationError, throwIfAborted } from "./errors.js";

export const DEFAULT_MAX_REFERENCE_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_REFERENCE_FILE_BYTES = 32 * 1024 * 1024;
export const REFERENCE_AUDIO_ROOTS_ENV = "AI_VTUBER_REFERENCE_AUDIO_ROOTS";

const FILE_READ_CHUNK_BYTES = 64 * 1024;
const RIFF = Buffer.from("RIFF", "ascii");
const RIFX = Buffer.from("RIFX", "ascii");
const RF64 = Buffer.from("RF64", "ascii");
const WAVE = Buffer.from("WAVE", "ascii");
const FLAC = Buffer.from("fLaC", "ascii");
const OGG = Buffer.from("OggS", "ascii");
const ADIF = Buffer.from("ADIF", "ascii");
const FTYP = Buffer.from("ftyp", "ascii");
const ID3 = Buffer.from("ID3", "ascii");

export interface ReferenceFileOptions {
  readonly configuredPath: string;
  readonly cwd: string;
  readonly label: string;
  readonly signal: AbortSignal;
  readonly maximumBytes?: number;
}

export interface LoadedReferenceFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly data: Buffer;
}

function environmentRoots(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  let entries: readonly unknown[];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new SpeechConfigurationError(
        `${REFERENCE_AUDIO_ROOTS_ENV} must be a JSON string array or a ${JSON.stringify(delimiter)}-delimited path list`,
        { cause: error },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new SpeechConfigurationError(
        `${REFERENCE_AUDIO_ROOTS_ENV} must be a JSON string array`,
      );
    }
    entries = parsed;
  } else {
    entries = value.split(delimiter);
  }

  const roots = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new SpeechConfigurationError(
        `${REFERENCE_AUDIO_ROOTS_ENV} entries must be non-empty absolute paths`,
      );
    }
    const root = entry.trim();
    if (root.includes("\0") || !isAbsolute(root)) {
      throw new SpeechConfigurationError(
        `${REFERENCE_AUDIO_ROOTS_ENV} entries must be non-empty absolute paths`,
      );
    }
    roots.add(resolve(root));
  }
  return Object.freeze([...roots]);
}

const ENVIRONMENT_ROOTS = environmentRoots(
  process.env[REFERENCE_AUDIO_ROOTS_ENV],
);

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isContained(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function hasPrefix(data: Uint8Array, expected: Uint8Array, offset = 0): boolean {
  if (data.byteLength - offset < expected.byteLength) {
    return false;
  }
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (data[offset + index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

function audioContentType(extension: string, data: Uint8Array): string | undefined {
  switch (extension) {
    case ".wav":
      return (hasPrefix(data, RIFF) ||
        hasPrefix(data, RIFX) ||
        hasPrefix(data, RF64)) &&
        hasPrefix(data, WAVE, 8)
        ? "audio/wav"
        : undefined;
    case ".mp3":
      return hasPrefix(data, ID3) ||
        (data[0] === 0xff && data[1] !== undefined && (data[1] & 0xe0) === 0xe0)
        ? "audio/mpeg"
        : undefined;
    case ".flac":
      return hasPrefix(data, FLAC) ? "audio/flac" : undefined;
    case ".ogg":
      return hasPrefix(data, OGG) ? "audio/ogg" : undefined;
    case ".aac":
      return hasPrefix(data, ADIF) ||
        (data[0] === 0xff && data[1] !== undefined && (data[1] & 0xf6) === 0xf0)
        ? "audio/aac"
        : undefined;
    case ".m4a":
      return hasPrefix(data, FTYP, 4) ? "audio/mp4" : undefined;
    default:
      return undefined;
  }
}

function checkedContentType(
  path: string,
  data: Uint8Array,
  label: string,
): string {
  const extension = extname(path).toLowerCase();
  const contentType = audioContentType(extension, data);
  if (contentType === undefined) {
    throw new Error(
      `${label} must be a supported audio file with matching WAV, MP3, FLAC, OGG, AAC, or M4A content`,
    );
  }
  return contentType;
}

function checkedSize(size: number, maximumBytes: number, label: string): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${label} has an invalid file size`);
  }
  if (size > maximumBytes) {
    throw new Error(
      `${label} exceeds the ${maximumBytes}-byte reference-file size limit`,
    );
  }
}

async function canonicalRoots(
  cwd: string,
  signal: AbortSignal,
  label: string,
): Promise<readonly string[]> {
  const candidates: Array<{ readonly path: string; readonly required: boolean }> = [
    { path: resolve(cwd, "data"), required: false },
    { path: resolve(cwd, "models"), required: false },
    { path: resolve(cwd, "out"), required: false },
    ...ENVIRONMENT_ROOTS.map((path) => ({ path, required: true })),
  ];
  const roots = new Set<string>();
  for (const candidate of candidates) {
    throwIfAborted(signal, `${label} resolution was cancelled`);
    try {
      const canonical = await realpath(candidate.path);
      throwIfAborted(signal, `${label} resolution was cancelled`);
      const file = await lstat(canonical);
      if (!file.isDirectory()) {
        if (candidate.required) {
          throw new SpeechConfigurationError(
            `${REFERENCE_AUDIO_ROOTS_ENV} entry is not a directory: ${candidate.path}`,
          );
        }
        continue;
      }
      roots.add(canonical);
    } catch (error) {
      throwIfAborted(signal, `${label} resolution was cancelled`);
      if (!candidate.required && isMissingPathError(error)) {
        continue;
      }
      if (error instanceof SpeechConfigurationError) {
        throw error;
      }
      throw new SpeechConfigurationError(
        `${REFERENCE_AUDIO_ROOTS_ENV} entry cannot be canonicalized: ${candidate.path}`,
        { cause: error },
      );
    }
  }
  return [...roots];
}

function sameFile(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function loadReferenceFile(
  options: ReferenceFileOptions,
): Promise<LoadedReferenceFile> {
  const maximumBytes =
    options.maximumBytes ?? DEFAULT_MAX_REFERENCE_AUDIO_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_REFERENCE_FILE_BYTES
  ) {
    throw new SpeechConfigurationError(
      `${options.label} maximum size must be a positive safe integer no greater than ${MAX_REFERENCE_FILE_BYTES} bytes`,
    );
  }
  if (
    options.configuredPath.trim().length === 0 ||
    options.configuredPath.includes("\0")
  ) {
    throw new SpeechConfigurationError(
      `${options.label} must be a non-empty local file path`,
    );
  }

  throwIfAborted(options.signal, `${options.label} read was cancelled`);
  const requestedPath = isAbsolute(options.configuredPath)
    ? resolve(options.configuredPath)
    : resolve(options.cwd, options.configuredPath);

  let requestedFile;
  try {
    requestedFile = await lstat(requestedPath);
  } catch (error) {
    throwIfAborted(options.signal, `${options.label} read was cancelled`);
    throw new Error(`${options.label} does not exist or is unreadable`, {
      cause: error,
    });
  }
  throwIfAborted(options.signal, `${options.label} read was cancelled`);
  if (requestedFile.isSymbolicLink() || !requestedFile.isFile()) {
    throw new Error(`${options.label} is not a safe regular file`);
  }
  checkedSize(requestedFile.size, maximumBytes, options.label);

  const canonicalPath = await realpath(requestedPath);
  throwIfAborted(options.signal, `${options.label} read was cancelled`);
  const canonicalFile = await lstat(canonicalPath);
  if (canonicalFile.isSymbolicLink() || !canonicalFile.isFile()) {
    throw new Error(`${options.label} is not a safe regular file`);
  }
  if (
    canonicalFile.size !== requestedFile.size ||
    !sameFile(requestedFile, canonicalFile)
  ) {
    throw new Error(`${options.label} changed while it was being validated`);
  }
  checkedSize(canonicalFile.size, maximumBytes, options.label);

  const roots = await canonicalRoots(options.cwd, options.signal, options.label);
  if (!roots.some((root) => isContained(root, canonicalPath))) {
    throw new Error(`${options.label} is outside the approved media roots`);
  }

  throwIfAborted(options.signal, `${options.label} read was cancelled`);
  const handle = await open(canonicalPath, "r");
  let data: Buffer;
  try {
    throwIfAborted(options.signal, `${options.label} read was cancelled`);
    const openedFile = await handle.stat();
    if (!openedFile.isFile() || !sameFile(canonicalFile, openedFile)) {
      throw new Error(`${options.label} changed while it was being validated`);
    }
    checkedSize(openedFile.size, maximumBytes, options.label);

    data = Buffer.allocUnsafe(openedFile.size);
    let offset = 0;
    while (offset < data.byteLength) {
      throwIfAborted(options.signal, `${options.label} read was cancelled`);
      const length = Math.min(FILE_READ_CHUNK_BYTES, data.byteLength - offset);
      const result = await handle.read(data, offset, length, offset);
      if (result.bytesRead === 0) {
        throw new Error(`${options.label} changed while it was being read`);
      }
      offset += result.bytesRead;
    }

    throwIfAborted(options.signal, `${options.label} read was cancelled`);
    const probe = Buffer.allocUnsafe(1);
    const trailing = await handle.read(probe, 0, 1, data.byteLength);
    if (trailing.bytesRead !== 0) {
      throw new Error(`${options.label} changed while it was being read`);
    }
    const finalFile = await handle.stat();
    if (finalFile.size !== openedFile.size || !sameFile(openedFile, finalFile)) {
      throw new Error(`${options.label} changed while it was being read`);
    }
  } finally {
    await handle.close();
  }

  throwIfAborted(options.signal, `${options.label} read was cancelled`);
  const contentType = checkedContentType(
    canonicalPath,
    data,
    options.label,
  );
  return {
    path: canonicalPath,
    name: basename(canonicalPath),
    size: data.byteLength,
    contentType,
    data,
  };
}
