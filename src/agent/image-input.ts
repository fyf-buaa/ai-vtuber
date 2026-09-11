import {
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ImageContent } from "@earendil-works/pi-ai";

import type { AgentRequest } from "../domain/types.js";
import { PiAgentError } from "./errors.js";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BASE64_WHITESPACE_GLOBAL = /\s+/gu;
const IMAGE_SIGNATURE_PREFIX_BYTES = 4096;
const SVG_PREFIX =
  /^(?:<\?xml[\s\S]*?\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!doctype\s+svg[\s\S]*?>)\s*)*<svg(?:\s|>)/iu;
const UTF8_DECODER = new TextDecoder();

export interface NormalizePiImagesOptions {
  readonly localImageRoots?: readonly string[] | undefined;
  readonly maxImageBytes?: number | undefined;
}

interface LocalImageRootState {
  readonly configured: readonly string[] | undefined;
  resolved: Promise<readonly string[]> | undefined;
}

interface Base64Shape {
  readonly decodedByteLength: number;
  readonly paddingLength: number;
}

interface DecodedBase64 {
  readonly data: Buffer;
  readonly encoded: string;
}

export async function normalizePiImages(
  request: AgentRequest,
  options: NormalizePiImagesOptions = {},
): Promise<ImageContent[] | undefined> {
  if (!request.images || request.images.length === 0) return undefined;

  const maxImageBytes = resolveMaxImageBytes(options.maxImageBytes);
  const localImageRoots: LocalImageRootState = {
    configured: options.localImageRoots,
    resolved: undefined,
  };
  const images: ImageContent[] = [];
  for (let index = 0; index < request.images.length; index += 1) {
    const source = request.images[index];
    if (!source || source.trim().length === 0) {
      throw new PiAgentError(
        "configuration",
        `Image ${index + 1} is empty`,
      );
    }
    images.push(
      await normalizeImage(
        source.trim(),
        request,
        index,
        maxImageBytes,
        localImageRoots,
      ),
    );
  }
  return images;
}

async function normalizeImage(
  source: string,
  request: AgentRequest,
  index: number,
  maxImageBytes: number,
  localImageRoots: LocalImageRootState,
): Promise<ImageContent> {
  if (/^data:/iu.test(source)) {
    return decodeDataUrl(source, index, maxImageBytes);
  }
  if (/^https?:\/\//iu.test(source)) {
    throw new PiAgentError(
      "configuration",
      `Image ${index + 1} uses an HTTP URL; use a data URL or an explicitly allowed local file`,
    );
  }

  const fileUrl = /^file:/iu.test(source);
  if (
    !fileUrl &&
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source) &&
    !/^[A-Za-z]:[\\/]/u.test(source)
  ) {
    throw new PiAgentError(
      "configuration",
      `Image ${index + 1} uses an unsupported URL protocol`,
    );
  }

  const configuredMimeType = configuredImageMimeType(request, index);
  const rawImageCandidate = decodeRawBase64Candidate(
    source,
    index,
    maxImageBytes,
  );
  const rawMimeType = rawImageCandidate
    ? inferImageMimeType(rawImageCandidate.data)
    : undefined;
  if (rawImageCandidate && rawMimeType) {
    return {
      type: "image",
      data: rawImageCandidate.encoded,
      mimeType: configuredMimeType ?? rawMimeType,
    };
  }
  if (fileUrl || looksLikeFilePath(source)) {
    return await normalizeLocalImage(
      source,
      configuredMimeType,
      index,
      maxImageBytes,
      localImageRoots,
    );
  }

  const decoded =
    rawImageCandidate ?? decodeBase64(source, index, maxImageBytes);
  const mimeType = configuredMimeType ?? inferImageMimeType(decoded.data);
  if (!mimeType) {
    throw new PiAgentError(
      "configuration",
      `Raw base64 image ${index + 1} requires metadata.imageMimeType(s) or a recognizable image signature`,
    );
  }
  return { type: "image", data: decoded.encoded, mimeType };
}

