import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { JsonObject } from "../config/config-store.js";
import { AzureSpeechSynthesizer } from "./adapters/azure.js";
import { DisabledSpeechSynthesizer } from "./adapters/disabled.js";
import { EdgeSpeechSynthesizer } from "./adapters/edge.js";
import {
  LegacyGradioSpeechSynthesizer,
  type GradioTransport,
  type LegacyGradioSpeechConfig,
} from "./adapters/gradio.js";
import {
  LegacyHttpSpeechSynthesizer,
  type LegacyHttpSpeechConfig,
} from "./adapters/legacy-http.js";
import {
  LegacyRestSpeechSynthesizer,
  type LegacyRestSpeechConfig,
} from "./adapters/legacy-rest.js";
import { OpenAiSpeechSynthesizer } from "./adapters/openai.js";
import { SpeechConfigurationError } from "./errors.js";
import type {
  SpeechFetch,
  SpeechSynthesizer,
  SpeechPriorityMapping,
  SpeechTextSplitOptions,
} from "./types.js";

const SUPPORTED_ENGINES = [
  "none",
  "edge-tts",
  "azure_tts",
  "openai_tts",
  "vits",
  "bert_vits2",
  "gpt_sovits",
] as const;

const ENGINE_ALIASES: Readonly<Record<string, (typeof SUPPORTED_ENGINES)[number]>> = {
  none: "none",
  disabled: "none",
  off: "none",
  "edge-tts": "edge-tts",
  edge_tts: "edge-tts",
  azure: "azure_tts",
  azure_tts: "azure_tts",
  openai: "openai_tts",
  openai_tts: "openai_tts",
  vits: "vits",
  bert_vits2: "bert_vits2",
  "bert-vits2": "bert_vits2",
  gpt_sovits: "gpt_sovits",
  "gpt-sovits": "gpt_sovits",
};

export interface ExternalPlayerSettings {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface SpeechRuntimeSettings {
  readonly enabled: boolean;
  readonly playbackEnabled: boolean;
  readonly engine: string;
  readonly queueCapacity: number;
  readonly admissionWaiterCapacity: number;
  readonly queueStartThreshold: number;
  readonly priorityMapping: SpeechPriorityMapping;
  readonly requestTimeoutMs: number;
  readonly maxAudioBytes: number;
  readonly textSplit: SpeechTextSplitOptions;
  readonly outputDirectory: string;
  readonly temporaryDirectory: string;
  readonly preserveOutput: boolean;
  readonly player: ExternalPlayerSettings;
}

type UnknownObject = Readonly<Record<string, unknown>>;

function objectValue(
  object: UnknownObject,
  key: string,
  path = key,
): UnknownObject {
  const value = object[key];
  if (value === undefined) {
    return {};
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new SpeechConfigurationError(`${path} must be an object`);
  }
  return value as UnknownObject;
}

function optionalString(
  object: UnknownObject,
  key: string,
  path: string,
): string | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new SpeechConfigurationError(`${path} must be a string`);
  }
  return value;
}

function stringValue(
  object: UnknownObject,
  key: string,
  path: string,
  fallback?: string,
): string {
  const value = optionalString(object, key, path) ?? fallback;
  if (value === undefined || value.trim().length === 0) {
    throw new SpeechConfigurationError(`${path} must be a non-empty string`);
  }
  return value;
}

function booleanValue(
  object: UnknownObject,
  key: string,
  path: string,
  fallback: boolean,
): boolean {
  const value = object[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new SpeechConfigurationError(`${path} must be a boolean`);
  }
  return value;
}

function numberValue(
  object: UnknownObject,
  key: string,
  path: string,
  fallback: number,
): number {
  const value = object[key];
  if (value === undefined) {
    return fallback;
  }
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new SpeechConfigurationError(`${path} must be a finite number`);
  }
  return number;
}

