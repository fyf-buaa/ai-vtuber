import { constants } from "node:fs";
import type { BigIntStats, Dir, Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";

export type LocalAudioExtension =
  | ".wav"
  | ".mp3"
  | ".ogg"
  | ".opus"
  | ".flac"
  | ".m4a"
  | ".aac";

export interface LocalAudioFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface LocalAudioDescriptor {
  /** Canonical absolute path, validated while the corresponding file was open. */
  readonly path: string;
  /** Filename as it appears on disk, including its extension. */
  readonly filename: string;
  /** Filename as it appears on disk, without its final extension. */
  readonly stem: string;
  /** Lower-case playback extension, including its leading dot. */
  readonly extension: LocalAudioExtension;
  readonly size: number;
  /** Handle-derived identity for detecting replacements before playback. */
  readonly identity: LocalAudioFileIdentity;
}

export interface LocalAudioLimits {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  /** Maximum number of filesystem entries inspected by one directory scan. */
  readonly maxEntries: number;
  /** Root files have depth zero; this limits nested directory traversal. */
  readonly maxDepth: number;
}

export type LocalAudioErrorCode =
  | "INVALID_ARGUMENT"
  | "OUTSIDE_PROJECT"
  | "SYMLINK"
  | "NOT_FOUND"
  | "NOT_DIRECTORY"
  | "NOT_REGULAR_FILE"
  | "UNSUPPORTED_FORMAT"
  | "INVALID_AUDIO"
  | "LIMIT_EXCEEDED"
  | "FILESYSTEM";

export class LocalAudioError extends Error {
  readonly code: LocalAudioErrorCode;
  readonly path: string | undefined;

  constructor(
    code: LocalAudioErrorCode,
    message: string,
    options: { readonly path?: string; readonly cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "LocalAudioError";
    this.code = code;
    this.path = options.path;
  }
}

export type LocalAudioRandom = () => number;

export type LocalAudioSelectionMode = "deterministic" | "rotating" | "random";
export type LocalAudioSelectionSeed = string | number;

export type LocalAudioSelectionOptions =
  | {
      readonly mode: "deterministic";
      readonly seed: LocalAudioSelectionSeed;
      readonly signal?: AbortSignal;
    }
  | {
      readonly mode: "rotating";
      readonly signal?: AbortSignal;
    }
  | {
      readonly mode: "random";
      readonly signal?: AbortSignal;
    };

const DEFAULT_LIMITS: LocalAudioLimits = Object.freeze({
  maxFileBytes: 128 * 1024 * 1024,
  maxFiles: 10_000,
  maxEntries: 50_000,
  maxDepth: 16,
});
const HEADER_BYTES = 64;
const SUPPORTED_EXTENSIONS = new Set<string>([
  ".wav",
  ".mp3",
  ".ogg",
  ".opus",
  ".flac",
  ".m4a",
  ".aac",
]);
const RIFF_SIGNATURE = Buffer.from("RIFF", "ascii");
const WAVE_SIGNATURE = Buffer.from("WAVE", "ascii");
const MP3_ID3_SIGNATURE = Buffer.from("ID3", "ascii");
const OGG_SIGNATURE = Buffer.from("OggS", "ascii");
const VORBIS_SIGNATURE = Buffer.concat([
  Buffer.from([1]),
  Buffer.from("vorbis", "ascii"),
]);
const OPUS_SIGNATURE = Buffer.from("OpusHead", "ascii");
const FLAC_SIGNATURE = Buffer.from("fLaC", "ascii");
const MP4_FILE_TYPE_SIGNATURE = Buffer.from("ftyp", "ascii");
const AAC_ADIF_SIGNATURE = Buffer.from("ADIF", "ascii");

interface RotationState {
  readonly signature: string;
  nextIndex: number;
}

interface PendingDirectory {
  readonly path: string;
  readonly depth: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function pathKey(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(pathKey(root), pathKey(target));
  return fromRoot === "" || (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function compareDescriptors(
  left: LocalAudioDescriptor,
  right: LocalAudioDescriptor,
): number {
  const leftKey = pathKey(left.path);
  const rightKey = pathKey(right.path);
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function filesystemError(path: string, action: string, cause: unknown): LocalAudioError {
  const systemCode = nodeErrorCode(cause);
  if (systemCode === "ENOENT") {
    return new LocalAudioError("NOT_FOUND", `${action}: ${path}`, { path, cause });
  }
  if (systemCode === "ENOTDIR") {
    return new LocalAudioError("NOT_DIRECTORY", `${action}: ${path}`, { path, cause });
  }
  if (systemCode === "ELOOP") {
    return new LocalAudioError("SYMLINK", `${action}: ${path}`, { path, cause });
  }
  return new LocalAudioError("FILESYSTEM", `${action}: ${path}`, { path, cause });
}

async function filesystemOperation<T>(
  path: string,
  action: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  try {
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof LocalAudioError) {
      throw error;
    }
    throw filesystemError(path, action, error);
  }
}

async function openDirectoryForScan(
  path: string,
  signal: AbortSignal | undefined,
): Promise<Dir> {
  throwIfAborted(signal);
  let directory: Dir;
  try {
    directory = await opendir(path);
  } catch (error) {
    throwIfAborted(signal);
    throw filesystemError(path, "Unable to open local-audio directory", error);
  }
  if (signal?.aborted === true) {
    try {
      await directory.close();
    } catch {
      // The caller's abort reason takes precedence over a close failure.
    }
    throwIfAborted(signal);
  }
  return directory;
}

function configuredTarget(base: string, configuredPath: string): string {
  if (
    typeof configuredPath !== "string" ||
    configuredPath.trim().length === 0 ||
    configuredPath.includes("\0")
  ) {
    throw new LocalAudioError(
      "INVALID_ARGUMENT",
      "A configured audio path must be a non-empty path string",
      { path: configuredPath },
    );
  }
  const target = resolvePath(base, configuredPath);
  if (!isContained(base, target)) {
    throw new LocalAudioError(
      "OUTSIDE_PROJECT",
      `Configured audio path is outside the project directory: ${configuredPath}`,
      { path: configuredPath },
    );
  }
  return target;
}

function supportedExtension(path: string): LocalAudioExtension | undefined {
  const extension = extname(path).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(extension)
    ? extension as LocalAudioExtension
    : undefined;
}

function hasBytesAt(buffer: Buffer, offset: number, expected: Buffer): boolean {
  return buffer.length >= offset + expected.length &&
    buffer.subarray(offset, offset + expected.length).equals(expected);
}

function hasValidId3Header(header: Buffer): boolean {
  if (
    header.length < 10 ||
    !hasBytesAt(header, 0, MP3_ID3_SIGNATURE)
  ) {
    return false;
  }
  const majorVersion = header[3];
  const revision = header[4];
  if (
    majorVersion === undefined ||
    majorVersion < 2 ||
    majorVersion > 4 ||
    revision === 0xff
  ) {
    return false;
  }
  for (let index = 6; index < 10; index += 1) {
    const sizeByte = header[index];
    if (sizeByte === undefined || (sizeByte & 0x80) !== 0) {
      return false;
    }
  }
  return true;
}

function hasValidMpegFrameHeader(header: Buffer): boolean {
  if (header.length < 4 || header[0] !== 0xff) {
    return false;
  }
  const second = header[1];
  const third = header[2];
  if (second === undefined || third === undefined) {
    return false;
  }
  const version = (second >>> 3) & 0b11;
  const layer = (second >>> 1) & 0b11;
  const bitrate = (third >>> 4) & 0b1111;
  const sampleRate = (third >>> 2) & 0b11;
  return (second & 0b1110_0000) === 0b1110_0000 &&
    version !== 0b01 &&
    layer !== 0b00 &&
    bitrate !== 0 &&
    bitrate !== 0b1111 &&
    sampleRate !== 0b11;
}

function hasValidAdtsHeader(header: Buffer): boolean {
  if (header.length < 7 || header[0] !== 0xff) {
    return false;
  }
  const second = header[1];
  const third = header[2];
  const fourth = header[3];
  const fifth = header[4];
  const sixth = header[5];
  if (
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    fifth === undefined ||
    sixth === undefined
  ) {
    return false;
  }
  const layer = (second >>> 1) & 0b11;
  const sampleRate = (third >>> 2) & 0b1111;
  const frameLength = ((fourth & 0b11) << 11) |
    (fifth << 3) |
    (sixth >>> 5);
  return (second & 0b1111_0110) === 0b1111_0000 &&
    layer === 0 &&
    sampleRate !== 0b1111 &&
    frameLength >= 7;
}

function hasValidSignature(extension: LocalAudioExtension, header: Buffer): boolean {
  switch (extension) {
    case ".wav":
      return header.length >= 12 &&
        hasBytesAt(header, 0, RIFF_SIGNATURE) &&
        header.readUInt32LE(4) >= 4 &&
        hasBytesAt(header, 8, WAVE_SIGNATURE);
    case ".mp3":
      return hasValidId3Header(header) || hasValidMpegFrameHeader(header);
    case ".ogg":
      return header.length >= 27 &&
        hasBytesAt(header, 0, OGG_SIGNATURE) &&
        header[4] === 0 &&
        (
          header.indexOf(VORBIS_SIGNATURE) >= 0 ||
          header.indexOf(OPUS_SIGNATURE) >= 0
        );
    case ".opus":
      return header.length >= 36 &&
        hasBytesAt(header, 0, OGG_SIGNATURE) &&
        header[4] === 0 &&
        header.indexOf(OPUS_SIGNATURE) >= 0;
    case ".flac":
      return header.length >= 42 &&
        hasBytesAt(header, 0, FLAC_SIGNATURE) &&
        (header[4]! & 0x7f) === 0 &&
        header.readUIntBE(5, 3) === 34;
    case ".m4a":
      return header.length >= 16 &&
        header.readUInt32BE(0) >= 16 &&
        hasBytesAt(header, 4, MP4_FILE_TYPE_SIGNATURE);
    case ".aac":
      return hasBytesAt(header, 0, AAC_ADIF_SIGNATURE) ||
        hasValidAdtsHeader(header);
  }
}

async function readBoundedHeader(
  handle: FileHandle,
  length: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const header = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(
      header,
      offset,
      length - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  throwIfAborted(signal);
  return header.subarray(0, offset);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  name: keyof LocalAudioLimits,
  allowZero = false,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    (allowZero ? selected < 0 : selected <= 0)
  ) {
    throw new LocalAudioError(
      "INVALID_ARGUMENT",
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
    );
  }
  return selected;
}

function stableHash(value: string): number {
  let hash = 0x811c_9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

function seedText(seed: LocalAudioSelectionSeed): string {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) {
      throw new LocalAudioError(
        "INVALID_ARGUMENT",
        "A numeric local-audio selection seed must be finite",
      );
    }
    return `number:${Object.is(seed, -0) ? "-0" : String(seed)}`;
  }
  if (typeof seed !== "string") {
    throw new LocalAudioError(
      "INVALID_ARGUMENT",
      "A local-audio selection seed must be a string or finite number",
    );
  }
  return `string:${seed}`;
}

function configuredChoices(
  entries: readonly string[],
  maximumChoices: number,
): readonly string[] {
  if (!Array.isArray(entries)) {
    throw new LocalAudioError(
      "INVALID_ARGUMENT",
      "Configured local-audio entries must be an array",
    );
  }
  const choices: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new LocalAudioError(
        "INVALID_ARGUMENT",
        "Configured local-audio entries must be non-empty strings",
      );
    }
    const isLegacyAlternatives = entry.startsWith("[") &&
      entry.endsWith("]") &&
      entry.slice(1, -1).includes("|");
    const alternatives = isLegacyAlternatives
      ? entry.slice(1, -1).split("|").map((value) => value.trim())
      : [entry];
    if (alternatives.some((value) => value.length === 0)) {
      throw new LocalAudioError(
        "INVALID_ARGUMENT",
        `Local-audio bracket alternatives may not be empty: ${entry}`,
      );
    }
    choices.push(...alternatives);
    if (choices.length > maximumChoices) {
      throw new LocalAudioError(
        "LIMIT_EXCEEDED",
        `Configured local-audio entries contain more than ${maximumChoices} choices`,
      );
    }
  }
  return choices;
}

/**
 * Secure local-audio discovery and selection rooted at one project directory.
 * The class validates files for later playback; it never loads an entire file
 * and never invokes a player.
 */
export class LocalAudioLibrary {
  readonly #projectBase: string;
  readonly #limits: LocalAudioLimits;
  readonly #random: LocalAudioRandom;
  #rotationState: RotationState | undefined;

  constructor(
    projectBaseDirectory: string,
    limits: Partial<LocalAudioLimits> = {},
    random: LocalAudioRandom = Math.random,
  ) {
    if (
      typeof projectBaseDirectory !== "string" ||
      projectBaseDirectory.trim().length === 0 ||
      projectBaseDirectory.includes("\0")
    ) {
      throw new LocalAudioError(
        "INVALID_ARGUMENT",
        "The project base directory must be a non-empty path string",
        { path: projectBaseDirectory },
      );
    }
    if (typeof random !== "function") {
      throw new LocalAudioError(
        "INVALID_ARGUMENT",
        "The local-audio random source must be a function",
      );
    }
    this.#projectBase = resolvePath(projectBaseDirectory);
    this.#limits = Object.freeze({
      maxFileBytes: positiveLimit(
        limits.maxFileBytes,
        DEFAULT_LIMITS.maxFileBytes,
        "maxFileBytes",
      ),
      maxFiles: positiveLimit(
        limits.maxFiles,
        DEFAULT_LIMITS.maxFiles,
        "maxFiles",
      ),
      maxEntries: positiveLimit(
        limits.maxEntries,
        DEFAULT_LIMITS.maxEntries,
        "maxEntries",
      ),
      maxDepth: positiveLimit(
        limits.maxDepth,
        DEFAULT_LIMITS.maxDepth,
        "maxDepth",
        true,
      ),
    });
    this.#random = random;
  }

  /** Resolve and validate one explicitly configured audio path. */
  async resolve(
    configuredPath: string,
    signal?: AbortSignal,
  ): Promise<LocalAudioDescriptor> {
    const base = await this.#canonicalBase(signal);
    const target = configuredTarget(base, configuredPath);
    return await this.#validateFile(target, base, signal);
  }

  /** Recursively list validated audio beneath one configured directory. */
  async list(
    configuredDirectory: string,
    signal?: AbortSignal,
  ): Promise<readonly LocalAudioDescriptor[]> {
    const base = await this.#canonicalBase(signal);
    const target = configuredTarget(base, configuredDirectory);
    const targetStats = await this.#inspectPathWithoutSymlinks(base, target, signal);
    if (!targetStats.isDirectory()) {
      throw new LocalAudioError(
        "NOT_DIRECTORY",
        `Configured local-audio root is not a directory: ${configuredDirectory}`,
        { path: target },
      );
    }
    const root = await filesystemOperation(
      target,
      "Unable to canonicalize local-audio directory",
      signal,
      async () => await realpath(target),
    );
    if (!isContained(base, root) || !samePath(target, root)) {
      throw new LocalAudioError(
        "SYMLINK",
        `Configured local-audio directory resolves through a link: ${configuredDirectory}`,
        { path: target },
      );
    }

    const pending: PendingDirectory[] = [{ path: root, depth: 0 }];
    const audio: LocalAudioDescriptor[] = [];
    let inspectedEntries = 0;

    while (pending.length > 0) {
      throwIfAborted(signal);
      const current = pending.pop();
      if (current === undefined) {
        break;
      }
      await this.#recheckDirectory(current.path, root, signal);
      try {
        const directory = await openDirectoryForScan(current.path, signal);
        for await (const entry of directory) {
          throwIfAborted(signal);
          inspectedEntries += 1;
          if (inspectedEntries > this.#limits.maxEntries) {
            throw new LocalAudioError(
              "LIMIT_EXCEEDED",
              `Local-audio scan exceeds ${this.#limits.maxEntries} filesystem entries`,
              { path: root },
            );
          }

          const entryPath = join(current.path, entry.name);
          const entryStats = await filesystemOperation(
            entryPath,
            "Unable to inspect local-audio directory entry",
            signal,
            async () => await lstat(entryPath),
          );
          if (entryStats.isSymbolicLink()) {
            throw new LocalAudioError(
              "SYMLINK",
              `Local-audio scans do not follow symbolic links: ${entryPath}`,
              { path: entryPath },
            );
          }
          if (entryStats.isDirectory()) {
            if (current.depth >= this.#limits.maxDepth) {
              throw new LocalAudioError(
                "LIMIT_EXCEEDED",
                `Local-audio scan exceeds maximum depth ${this.#limits.maxDepth}`,
                { path: entryPath },
              );
            }
            const child = await filesystemOperation(
              entryPath,
              "Unable to canonicalize nested local-audio directory",
              signal,
              async () => await realpath(entryPath),
            );
            if (!isContained(root, child) || !samePath(entryPath, child)) {
              throw new LocalAudioError(
                "SYMLINK",
                `Nested local-audio directory resolves through a link: ${entryPath}`,
                { path: entryPath },
              );
            }
            pending.push({ path: child, depth: current.depth + 1 });
            continue;
          }
          if (!entryStats.isFile()) {
            throw new LocalAudioError(
              "NOT_REGULAR_FILE",
              `Local-audio directory contains a non-regular entry: ${entryPath}`,
              { path: entryPath },
            );
          }
          if (supportedExtension(entryPath) === undefined) {
            continue;
          }

          let descriptor: LocalAudioDescriptor;
          try {
            descriptor = await this.#validateFile(entryPath, root, signal);
          } catch (error) {
            if (error instanceof LocalAudioError && error.code === "INVALID_AUDIO") {
              continue;
            }
            throw error;
          }
          audio.push(descriptor);
          if (audio.length > this.#limits.maxFiles) {
            throw new LocalAudioError(
              "LIMIT_EXCEEDED",
              `Local-audio scan contains more than ${this.#limits.maxFiles} audio files`,
              { path: root },
            );
          }
        }
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof LocalAudioError) {
          throw error;
        }
        throw filesystemError(
          current.path,
          "Unable to enumerate local-audio directory",
          error,
        );
      }
      await this.#recheckDirectory(current.path, root, signal);
    }

    audio.sort(compareDescriptors);
    return Object.freeze(audio);
  }


  /**
   * Select and validate one configured entry. Deterministic mode hashes its
   * required seed, rotating mode advances one bounded cursor, and random mode
   * consumes the constructor's random source. Bracket-wrapped legacy choices
   * such as `[first.wav|second.wav]` are expanded before selection.
   */
  async pick(
    entries: readonly string[],
    options: LocalAudioSelectionOptions,
  ): Promise<LocalAudioDescriptor | undefined> {
    throwIfAborted(options.signal);
    const choices = configuredChoices(entries, this.#limits.maxEntries);
    if (choices.length === 0) {
      return undefined;
    }
    let index: number;
    switch (options.mode) {
      case "deterministic":
        index = stableHash(seedText(options.seed)) % choices.length;
        break;
      case "rotating": {
        const signature = JSON.stringify(choices);
        if (this.#rotationState?.signature !== signature) {
          this.#rotationState = { signature, nextIndex: 0 };
        }
        index = this.#rotationState.nextIndex;
        this.#rotationState.nextIndex = (index + 1) % choices.length;
        break;
      }
      case "random": {
        const random = this.#random();
        if (!Number.isFinite(random) || random < 0 || random >= 1) {
          throw new LocalAudioError(
            "INVALID_ARGUMENT",
            "The local-audio random source must return a number in [0, 1)",
          );
        }
        index = Math.floor(random * choices.length);
        break;
      }
      default:
        throw new LocalAudioError(
          "INVALID_ARGUMENT",
          "Unsupported local-audio selection mode",
        );
    }
    const selected = choices[index];
    if (selected === undefined) {
      throw new LocalAudioError(
        "INVALID_ARGUMENT",
        "Local-audio selection did not produce a configured entry",
      );
    }
    return await this.resolve(selected, options.signal);
  }

  async #canonicalBase(signal: AbortSignal | undefined): Promise<string> {
    const base = await filesystemOperation(
      this.#projectBase,
      "Unable to canonicalize project directory",
      signal,
      async () => await realpath(this.#projectBase),
    );
    const stats = await filesystemOperation(
      base,
      "Unable to inspect project directory",
      signal,
      async () => await lstat(base),
    );
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new LocalAudioError(
        "NOT_DIRECTORY",
        `Project base is not a regular directory: ${this.#projectBase}`,
        { path: this.#projectBase },
      );
    }
    return base;
  }

  async #inspectPathWithoutSymlinks(
    root: string,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<Stats> {
    if (!isContained(root, target)) {
      throw new LocalAudioError(
        "OUTSIDE_PROJECT",
        `Local-audio path is outside its allowed root: ${target}`,
        { path: target },
      );
    }
    let current = root;
    let stats = await filesystemOperation(
      root,
      "Unable to inspect local-audio root",
      signal,
      async () => await lstat(root),
    );
    if (stats.isSymbolicLink()) {
      throw new LocalAudioError(
        "SYMLINK",
        `Local-audio root changed into a symbolic link: ${root}`,
        { path: root },
      );
    }
    if (!stats.isDirectory()) {
      throw new LocalAudioError(
        "NOT_DIRECTORY",
        `Local-audio root is no longer a directory: ${root}`,
        { path: root },
      );
    }
    const fromRoot = relative(root, target);
    if (fromRoot !== "") {
      for (const component of fromRoot.split(sep)) {
        throwIfAborted(signal);
        current = join(current, component);
        stats = await filesystemOperation(
          current,
          "Unable to inspect local-audio path",
          signal,
          async () => await lstat(current),
        );
        if (stats.isSymbolicLink()) {
          throw new LocalAudioError(
            "SYMLINK",
            `Local-audio paths may not contain symbolic links: ${current}`,
            { path: current },
          );
        }
      }
    }
    return stats;
  }

  async #recheckDirectory(
    directory: string,
    root: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const stats = await filesystemOperation(
      directory,
      "Unable to recheck local-audio directory",
      signal,
      async () => await lstat(directory),
    );
    if (stats.isSymbolicLink()) {
      throw new LocalAudioError(
        "SYMLINK",
        `Local-audio directory changed into a symbolic link: ${directory}`,
        { path: directory },
      );
    }
    if (!stats.isDirectory()) {
      throw new LocalAudioError(
        "NOT_DIRECTORY",
        `Local-audio directory is no longer a directory: ${directory}`,
        { path: directory },
      );
    }
    const canonical = await filesystemOperation(
      directory,
      "Unable to recanonicalize local-audio directory",
      signal,
      async () => await realpath(directory),
    );
    if (!isContained(root, canonical) || !samePath(directory, canonical)) {
      throw new LocalAudioError(
        "SYMLINK",
        `Local-audio directory changed while it was being scanned: ${directory}`,
        { path: directory },
      );
    }
  }

  async #validateFile(
    target: string,
    allowedRoot: string,
    signal: AbortSignal | undefined,
  ): Promise<LocalAudioDescriptor> {
    const targetStats = await this.#inspectPathWithoutSymlinks(
      allowedRoot,
      target,
      signal,
    );
    if (!targetStats.isFile()) {
      throw new LocalAudioError(
        "NOT_REGULAR_FILE",
        `Configured local-audio path is not a regular file: ${target}`,
        { path: target },
      );
    }
    const canonical = await filesystemOperation(
      target,
      "Unable to canonicalize local-audio file",
      signal,
      async () => await realpath(target),
    );
    if (!isContained(allowedRoot, canonical)) {
      throw new LocalAudioError(
        "OUTSIDE_PROJECT",
        `Local-audio file resolves outside its allowed root: ${target}`,
        { path: target },
      );
    }
    if (!samePath(target, canonical)) {
      throw new LocalAudioError(
        "SYMLINK",
        `Local-audio file resolves through a link: ${target}`,
        { path: target },
      );
    }
    const extension = supportedExtension(canonical);
    if (extension === undefined) {
      throw new LocalAudioError(
        "UNSUPPORTED_FORMAT",
        `Unsupported local-audio extension: ${extname(canonical) || "(none)"}`,
        { path: canonical },
      );
    }

    const openFlags = constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    return await filesystemOperation(
      canonical,
      "Unable to validate local-audio file",
      signal,
      async () => {
        const handle = await open(canonical, openFlags);
        try {
          throwIfAborted(signal);
          const initialStats = await handle.stat({ bigint: true });
          throwIfAborted(signal);
          if (!initialStats.isFile()) {
            throw new LocalAudioError(
              "NOT_REGULAR_FILE",
              `Configured local-audio path is not a regular file: ${canonical}`,
              { path: canonical },
            );
          }
          if (initialStats.size > BigInt(this.#limits.maxFileBytes)) {
            throw new LocalAudioError(
              "LIMIT_EXCEEDED",
              `Local-audio file exceeds ${this.#limits.maxFileBytes} bytes: ${canonical}`,
              { path: canonical },
            );
          }

          const bytesToRead = Math.min(Number(initialStats.size), HEADER_BYTES);
          const header = await readBoundedHeader(handle, bytesToRead, signal);
          if (!hasValidSignature(extension, header)) {
            throw new LocalAudioError(
              "INVALID_AUDIO",
              `Local-audio file header does not match ${extension}: ${canonical}`,
              { path: canonical },
            );
          }

          const handleStats = await handle.stat({ bigint: true });
          const pathStats = await lstat(canonical, { bigint: true });
          const finalCanonical = await realpath(canonical);
          throwIfAborted(signal);
          if (pathStats.isSymbolicLink()) {
            throw new LocalAudioError(
              "SYMLINK",
              `Local-audio file changed into a symbolic link: ${canonical}`,
              { path: canonical },
            );
          }
          if (
            !pathStats.isFile() ||
            !unchangedFile(initialStats, handleStats) ||
            !unchangedFile(handleStats, pathStats) ||
            !samePath(canonical, finalCanonical) ||
            !isContained(allowedRoot, finalCanonical)
          ) {
            throw new LocalAudioError(
              "SYMLINK",
              `Local-audio file changed while it was being validated: ${canonical}`,
              { path: canonical },
            );
          }

          const filename = basename(finalCanonical);
          return Object.freeze({
            path: finalCanonical,
            filename,
            stem: parse(filename).name,
            extension,
            size: Number(handleStats.size),
            identity: Object.freeze({
              dev: handleStats.dev,
              ino: handleStats.ino,
              size: handleStats.size,
              mtimeNs: handleStats.mtimeNs,
              ctimeNs: handleStats.ctimeNs,
            }),
          });
        } finally {
          await handle.close();
        }
      },
    );
  }
}