async function normalizeLocalImage(
  source: string,
  configuredMimeType: string | undefined,
  index: number,
  maxImageBytes: number,
  localImageRoots: LocalImageRootState,
): Promise<ImageContent> {
  if (
    localImageRoots.configured === undefined ||
    localImageRoots.configured.length === 0
  ) {
    throw new PiAgentError(
      "configuration",
      `Local image ${index + 1} is not permitted; configure at least one localImageRoots entry`,
    );
  }

  const sourcePath = /^file:/iu.test(source)
    ? pathFromFileUrl(source, index)
    : source;
  const canonicalRoots = await resolveConfiguredLocalImageRoots(
    localImageRoots,
  );
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(sourcePath);
  } catch (error) {
    throw new PiAgentError(
      "configuration",
      `Unable to resolve local image ${index + 1}`,
      { cause: error },
    );
  }

  if (
    canonicalRoots.some(
      (canonicalRoot) => relative(canonicalRoot, canonicalTarget) === "",
    )
  ) {
    throw new PiAgentError(
      "configuration",
      `Local image ${index + 1} resolves to an allowed root instead of a file`,
    );
  }
  if (
    !canonicalRoots.some((canonicalRoot) =>
      isContainedPath(canonicalRoot, canonicalTarget),
    )
  ) {
    throw new PiAgentError(
      "configuration",
      `Local image ${index + 1} is outside the configured localImageRoots`,
    );
  }
  try {
    const targetStats = await stat(canonicalTarget);
    if (!targetStats.isFile()) {
      throw new PiAgentError(
        "configuration",
        `Local image ${index + 1} is not a regular file`,
      );
    }
    if (targetStats.size > maxImageBytes) {
      throw imageTooLargeError(index, maxImageBytes);
    }
  } catch (error) {
    if (error instanceof PiAgentError) throw error;
    throw new PiAgentError(
      "configuration",
      `Unable to inspect local image ${index + 1}`,
      { cause: error },
    );
  }

  let handle: FileHandle;
  try {
    handle = await open(canonicalTarget, "r");
  } catch (error) {
    throw new PiAgentError(
      "configuration",
      `Unable to open local image ${index + 1}`,
      { cause: error },
    );
  }

  let data: Buffer;
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) {
      throw new PiAgentError(
        "configuration",
        `Local image ${index + 1} is not a regular file`,
      );
    }
    if (fileStats.size > maxImageBytes) {
      throw imageTooLargeError(index, maxImageBytes);
    }
    data = await readFileWithLimit(
      handle,
      fileStats.size,
      index,
      maxImageBytes,
    );
  } catch (error) {
    if (error instanceof PiAgentError) throw error;
    throw new PiAgentError(
      "configuration",
      `Unable to read local image ${index + 1}`,
      { cause: error },
    );
  } finally {
    await handle.close().catch(() => undefined);
  }

  const detectedMimeType = inferImageMimeType(data);
  if (!detectedMimeType) {
    throw new PiAgentError(
      "configuration",
      `Local image ${index + 1} is not a recognized image`,
    );
  }
  return {
    type: "image",
    data: data.toString("base64"),
    mimeType: configuredMimeType ?? detectedMimeType,
  };
}

async function resolveConfiguredLocalImageRoots(
  state: LocalImageRootState,
): Promise<readonly string[]> {
  if (state.resolved) return await state.resolved;

  const configured = state.configured;
  if (!configured || configured.length === 0) return [];
  state.resolved = Promise.all(
    configured.map(async (root, rootIndex) => {
      if (typeof root !== "string" || root.trim().length === 0) {
        throw new PiAgentError(
          "configuration",
          `localImageRoots entry ${rootIndex + 1} must be a non-empty path`,
        );
      }

      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(root);
        const rootStats = await stat(canonicalRoot);
        if (!rootStats.isDirectory()) {
          throw new PiAgentError(
            "configuration",
            `localImageRoots entry ${rootIndex + 1} is not a directory`,
          );
        }
      } catch (error) {
        if (error instanceof PiAgentError) throw error;
        throw new PiAgentError(
          "configuration",
          `Unable to resolve localImageRoots entry ${rootIndex + 1}`,
          { cause: error },
        );
      }
      return canonicalRoot;
    }),
  );
  return await state.resolved;
}