function legacyRangeNumber(
  object: UnknownObject,
  key: string,
  path: string,
  fallback: number,
): number {
  const value = object[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const direct = Number(value);
    if (Number.isFinite(direct)) {
      return direct;
    }
    const range = /^\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*$/u.exec(
      value,
    );
    if (range !== null) {
      const minimum = Number(range[1]);
      const maximum = Number(range[2]);
      if (Number.isFinite(minimum) && Number.isFinite(maximum)) {
        return (minimum + maximum) / 2;
      }
    }
  }
  throw new SpeechConfigurationError(
    `${path} must be a finite number or numeric range`,
  );
}

function integerValue(
  object: UnknownObject,
  key: string,
  path: string,
  fallback: number,
): number {
  const value = numberValue(object, key, path, fallback);
  if (!Number.isSafeInteger(value)) {
    throw new SpeechConfigurationError(`${path} must be a safe integer`);
  }
  return value;
}

function priorityMappingValue(
  object: UnknownObject,
  key: string,
  path: string,
): SpeechPriorityMapping {
  const configured = objectValue(object, key, path);
  const mapping = Object.create(null) as Record<string, number>;
  for (const [configuredKey, configuredPriority] of Object.entries(configured)) {
    const priority =
      typeof configuredPriority === "string"
        ? Number(configuredPriority)
        : configuredPriority;
    const normalizedKey = configuredKey.trim().toLowerCase();
    if (
      normalizedKey.length === 0 ||
      typeof priority !== "number" ||
      !Number.isSafeInteger(priority)
    ) {
      throw new SpeechConfigurationError(
        `${path} keys must be non-empty and values must be safe integers`,
      );
    }
    mapping[normalizedKey] = priority;
  }
  return Object.freeze(mapping);
}

function stringArrayValue(
  object: UnknownObject,
  key: string,
  path: string,
  fallback: readonly string[],
): readonly string[] {
  const value = object[key];
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new SpeechConfigurationError(`${path} must be an array of strings`);
  }
  return value;
}

function adapterLimits(
  section: UnknownObject,
  path: string,
  requestTimeoutMs: number,
): { readonly timeoutMs: number; readonly maxDownloadBytes: number } {
  const timeoutMs = integerValue(
    section,
    "timeout_ms",
    `${path}.timeout_ms`,
    requestTimeoutMs,
  );
  const maxDownloadBytes = integerValue(
    section,
    "max_download_bytes",
    `${path}.max_download_bytes`,
    32 * 1024 * 1024,
  );
  if (timeoutMs < 1) {
    throw new SpeechConfigurationError(`${path}.timeout_ms must be positive`);
  }
  if (maxDownloadBytes < 1) {
    throw new SpeechConfigurationError(
      `${path}.max_download_bytes must be positive`,
    );
  }
  return { timeoutMs, maxDownloadBytes };
}

function gradioTransport(
  section: UnknownObject,
  path: string,
): GradioTransport | undefined {
  const transport = optionalString(section, "transport", `${path}.transport`);
  if (transport === undefined) {
    return undefined;
  }
  if (transport !== "websocket" && transport !== "http") {
    throw new SpeechConfigurationError(
      `${path}.transport must be "websocket" or "http"`,
    );
  }
  return transport;
}

