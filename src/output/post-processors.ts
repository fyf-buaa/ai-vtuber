import { basename, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AudioArtifact,
  AudioPostProcessor,
  SpeechAudioContext,
} from "../speech/types.js";
import type { EventPublisher } from "../domain/types.js";
import {
  OutputBridgeError,
  OutputConfigError,
  publishOutputFailure,
  type OutputClock,
} from "./errors.js";
import {
  nodeOutputFileSystem,
  requireAbsoluteArtifactPath,
  type OutputFileSystem,
  writeFileAtomically,
} from "./files.js";
import {
  appendEndpoint,
  requestBytes,
  type OutputFetch,
} from "./http.js";

export interface SvcPostProcessorDependencies {
  readonly projectRoot?: string | undefined;
  readonly fetch?: OutputFetch | undefined;
  readonly fileSystem?: OutputFileSystem | undefined;
  readonly publisher?: EventPublisher | undefined;
  readonly clock?: OutputClock | undefined;
  readonly makeId?: (() => string) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBodyBytes?: number | undefined;
}

export interface SoVitsSvcPostProcessorConfig {
  readonly enabled: boolean;
  readonly apiBaseUrl?: string | undefined;
  readonly outputDirectory?: string | undefined;
  readonly speaker?: string | undefined;
  readonly transpose?: number | undefined;
  readonly format?: string | undefined;
}

export interface DdspSvcPostProcessorConfig {
  readonly enabled: boolean;
  readonly apiBaseUrl?: string | undefined;
  readonly outputDirectory?: string | undefined;
  readonly safePrefixPadLength?: number | undefined;
  readonly pitchChange?: number | undefined;
  readonly speakerId?: number | undefined;
  readonly sampleRate?: number | undefined;
}


const SAFE_FORMAT = /^[A-Za-z0-9]{1,10}$/u;

function normalizedFormat(value: string | undefined, component: string): string {
  const format = (value ?? "wav").replace(/^\./u, "").toLowerCase();
  if (!SAFE_FORMAT.test(format)) {
    throw new OutputConfigError(component, `${component} output format is invalid`);
  }
  return format;
}

function finiteNumber(value: number | undefined, fallback: number, field: string, component: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result)) {
    throw new OutputConfigError(component, `${component} ${field} must be a finite number`);
  }
  return result;
}

function makeOutputPath(
  outputDirectory: string | undefined,
  projectRoot: string | undefined,
  prefix: string,
  context: SpeechAudioContext,
  format: string,
  makeId: (() => string) | undefined,
): string {
  const directory = resolve(projectRoot ?? ".", outputDirectory ?? "out");
  const speechId = context.speechId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80) || "speech";
  const rawId = (makeId ?? randomUUID)().replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 80);
  return resolve(directory, `${prefix}-${speechId}-${rawId || "output"}.${format}`);
}

async function commitSvcArtifact(
  component: string,
  outputPath: string,
  format: string,
  bytes: Uint8Array,
  dependencies: SvcPostProcessorDependencies,
): Promise<AudioArtifact> {
  const fileSystem = dependencies.fileSystem ?? nodeOutputFileSystem;
  try {
    await writeFileAtomically(outputPath, bytes, {
      component,
      fileSystem,
      ...(dependencies.makeId === undefined ? {} : { makeId: dependencies.makeId }),
    });
    const info = await fileSystem.stat(outputPath);
    if (!info.isFile() || info.size <= 0) {
      throw new OutputBridgeError(`${component} committed an invalid output artifact`, {
        code: "OUTPUT_RESPONSE_INVALID",
        component,
      });
    }
    return { path: outputPath, format, temporary: true };
  } catch (cause) {
    await fileSystem.remove(outputPath).catch(() => undefined);
    const error = cause instanceof OutputBridgeError
      ? cause
      : new OutputBridgeError(`${component} could not store its output artifact`, {
          code: "OUTPUT_REQUEST_FAILED",
          component,
          cause,
        });
    publishOutputFailure(dependencies.publisher, error, dependencies.clock, { outputPath });
    throw error;
  }
}