async function readFileWithLimit(
  handle: FileHandle,
  expectedBytes: number,
  index: number,
  maxImageBytes: number,
): Promise<Buffer> {
  let data = Buffer.allocUnsafe(
    Math.min(maxImageBytes + 1, Math.max(1, expectedBytes + 1)),
  );
  let position = 0;
  let totalBytes = 0;
  for (;;) {
    if (totalBytes === data.length) {
      if (totalBytes > maxImageBytes) {
        throw imageTooLargeError(index, maxImageBytes);
      }
      const expanded = Buffer.allocUnsafe(
        Math.min(maxImageBytes + 1, Math.max(data.length + 1, data.length * 2)),
      );
      data.copy(expanded, 0, 0, totalBytes);
      data = expanded;
    }

    const { bytesRead } = await handle.read(
      data,
      totalBytes,
      data.length - totalBytes,
      position,
    );
    if (bytesRead === 0) break;
    position += bytesRead;
    totalBytes += bytesRead;
    if (totalBytes > maxImageBytes) {
      throw imageTooLargeError(index, maxImageBytes);
    }
  }
  return data.subarray(0, totalBytes);
}

function pathFromFileUrl(source: string, index: number): string {
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch (error) {
    throw new PiAgentError(
      "configuration",
      `Local image ${index + 1} has an invalid file URL`,
      { cause: error },
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "file:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    source.includes("?") ||
    source.includes("#") ||
    (hostname !== "" && hostname !== "localhost")
  ) {
    throw new PiAgentError(
      "configuration",
      `Local image ${index + 1} has an invalid file URL`,
    );
  }

  try {
    return fileURLToPath(parsed);
  } catch (error) {
    throw new PiAgentError(
      "configuration",
      `Local image ${index + 1} has an invalid file URL`,
      { cause: error },
    );
  }
}

function isContainedPath(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation.length > 0 &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function resolveMaxImageBytes(configured: number | undefined): number {
  const value = configured ?? DEFAULT_MAX_IMAGE_BYTES;
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    throw new PiAgentError(
      "configuration",
      "maxImageBytes must be a positive safe integer",
    );
  }
  return value;
}

function decodeDataUrl(
  source: string,
  index: number,
  maxImageBytes: number,
): ImageContent {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/iu.exec(source);
  if (!match) {
    throw new PiAgentError(
      "configuration",
      `Image ${index + 1} must be a base64-encoded image data URL`,
    );
  }
  const mimeType = match[1]?.toLowerCase();
  const encoded = match[2];
  if (!mimeType?.startsWith("image/") || encoded === undefined) {
    throw new PiAgentError(
      "configuration",
      `Image ${index + 1} has an invalid image MIME type`,
    );
  }
  const decoded = decodeBase64(encoded, index, maxImageBytes);
  return { type: "image", data: decoded.encoded, mimeType };
}

function decodeBase64(
  source: string,
  index: number,
  maxImageBytes: number,
): DecodedBase64 {
  const shape = inspectBase64(source);
  if (!shape) throw invalidBase64Error(index);
  const decoded = decodeInspectedBase64(
    source,
    shape,
    index,
    maxImageBytes,
    true,
  );
  if (!decoded) throw invalidBase64Error(index);
  return decoded;
}

function decodeRawBase64Candidate(
  source: string,
  index: number,
  maxImageBytes: number,
): DecodedBase64 | undefined {
  const shape = inspectBase64(source);
  if (!shape) return undefined;
  return decodeInspectedBase64(
    source,
    shape,
    index,
    maxImageBytes,
    false,
  );
}

function inspectBase64(source: string): Base64Shape | undefined {
  let significantLength = 0;
  let paddingLength = 0;
  let sawPadding = false;
  for (let offset = 0; offset < source.length; offset += 1) {
    const code = source.charCodeAt(offset);
    if (
      (code >= 0x09 && code <= 0x0d) ||
      code === 0x20 ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000 ||
      code === 0xfeff
    ) {
      continue;
    }

    significantLength += 1;
    if (code === 0x3d) {
      sawPadding = true;
      paddingLength += 1;
      if (paddingLength > 2) return undefined;
      continue;
    }
    const base64Character =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (sawPadding || !base64Character) return undefined;
  }

  if (significantLength === 0 || significantLength % 4 === 1) {
    return undefined;
  }
  return {
    decodedByteLength: Math.floor(
      ((significantLength - paddingLength) * 3) / 4,
    ),
    paddingLength,
  };
}

function decodeInspectedBase64(
  source: string,
  shape: Base64Shape,
  index: number,
  maxImageBytes: number,
  invalidIsError: boolean,
): DecodedBase64 | undefined {
  if (shape.decodedByteLength > maxImageBytes) {
    throw imageTooLargeError(index, maxImageBytes);
  }

  const compact = source.replace(BASE64_WHITESPACE_GLOBAL, "");
  const data = Buffer.from(compact, "base64");
  if (data.byteLength > maxImageBytes) {
    throw imageTooLargeError(index, maxImageBytes);
  }
  const encoded = data.toString("base64");
  const canonicalInput =
    shape.paddingLength > 0
      ? compact.slice(0, -shape.paddingLength)
      : compact;
  const canonicalDecoded = encoded.replace(/=+$/u, "");
  if (
    data.byteLength === 0 ||
    canonicalInput !== canonicalDecoded
  ) {
    if (invalidIsError) throw invalidBase64Error(index);
    return undefined;
  }
  return { data, encoded };
}

function invalidBase64Error(index: number): PiAgentError {
  return new PiAgentError(
    "configuration",
    `Image ${index + 1} contains invalid base64 data`,
  );
}

function imageTooLargeError(
  index: number,
  maxImageBytes: number,
): PiAgentError {
  return new PiAgentError(
    "configuration",
    `Image ${index + 1} exceeds the ${maxImageBytes}-byte limit`,
  );
}

function looksLikeFilePath(source: string): boolean {
  return (
    source.startsWith(".") ||
    source.startsWith("/") ||
    source.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(source) ||
    source.includes("\\") ||
    MIME_BY_EXTENSION[extname(source).toLowerCase()] !== undefined
  );
}

function configuredImageMimeType(
  request: AgentRequest,
  index: number,
): string | undefined {
  const configuredList = request.metadata?.imageMimeTypes;
  const listValue = Array.isArray(configuredList) ? configuredList[index] : undefined;
  const value =
    typeof listValue === "string"
      ? listValue
      : typeof request.metadata?.imageMimeType === "string"
        ? request.metadata.imageMimeType
        : undefined;
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith("image/")) {
    throw new PiAgentError(
      "configuration",
      `Image ${index + 1} has an invalid configured MIME type`,
    );
  }
  return normalized;
}

