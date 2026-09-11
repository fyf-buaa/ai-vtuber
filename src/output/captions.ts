import { extname, relative, resolve, sep } from "node:path";
import type { EventPublisher } from "../domain/types.js";
import {
  asOutputBridgeError,
  OutputConfigError,
  publishOutputFailure,
  type OutputClock,
} from "./errors.js";
import {
  resolveContainedPath,
  type OutputFileSystem,
  writeFileAtomically,
} from "./files.js";

export interface CaptionUpdate {
  readonly content: string;
  readonly username?: string | undefined;
  readonly kind?: string | undefined;
  readonly sourceEventId?: string | undefined;
}

export interface CaptionBridge {
  readonly name: string;
  readonly enabled: boolean;
  update(caption: CaptionUpdate, signal?: AbortSignal): Promise<void>;
}

export interface CaptionBridgeDependencies {
  readonly fileSystem?: OutputFileSystem | undefined;
  readonly rootDirectory?: string | undefined;
  readonly publisher?: EventPublisher | undefined;
  readonly clock?: OutputClock | undefined;
  readonly makeId?: (() => string) | undefined;
}

const CAPTION_FILE_EXTENSIONS: Readonly<Record<string, true>> = {
  ".ass": true,
  ".srt": true,
  ".ssa": true,
  ".txt": true,
  ".vtt": true,
};

const CAPTION_OUTPUT_DIRECTORIES = ["log", "out"] as const;

export interface FileCaptionBridgeConfig {
  readonly enabled: boolean;
  readonly rootDirectory?: string | undefined;
  readonly filePath?: string | undefined;
}

export class FileCaptionBridge implements CaptionBridge {
  readonly name = "file-captions";
  readonly enabled: boolean;
  readonly #config: FileCaptionBridgeConfig;
  readonly #dependencies: CaptionBridgeDependencies;

  constructor(config: FileCaptionBridgeConfig, dependencies: CaptionBridgeDependencies = {}) {
    this.enabled = config.enabled;
    this.#config = config;
    this.#dependencies = dependencies;
  }

  async update(caption: CaptionUpdate, signal?: AbortSignal): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const component = "output.file-captions";
    try {
      signal?.throwIfAborted();
      const root = resolve(this.#config.rootDirectory ?? ".");
      const filePath = this.#config.filePath?.trim();
      if (filePath === undefined || filePath.length === 0) {
        throw new OutputConfigError(component, "file captions are enabled but file_path is missing");
      }
      const destination = resolveCaptionDestination(root, filePath, component);
      const bytes = new TextEncoder().encode(caption.content);
      await writeFileAtomically(destination, bytes, {
        component,
        rootDirectory: root,
        allowedDirectories: CAPTION_OUTPUT_DIRECTORIES,
        ...(this.#dependencies.fileSystem === undefined ? {} : { fileSystem: this.#dependencies.fileSystem }),
        ...(this.#dependencies.makeId === undefined ? {} : { makeId: this.#dependencies.makeId }),
      });
    } catch (cause) {
      const error = asOutputBridgeError(component, cause, "file caption update failed");
      publishOutputFailure(this.#dependencies.publisher, error, this.#dependencies.clock);
      throw error;
    }
  }
}
export function resolveCaptionDestination(
  root: string,
  filePath: string,
  component: string,
): string {
  const destination = resolveContainedPath(root, filePath, component);
  const relativePath = relative(root, destination);
  const [directory] = relativePath.split(sep);
  if (
    directory === undefined ||
    !CAPTION_OUTPUT_DIRECTORIES.some((allowed) => allowed === directory) ||
    CAPTION_FILE_EXTENSIONS[extname(destination).toLowerCase()] !== true
  ) {
    throw new OutputConfigError(
      component,
      "caption file_path must be a supported text format under log/ or out/",
    );
  }
  return destination;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function recordAt(config: JsonRecord, key: string): JsonRecord {
  const value = config[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function createCaptionBridgesFromConfig(
  config: JsonRecord,
  dependencies: CaptionBridgeDependencies = {},
): {
  readonly rendered: CaptionBridge;
  readonly raw: CaptionBridge;
} {
  const captions = recordAt(config, "captions");
  const rootDirectory = resolve(dependencies.rootDirectory ?? ".");
  const captionsEnabled = captions["enable"] === true;
  const sharedFileOptions = {
    enabled: captionsEnabled,
    rootDirectory,
  };

  const renderedFile = new FileCaptionBridge({
    ...sharedFileOptions,
    filePath: typeof captions["file_path"] === "string" ? captions["file_path"] : undefined,
  }, dependencies);
  const rawFile = new FileCaptionBridge({
    ...sharedFileOptions,
    filePath: typeof captions["raw_file_path"] === "string" ? captions["raw_file_path"] : undefined,
  }, dependencies);
  return {
    rendered: renderedFile,
    raw: rawFile,
  };
}