export class SoVitsSvcPostProcessor implements AudioPostProcessor {
  readonly #config: SoVitsSvcPostProcessorConfig;
  readonly #dependencies: SvcPostProcessorDependencies;

  constructor(
    config: SoVitsSvcPostProcessorConfig,
    dependencies: SvcPostProcessorDependencies = {},
  ) {
    this.#config = config;
    this.#dependencies = dependencies;
  }

  async process(
    artifact: AudioArtifact,
    context: SpeechAudioContext,
    signal: AbortSignal,
  ): Promise<AudioArtifact> {
    if (!this.#config.enabled) {
      return artifact;
    }

    const component = "output.so-vits-svc";
    const inputPath = requireAbsoluteArtifactPath(artifact.path, component);
    const apiBaseUrl = this.#config.apiBaseUrl?.trim();
    if (apiBaseUrl === undefined || apiBaseUrl.length === 0) {
      throw new OutputConfigError(component, "so-vits-svc is enabled but api_ip_port is missing");
    }
    const speaker = this.#config.speaker?.trim();
    if (speaker === undefined || speaker.length === 0) {
      throw new OutputConfigError(component, "so-vits-svc is enabled but spk is missing");
    }
    const format = normalizedFormat(this.#config.format, component);
    const body = new URLSearchParams({
      audio_path: inputPath,
      tran: String(finiteNumber(this.#config.transpose, 0, "tran", component)),
      spk: speaker,
      wav_format: format,
    });
    const bytes = await requestBytes({
      component,
      url: appendEndpoint(apiBaseUrl, "wav2wav", component),
      fetch: this.#dependencies.fetch,
      publisher: this.#dependencies.publisher,
      clock: this.#dependencies.clock,
      timeoutMs: this.#dependencies.timeoutMs,
      maxBodyBytes: this.#dependencies.maxBodyBytes,
      signal,
      init: { method: "POST", body },
    });
    const outputPath = makeOutputPath(
      this.#config.outputDirectory,
      this.#dependencies.projectRoot,
      "so-vits-svc",
      context,
      format,
      this.#dependencies.makeId,
    );
    return commitSvcArtifact(component, outputPath, format, bytes, this.#dependencies);
  }
}

export class DdspSvcPostProcessor implements AudioPostProcessor {
  readonly #config: DdspSvcPostProcessorConfig;
  readonly #dependencies: SvcPostProcessorDependencies;

  constructor(
    config: DdspSvcPostProcessorConfig,
    dependencies: SvcPostProcessorDependencies = {},
  ) {
    this.#config = config;
    this.#dependencies = dependencies;
  }

  async process(
    artifact: AudioArtifact,
    context: SpeechAudioContext,
    signal: AbortSignal,
  ): Promise<AudioArtifact> {
    if (!this.#config.enabled) {
      return artifact;
    }

    const component = "output.ddsp-svc";
    const inputPath = requireAbsoluteArtifactPath(artifact.path, component);
    const apiBaseUrl = this.#config.apiBaseUrl?.trim();
    if (apiBaseUrl === undefined || apiBaseUrl.length === 0) {
      throw new OutputConfigError(component, "DDSP-SVC is enabled but api_ip_port is missing");
    }

    const fileSystem = this.#dependencies.fileSystem ?? nodeOutputFileSystem;
    let input: Uint8Array;
    try {
      input = await fileSystem.readFile(inputPath);
    } catch (cause) {
      const error = new OutputBridgeError("DDSP-SVC could not read its input artifact", {
        code: "OUTPUT_PATH_INVALID",
        component,
        cause,
      });
      publishOutputFailure(this.#dependencies.publisher, error, this.#dependencies.clock, {
        inputPath,
      });
      throw error;
    }
    if (input.byteLength === 0) {
      const error = new OutputBridgeError("DDSP-SVC input artifact is empty", {
        code: "OUTPUT_PATH_INVALID",
        component,
      });
      publishOutputFailure(this.#dependencies.publisher, error, this.#dependencies.clock, {
        inputPath,
      });
      throw error;
    }

    const sampleRate = finiteNumber(this.#config.sampleRate, 44_100, "sampleRate", component);
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new OutputConfigError(component, "DDSP-SVC sampleRate must be a positive integer");
    }
    const speakerId = finiteNumber(this.#config.speakerId, 0, "sSpeakId", component);
    if (!Number.isInteger(speakerId) || speakerId < 0) {
      throw new OutputConfigError(component, "DDSP-SVC sSpeakId must be a non-negative integer");
    }

    const ownedBytes = new Uint8Array(input.byteLength);
    ownedBytes.set(input);
    const form = new FormData();
    form.set(
      "sample",
      new Blob([ownedBytes.buffer], { type: artifact.format === "wav" ? "audio/wav" : "application/octet-stream" }),
      basename(inputPath),
    );
    form.set(
      "fSafePrefixPadLength",
      String(finiteNumber(this.#config.safePrefixPadLength, 0, "fSafePrefixPadLength", component)),
    );
    form.set(
      "fPitchChange",
      String(finiteNumber(this.#config.pitchChange, 0, "fPitchChange", component)),
    );
    form.set("sSpeakId", String(speakerId));
    form.set("sampleRate", String(sampleRate));

    const bytes = await requestBytes({
      component,
      url: appendEndpoint(apiBaseUrl, "voiceChangeModel", component),
      fetch: this.#dependencies.fetch,
      publisher: this.#dependencies.publisher,
      clock: this.#dependencies.clock,
      timeoutMs: this.#dependencies.timeoutMs,
      maxBodyBytes: this.#dependencies.maxBodyBytes,
      signal,
      init: { method: "POST", body: form },
    });
    const format = normalizedFormat(extname(inputPath).replace(/^\./u, "") || artifact.format, component);
    const outputPath = makeOutputPath(
      this.#config.outputDirectory,
      this.#dependencies.projectRoot,
      "ddsp-svc",
      context,
      format,
      this.#dependencies.makeId,
    );
    return commitSvcArtifact(component, outputPath, format, bytes, this.#dependencies);
  }
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

function booleanAt(config: JsonRecord, key: string): boolean {
  return config[key] === true;
}

function stringAt(config: JsonRecord, key: string): string | undefined {
  return typeof config[key] === "string" ? config[key] : undefined;
}

function numberAt(config: JsonRecord, key: string): number | undefined {
  const value = config[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function createSvcPostProcessorsFromConfig(
  config: JsonRecord,
  dependencies: SvcPostProcessorDependencies = {},
): readonly AudioPostProcessor[] {
  const outputDirectory = stringAt(recordAt(config, "play_audio"), "out_path");
  const ddsp = recordAt(config, "ddsp_svc");
  const soVits = recordAt(config, "so_vits_svc");
  const processors: AudioPostProcessor[] = [];

  if (booleanAt(ddsp, "enable")) {
    processors.push(new DdspSvcPostProcessor({
      enabled: true,
      apiBaseUrl: stringAt(ddsp, "api_ip_port"),
      outputDirectory,
      safePrefixPadLength: numberAt(ddsp, "fSafePrefixPadLength"),
      pitchChange: numberAt(ddsp, "fPitchChange"),
      speakerId: numberAt(ddsp, "sSpeakId"),
      sampleRate: numberAt(ddsp, "sampleRate"),
    }, dependencies));
  }
  if (booleanAt(soVits, "enable")) {
    processors.push(new SoVitsSvcPostProcessor({
      enabled: true,
      apiBaseUrl: stringAt(soVits, "api_ip_port"),
      outputDirectory,
      speaker: stringAt(soVits, "spk"),
      transpose: numberAt(soVits, "tran"),
      format: stringAt(soVits, "wav_format"),
    }, dependencies));
  }
  return processors;
}