function configuredPath(cwd: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function speechEngine(config: UnknownObject): string {
  const configured = optionalString(
    config,
    "audio_synthesis_type",
    "audio_synthesis_type",
  );
  return (configured ?? "none").trim().toLowerCase();
}

export function resolveSpeechRuntimeSettings(
  config: JsonObject,
  cwd: string,
): SpeechRuntimeSettings {
  const root = config as UnknownObject;
  const speech = objectValue(root, "speech");
  const playAudio = objectValue(root, "play_audio");
  const engine = speechEngine(root);
  const speechEnabled = booleanValue(speech, "enabled", "speech.enabled", true);
  const playbackEnabled = booleanValue(
    playAudio,
    "enable",
    "play_audio.enable",
    true,
  );

  const configuredOutput =
    optionalString(speech, "output_path", "speech.output_path") ??
    optionalString(playAudio, "out_path", "play_audio.out_path");
  const outputDirectory = configuredPath(cwd, configuredOutput ?? "out");
  const configuredTemporary = optionalString(
    speech,
    "temp_path",
    "speech.temp_path",
  );
  const temporaryDirectory = configuredPath(
    cwd,
    configuredTemporary ?? resolve(tmpdir(), "ai-vtuber-speech"),
  );
  const preserveOutput = booleanValue(
    speech,
    "preserve_output",
    "speech.preserve_output",
    configuredOutput !== undefined,
  );

  const queueCapacity = integerValue(
    speech,
    "queue_capacity",
    "speech.queue_capacity",
    50,
  );
  if (queueCapacity < 1 || queueCapacity > 100_000) {
    throw new SpeechConfigurationError(
      "speech.queue_capacity must be an integer between 1 and 100000",
    );
  }
  const queueStartThreshold = integerValue(
    speech,
    "queue_start_threshold",
    "speech.queue_start_threshold",
    0,
  );
  if (queueStartThreshold < 0 || queueStartThreshold > queueCapacity) {
    throw new SpeechConfigurationError(
      "speech.queue_start_threshold must be between 0 and speech.queue_capacity",
    );
  }
  const priorityMapping = priorityMappingValue(
    speech,
    "priority_mapping",
    "speech.priority_mapping",
  );

  const admissionWaiterCapacity = integerValue(
    speech,
    "admission_waiter_capacity",
    "speech.admission_waiter_capacity",
    queueCapacity,
  );
  if (admissionWaiterCapacity < 0 || admissionWaiterCapacity > 100_000) {
    throw new SpeechConfigurationError(
      "speech.admission_waiter_capacity must be an integer between 0 and 100000",
    );
  }

  const maxAudioBytes = integerValue(
    speech,
    "max_audio_bytes",
    "speech.max_audio_bytes",
    32 * 1024 * 1024,
  );
  if (maxAudioBytes < 1 || maxAudioBytes > 1024 * 1024 * 1024) {
    throw new SpeechConfigurationError(
      "speech.max_audio_bytes must be between 1 and 1073741824",
    );
  }

  const intervalNumMin = integerValue(
    playAudio,
    "interval_num_min",
    "play_audio.interval_num_min",
    1,
  );
  const intervalNumMax = integerValue(
    playAudio,
    "interval_num_max",
    "play_audio.interval_num_max",
    2,
  );
  if (
    intervalNumMin < 1 ||
    intervalNumMax < intervalNumMin ||
    intervalNumMax > 10_000
  ) {
    throw new SpeechConfigurationError(
      "play_audio interval_num_min/max must be positive integers with min <= max <= 10000",
    );
  }

  const normalIntervalMinSeconds = numberValue(
    playAudio,
    "normal_interval_min",
    "play_audio.normal_interval_min",
    0.3,
  );
  const normalIntervalMaxSeconds = numberValue(
    playAudio,
    "normal_interval_max",
    "play_audio.normal_interval_max",
    0.5,
  );
  if (
    normalIntervalMinSeconds < 0 ||
    normalIntervalMaxSeconds < normalIntervalMinSeconds ||
    normalIntervalMaxSeconds > 3_600
  ) {
    throw new SpeechConfigurationError(
      "play_audio normal_interval_min/max must satisfy 0 <= min <= max <= 3600 seconds",
    );
  }
  const textSplit: SpeechTextSplitOptions = {
    enabled: booleanValue(
      playAudio,
      "text_split_enable",
      "play_audio.text_split_enable",
      false,
    ),
    intervalNumMin,
    intervalNumMax,
    normalIntervalMinMs: Math.round(normalIntervalMinSeconds * 1_000),
    normalIntervalMaxMs: Math.round(normalIntervalMaxSeconds * 1_000),
  };

  const requestTimeoutMs = integerValue(
    speech,
    "request_timeout_ms",
    "speech.request_timeout_ms",
    60_000,
  );
  if (requestTimeoutMs < 1 || requestTimeoutMs > 3_600_000) {
    throw new SpeechConfigurationError(
      "speech.request_timeout_ms must be between 1 and 3600000",
    );
  }

  const speechPlayer = objectValue(speech, "player", "speech.player");
  const configuredPlayer = optionalString(
    playAudio,
    "player",
    "play_audio.player",
  );
  const explicitExecutable =
    optionalString(speechPlayer, "executable", "speech.player.executable") ??
    optionalString(playAudio, "executable", "play_audio.executable");
  let executable = explicitExecutable;
  if (executable === undefined) {
    executable =
      configuredPlayer === undefined ||
        configuredPlayer === "pygame" ||
        configuredPlayer === "ffplay"
        ? "ffplay"
        : configuredPlayer;
  }
  if (executable.trim().length === 0) {
    throw new SpeechConfigurationError(
      "speech.player.executable must not be empty",
    );
  }

  const args = stringArrayValue(
    speechPlayer,
    "args",
    "speech.player.args",
    ["-nodisp", "-autoexit", "-loglevel", "error", "{audio}"],
  );

  return {
    enabled: speechEnabled && playbackEnabled && engine !== "none",
    playbackEnabled,
    engine,
    queueCapacity,
    admissionWaiterCapacity,
    queueStartThreshold,
    priorityMapping,
    requestTimeoutMs,
    maxAudioBytes,
    textSplit,
    outputDirectory,
    temporaryDirectory,
    preserveOutput,
    player: { executable, args },
  };
}

function canonicalEngine(engine: string): (typeof SUPPORTED_ENGINES)[number] {
  const canonical = ENGINE_ALIASES[engine];
  if (canonical === undefined) {
    throw new SpeechConfigurationError(
      `Unsupported audio_synthesis_type ${JSON.stringify(engine)}. Supported engines: ${SUPPORTED_ENGINES.join(", ")}`,
    );
  }
  return canonical;
}

export function createSpeechSynthesizer(
  config: JsonObject,
  cwd: string,
  fetchImpl: SpeechFetch = globalThis.fetch,
): SpeechSynthesizer {
  const root = config as UnknownObject;
  const settings = resolveSpeechRuntimeSettings(config, cwd);
  if (!settings.enabled) {
    return new DisabledSpeechSynthesizer(
      settings.engine === "none"
        ? "audio_synthesis_type is none"
        : "speech or audio playback is disabled",
    );
  }

  const engine = canonicalEngine(settings.engine);
  switch (engine) {
    case "none":
      return new DisabledSpeechSynthesizer("audio_synthesis_type is none");
    case "edge-tts": {
      const section = objectValue(root, "edge-tts", "edge-tts");
      const pitch = optionalString(section, "pitch", "edge-tts.pitch");
      const proxy = optionalString(section, "proxy", "edge-tts.proxy");
      const endpoint = optionalString(section, "endpoint", "edge-tts.endpoint");
      const trustedClientToken = optionalString(
        section,
        "trusted_client_token",
        "edge-tts.trusted_client_token",
      );
      const chromiumVersion = optionalString(
        section,
        "chromium_version",
        "edge-tts.chromium_version",
      );
      return new EdgeSpeechSynthesizer({
        voice: stringValue(section, "voice", "edge-tts.voice"),
        rate: stringValue(section, "rate", "edge-tts.rate", "+0%"),
        volume: stringValue(section, "volume", "edge-tts.volume", "+0%"),
        ...(pitch === undefined ? {} : { pitch }),
        ...(proxy === undefined ? {} : { proxy }),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(trustedClientToken === undefined ? {} : { trustedClientToken }),
        ...(chromiumVersion === undefined ? {} : { chromiumVersion }),
      });
    }
    case "azure_tts": {
      const section = objectValue(root, "azure_tts", "azure_tts");
      const endpoint = optionalString(section, "endpoint", "azure_tts.endpoint");
      const outputFormat = optionalString(
        section,
        "output_format",
        "azure_tts.output_format",
      );
      const rate = optionalString(section, "rate", "azure_tts.rate");
      const volume = optionalString(section, "volume", "azure_tts.volume");
      return new AzureSpeechSynthesizer(
        {
          subscriptionKey: stringValue(
            section,
            "subscription_key",
            "azure_tts.subscription_key",
          ),
          region: stringValue(section, "region", "azure_tts.region"),
          voiceName: stringValue(
            section,
            "voice_name",
            "azure_tts.voice_name",
          ),
          ...(endpoint === undefined ? {} : { endpoint }),
          ...(outputFormat === undefined ? {} : { outputFormat }),
          ...(rate === undefined ? {} : { rate }),
          ...(volume === undefined ? {} : { volume }),
        },
        fetchImpl,
      );
    }
    case "openai_tts": {
      const section = objectValue(root, "openai_tts", "openai_tts");
      const responseFormat =
        optionalString(section, "response_format", "openai_tts.response_format") ??
        optionalString(section, "format", "openai_tts.format");
      const organization = optionalString(
        section,
        "organization",
        "openai_tts.organization",
      );
      const configuredSpeed = section.speed;
      const speed =
        configuredSpeed === undefined
          ? undefined
          : numberValue(section, "speed", "openai_tts.speed", 1);
      return new OpenAiSpeechSynthesizer(
        {
          type: stringValue(section, "type", "openai_tts.type", "api"),
          apiBase: stringValue(
            section,
            "api_ip_port",
            "openai_tts.api_ip_port",
          ),
          model: stringValue(section, "model", "openai_tts.model"),
          voice: stringValue(section, "voice", "openai_tts.voice"),
          apiKey: stringValue(section, "api_key", "openai_tts.api_key"),
          ...(responseFormat === undefined ? {} : { responseFormat }),
          ...(speed === undefined ? {} : { speed }),
          ...(organization === undefined ? {} : { organization }),
        },
        fetchImpl,
      );
    }
    case "vits": {
      const section = objectValue(root, "vits", "vits");
      const type = stringValue(section, "type", "vits.type", "vits");
      if (type !== "vits" && type !== "bert_vits2") {
        throw new SpeechConfigurationError(
          `vits.type ${JSON.stringify(type)} is unsupported by the Node HTTP adapter`,
        );
      }
      const adapterConfig: LegacyHttpSpeechConfig = {
        engine,
        type,
        apiBase: stringValue(section, "api_ip_port", "vits.api_ip_port"),
        id: stringValue(section, "id", "vits.id", "0"),
        format: stringValue(section, "format", "vits.format", "wav"),
        language: stringValue(section, "lang", "vits.lang", "自动"),
        length: String(section.length ?? "1"),
        noise: String(section.noise ?? "0.33"),
        noiseW: String(section.noisew ?? "0.4"),
        max: String(section.max ?? "50"),
        sdpRatio: String(section.sdp_radio ?? "0.2"),
      };
      return new LegacyHttpSpeechSynthesizer(adapterConfig, fetchImpl);
    }
    case "bert_vits2": {
      const section = objectValue(root, "bert_vits2", "bert_vits2");
      const type = stringValue(section, "type", "bert_vits2.type", "hiyori");
      if (type !== "hiyori") {
        throw new SpeechConfigurationError(
          `bert_vits2.type ${JSON.stringify(type)} is unsupported; only "hiyori" is supported`,
        );
      }
      const adapterConfig: LegacyHttpSpeechConfig = {
        engine,
        apiBase: stringValue(
          section,
          "api_ip_port",
          "bert_vits2.api_ip_port",
        ),
        modelId: integerValue(section, "model_id", "bert_vits2.model_id", 0),
        speakerName: stringValue(
          section,
          "speaker_name",
          "bert_vits2.speaker_name",
        ),
        speakerId: integerValue(
          section,
          "speaker_id",
          "bert_vits2.speaker_id",
          0,
        ),
        language: stringValue(
          section,
          "language",
          "bert_vits2.language",
          "auto",
        ),
        length: legacyRangeNumber(section, "length", "bert_vits2.length", 1),
        noise: legacyRangeNumber(section, "noise", "bert_vits2.noise", 0.2),
        noiseW: legacyRangeNumber(
          section,
          "noisew",
          "bert_vits2.noisew",
          0.9,
        ),
        sdpRatio: legacyRangeNumber(
          section,
          "sdp_radio",
          "bert_vits2.sdp_radio",
          0.2,
        ),
        autoTranslate: booleanValue(
          section,
          "auto_translate",
          "bert_vits2.auto_translate",
          false,
        ),
        autoSplit: booleanValue(
          section,
          "auto_split",
          "bert_vits2.auto_split",
          false,
        ),
        emotion: optionalString(section, "emotion", "bert_vits2.emotion") ?? "",
        styleText:
          optionalString(section, "style_text", "bert_vits2.style_text") ?? "",
        styleWeight: legacyRangeNumber(
          section,
          "style_weight",
          "bert_vits2.style_weight",
          0.7,
        ),
      };
      return new LegacyHttpSpeechSynthesizer(adapterConfig, fetchImpl);
    }
    case "gpt_sovits": {
      const section = objectValue(root, "gpt_sovits", "gpt_sovits");
      const type = stringValue(
        section,
        "type",
        "gpt_sovits.type",
        "api",
      );
      const limits = adapterLimits(
        section,
        "gpt_sovits",
        settings.requestTimeoutMs,
      );
      if (type === "api") {
        const adapterConfig: LegacyRestSpeechConfig = {
          engine,
          variant: "api",
          apiBase: stringValue(
            section,
            "api_ip_port",
            "gpt_sovits.api_ip_port",
          ),
          refAudioPath: stringValue(
            section,
            "ref_audio_path",
            "gpt_sovits.ref_audio_path",
          ),
          promptText:
            optionalString(
              section,
              "prompt_text",
              "gpt_sovits.prompt_text",
            ) ?? "",
          promptLanguage: stringValue(
            section,
            "prompt_language",
            "gpt_sovits.prompt_language",
          ),
          language: stringValue(
            section,
            "language",
            "gpt_sovits.language",
          ),
          ...limits,
        };
        return new LegacyRestSpeechSynthesizer(adapterConfig, fetchImpl);
      }
      if (type === "api_0322" || type === "gradio_0322") {
        const api = objectValue(section, "api_0322", "gpt_sovits.api_0322");
        const parameters: Readonly<Record<string, unknown>> = {
          text_lang: stringValue(
            api,
            "text_lang",
            "gpt_sovits.api_0322.text_lang",
          ),
          ref_audio_path: stringValue(
            api,
            "ref_audio_path",
            "gpt_sovits.api_0322.ref_audio_path",
          ),
          prompt_text:
            optionalString(
              api,
              "prompt_text",
              "gpt_sovits.api_0322.prompt_text",
            ) ?? "",
          prompt_lang: stringValue(
            api,
            "prompt_lang",
            "gpt_sovits.api_0322.prompt_lang",
          ),
          top_k: integerValue(api, "top_k", "gpt_sovits.api_0322.top_k", 5),
          top_p: numberValue(api, "top_p", "gpt_sovits.api_0322.top_p", 1),
          temperature: numberValue(
            api,
            "temperature",
            "gpt_sovits.api_0322.temperature",
            1,
          ),
          text_split_method: stringValue(
            api,
            "text_split_method",
            "gpt_sovits.api_0322.text_split_method",
            "cut0",
          ),
          batch_size: integerValue(
            api,
            "batch_size",
            "gpt_sovits.api_0322.batch_size",
            1,
          ),
          speed_factor: numberValue(
            api,
            "speed_factor",
            "gpt_sovits.api_0322.speed_factor",
            1,
          ),
          split_bucket: booleanValue(
            api,
            "split_bucket",
            "gpt_sovits.api_0322.split_bucket",
            true,
          ),
          return_fragment: booleanValue(
            api,
            "return_fragment",
            "gpt_sovits.api_0322.return_fragment",
            false,
          ),
          fragment_interval: numberValue(
            api,
            "fragment_interval",
            "gpt_sovits.api_0322.fragment_interval",
            0.3,
          ),
        };
        if (type === "gradio_0322") {
          const transport = gradioTransport(section, "gpt_sovits");
          const adapterConfig: LegacyGradioSpeechConfig = {
            engine,
            apiBase: stringValue(
              section,
              "gradio_ip_port",
              "gpt_sovits.gradio_ip_port",
            ),
            cwd,
            parameters,
            ...limits,
            ...(transport === undefined ? {} : { transport }),
          };
          return new LegacyGradioSpeechSynthesizer(adapterConfig, fetchImpl);
        }
        const adapterConfig: LegacyRestSpeechConfig = {
          engine,
          variant: "api_0322",
          apiBase: stringValue(
            section,
            "api_ip_port",
            "gpt_sovits.api_ip_port",
          ),
          parameters,
          ...limits,
        };
        return new LegacyRestSpeechSynthesizer(adapterConfig, fetchImpl);
      }
      if (type === "api_0706") {
        const api = objectValue(section, "api_0706", "gpt_sovits.api_0706");
        const configuredTextLanguage = stringValue(
          api,
          "text_language",
          "gpt_sovits.api_0706.text_language",
        );
        const adapterConfig: LegacyRestSpeechConfig = {
          engine,
          variant: "api_0706",
          apiBase: stringValue(
            section,
            "api_ip_port",
            "gpt_sovits.api_ip_port",
          ),
          parameters: {
            refer_wav_path: stringValue(
              api,
              "refer_wav_path",
              "gpt_sovits.api_0706.refer_wav_path",
            ),
            text_language:
              configuredTextLanguage === "自动识别"
                ? "auto"
                : configuredTextLanguage,
            prompt_text:
              optionalString(
                api,
                "prompt_text",
                "gpt_sovits.api_0706.prompt_text",
              ) ?? "",
            prompt_language: stringValue(
              api,
              "prompt_language",
              "gpt_sovits.api_0706.prompt_language",
            ),
            cut_punc:
              optionalString(
                api,
                "cut_punc",
                "gpt_sovits.api_0706.cut_punc",
              ) ?? "",
          },
          ...limits,
        };
        return new LegacyRestSpeechSynthesizer(adapterConfig, fetchImpl);
      }
      if (type === "v2_api_0821") {
        const api = objectValue(
          section,
          "v2_api_0821",
          "gpt_sovits.v2_api_0821",
        );
        const mediaType = stringValue(
          api,
          "media_type",
          "gpt_sovits.v2_api_0821.media_type",
          "wav",
        );
        const adapterConfig: LegacyRestSpeechConfig = {
          engine,
          variant: "v2_api_0821",
          apiBase: stringValue(
            section,
            "api_ip_port",
            "gpt_sovits.api_ip_port",
          ),
          mediaType,
          parameters: {
            text_lang: stringValue(
              api,
              "text_lang",
              "gpt_sovits.v2_api_0821.text_lang",
              "zh",
            ),
            ref_audio_path: stringValue(
              api,
              "ref_audio_path",
              "gpt_sovits.v2_api_0821.ref_audio_path",
            ),
            aux_ref_audio_paths: stringArrayValue(
              api,
              "aux_ref_audio_paths",
              "gpt_sovits.v2_api_0821.aux_ref_audio_paths",
              [],
            ),
            prompt_text:
              optionalString(
                api,
                "prompt_text",
                "gpt_sovits.v2_api_0821.prompt_text",
              ) ?? "",
            prompt_lang: stringValue(
              api,
              "prompt_lang",
              "gpt_sovits.v2_api_0821.prompt_lang",
              "zh",
            ),
            top_k: integerValue(
              api,
              "top_k",
              "gpt_sovits.v2_api_0821.top_k",
              5,
            ),
            top_p: numberValue(
              api,
              "top_p",
              "gpt_sovits.v2_api_0821.top_p",
              1,
            ),
            temperature: numberValue(
              api,
              "temperature",
              "gpt_sovits.v2_api_0821.temperature",
              1,
            ),
            text_split_method: stringValue(
              api,
              "text_split_method",
              "gpt_sovits.v2_api_0821.text_split_method",
              "cut0",
            ),
            batch_size: integerValue(
              api,
              "batch_size",
              "gpt_sovits.v2_api_0821.batch_size",
              1,
            ),
            split_bucket: booleanValue(
              api,
              "split_bucket",
              "gpt_sovits.v2_api_0821.split_bucket",
              true,
            ),
            speed_factor: numberValue(
              api,
              "speed_factor",
              "gpt_sovits.v2_api_0821.speed_factor",
              1,
            ),
            fragment_interval: numberValue(
              api,
              "fragment_interval",
              "gpt_sovits.v2_api_0821.fragment_interval",
              0.3,
            ),
            seed: integerValue(
              api,
              "seed",
              "gpt_sovits.v2_api_0821.seed",
              -1,
            ),
            media_type: mediaType,
            streaming_mode: booleanValue(
              api,
              "streaming_mode",
              "gpt_sovits.v2_api_0821.streaming_mode",
              false,
            ),
            parallel_infer: booleanValue(
              api,
              "parallel_infer",
              "gpt_sovits.v2_api_0821.parallel_infer",
              true,
            ),
            repetition_penalty: numberValue(
              api,
              "repetition_penalty",
              "gpt_sovits.v2_api_0821.repetition_penalty",
              1.35,
            ),
          },
          ...limits,
        };
        return new LegacyRestSpeechSynthesizer(adapterConfig, fetchImpl);
      }
      if (type === "webtts") {
        const web = objectValue(section, "webtts", "gpt_sovits.webtts");
        const version = stringValue(
          web,
          "version",
          "gpt_sovits.webtts.version",
          "1",
        );
        const emotion = optionalString(
          web,
          "emotion",
          "gpt_sovits.webtts.emotion",
        );
        const parameters: Record<string, string | number | boolean> = {
          version,
          spk: stringValue(web, "spk", "gpt_sovits.webtts.spk"),
          lang: stringValue(web, "lang", "gpt_sovits.webtts.lang"),
          speed: legacyRangeNumber(
            web,
            "speed",
            "gpt_sovits.webtts.speed",
            1,
          ),
          ...(emotion === undefined || emotion.length === 0
            ? {}
            : { emotion }),
        };
        const adapterConfig: LegacyRestSpeechConfig = {
          engine,
          variant: "webtts",
          apiBase: stringValue(
            web,
            "api_ip_port",
            "gpt_sovits.webtts.api_ip_port",
          ),
          version,
          parameters,
          ...limits,
        };
        return new LegacyRestSpeechSynthesizer(adapterConfig, fetchImpl);
      }
      throw new SpeechConfigurationError(
        `gpt_sovits.type ${JSON.stringify(type)} is unsupported; use "api", "api_0322", "gradio_0322", "api_0706", "v2_api_0821", or "webtts"`,
      );
    }
  }
}