function inferImageMimeType(data: Uint8Array): string | undefined {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 6 &&
    String.fromCharCode(...data.subarray(0, 6)).startsWith("GIF8")
  ) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    String.fromCharCode(...data.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...data.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return "image/bmp";
  }
  if (
    data.length >= 12 &&
    data[4] === 0x66 &&
    data[5] === 0x74 &&
    data[6] === 0x79 &&
    data[7] === 0x70
  ) {
    const declaredBoxSize =
      (data[0] as number) * 0x1000000 +
      (data[1] as number) * 0x10000 +
      (data[2] as number) * 0x100 +
      (data[3] as number);
    const brandStart = declaredBoxSize === 1 ? 16 : 8;
    const boxEnd =
      declaredBoxSize === 0 || declaredBoxSize === 1
        ? Math.min(data.length, IMAGE_SIGNATURE_PREFIX_BYTES)
        : Math.min(
            data.length,
            declaredBoxSize,
            IMAGE_SIGNATURE_PREFIX_BYTES,
          );
    for (
      let offset = brandStart;
      offset + 3 < boxEnd;
      offset += 4
    ) {
      if (offset === brandStart + 4) continue;
      if (
        data[offset] === 0x61 &&
        data[offset + 1] === 0x76 &&
        data[offset + 2] === 0x69 &&
        (data[offset + 3] === 0x66 || data[offset + 3] === 0x73)
      ) {
        return "image/avif";
      }
    }
  }
  if (data.length > 0) {
    const prefix = UTF8_DECODER.decode(
      data.subarray(
        0,
        Math.min(data.length, IMAGE_SIGNATURE_PREFIX_BYTES),
      ),
    ).trimStart();
    if (SVG_PREFIX.test(prefix)) return "image/svg+xml";
  }
  return undefined;
}
