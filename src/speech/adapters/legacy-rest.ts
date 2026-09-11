import type { SpeechRequest } from "../../domain/types.js";
import { SpeechConfigurationError } from "../errors.js";
import { appendUrlPath, fetchAudio, requireHttpUrl } from "../http.js";
import type { SpeechFetch, SpeechSynthesizer, SynthesizedAudio } from "../types.js";
import {
  DEFAULT_MAX_AUDIO_BYTES,
  fetchJson,
  remoteHttpUrl,
  safeAudioExtension,
} from "./bounded-http.js";
import { detectLegacyLanguage } from "./legacy-language.js";

interface RequestLimits {
  readonly timeoutMs: number;
  readonly maxDownloadBytes?: number;
}

interface GptSovitsBaseConfig extends RequestLimits {
  readonly engine: "gpt_sovits";
  readonly apiBase: string;
}

export interface GptSovitsLegacyApiConfig extends GptSovitsBaseConfig {
  readonly variant: "api";
  readonly refAudioPath: string;
  readonly promptText: string;
  readonly promptLanguage: string;
  readonly language: string;
}

export interface GptSovits0322Config extends GptSovitsBaseConfig {
  readonly variant: "api_0322";
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface GptSovits0706Config extends GptSovitsBaseConfig {
  readonly variant: "api_0706";
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface GptSovitsV2Config extends GptSovitsBaseConfig {
  readonly variant: "v2_api_0821";
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly mediaType: string;
}

export interface GptSovitsWebTtsConfig extends GptSovitsBaseConfig {
  readonly variant: "webtts";
  readonly version: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
}

export type GptSovitsRestConfig =
  | GptSovitsLegacyApiConfig
  | GptSovits0322Config
  | GptSovits0706Config
  | GptSovitsV2Config
  | GptSovitsWebTtsConfig;

export type LegacyRestSpeechConfig = GptSovitsRestConfig;

type UnknownObject = Readonly<Record<string, unknown>>;

function recordValue(value: unknown, label: string): UnknownObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} returned an invalid JSON object`);
  }
  return value as UnknownObject;
}

function requestSignal(
  signal: AbortSignal,
  timeoutMs: number,
): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function maximumAudioBytes(config: RequestLimits): number {
  return config.maxDownloadBytes ?? DEFAULT_MAX_AUDIO_BYTES;
}

function appendQuery(
  endpoint: URL,
  parameters: Readonly<Record<string, string | number | boolean>>,
): void {
  for (const [key, value] of Object.entries(parameters)) {
    endpoint.searchParams.set(key, String(value));
  }
}

function gptSovitsLanguage(configured: unknown, text: string): unknown {
  if (
    configured !== "自动识别" &&
    configured !== "auto" &&
    configured !== "AUTO"
  ) {
    return configured;
  }
  const language = detectLegacyLanguage(text);
  const legacyNameByLanguage: Readonly<Record<string, string>> = {
    zh: "中文",
    ja: "日文",
    en: "英文",
  };
  return legacyNameByLanguage[language];
}

export class LegacyRestSpeechSynthesizer implements SpeechSynthesizer {
  readonly name: string;

  readonly #config: LegacyRestSpeechConfig;
  readonly #fetch: SpeechFetch;
  readonly #baseUrl: URL;

  constructor(
    config: LegacyRestSpeechConfig,
    fetchImpl: SpeechFetch = globalThis.fetch,
  ) {
    this.name = config.engine;
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#baseUrl = requireHttpUrl(config.apiBase, `${config.engine}.api_ip_port`);

    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1) {
      throw new SpeechConfigurationError(
        `${config.engine}.timeout_ms must be a positive safe integer`,
      );
    }
    const maximumBytes = maximumAudioBytes(config);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new SpeechConfigurationError(
        `${config.engine}.max_download_bytes must be a positive safe integer`,
      );
    }
  }

  async synthesize(
    request: SpeechRequest,
    signal: AbortSignal,
  ): Promise<SynthesizedAudio> {
    const boundedSignal = requestSignal(signal, this.#config.timeoutMs);
    return this.#synthesizeGptSovits(request, boundedSignal, this.#config);
  }

  async #synthesizeGptSovits(
    request: SpeechRequest,
    signal: AbortSignal,
    config: GptSovitsRestConfig,
  ): Promise<SynthesizedAudio> {
    if (config.variant === "webtts") {
      return this.#synthesizeGptSovitsWebTts(request, signal, config);
    }

    let endpoint = this.#baseUrl;
    let payload: Record<string, unknown>;
    let fallbackExtension = "wav";
    switch (config.variant) {
      case "api":
        payload = {
          refer_wav_path: config.refAudioPath,
          prompt_text: config.promptText,
          prompt_language: config.promptLanguage,
          text: request.text,
          text_language: gptSovitsLanguage(config.language, request.text),
        };
        break;
      case "api_0322":
        payload = {
          ...config.parameters,
          text_lang: gptSovitsLanguage(
            config.parameters.text_lang,
            request.text,
          ),
          text: request.text,
        };
        break;
      case "api_0706":
        payload = { ...config.parameters, text: request.text };
        break;
      case "v2_api_0821":
        endpoint = appendUrlPath(this.#baseUrl, "tts");
        payload = { ...config.parameters, text: request.text };
        fallbackExtension = safeAudioExtension(`audio.${config.mediaType}`);
        break;
    }
    return fetchAudio(
      this.#fetch,
      `GPT-SoVITS ${config.variant}`,
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      signal,
      fallbackExtension,
      maximumAudioBytes(config),
    );
  }

  async #synthesizeGptSovitsWebTts(
    request: SpeechRequest,
    signal: AbortSignal,
    config: GptSovitsWebTtsConfig,
  ): Promise<SynthesizedAudio> {
    const endpoint = new URL(this.#baseUrl.href);
    appendQuery(endpoint, { ...config.parameters, text: request.text });
    if (config.version === "1" || config.version === "2") {
      return fetchAudio(
        this.#fetch,
        `GPT-SoVITS WebTTS ${config.version}`,
        endpoint,
        { method: "GET" },
        signal,
        "wav",
        maximumAudioBytes(config),
      );
    }
    if (config.version !== "1.4") {
      throw new SpeechConfigurationError(
        `gpt_sovits.webtts.version ${JSON.stringify(config.version)} is unsupported; use "1", "2", or "1.4"`,
      );
    }
    const generated = recordValue(
      await fetchJson(
        this.#fetch,
        "GPT-SoVITS WebTTS 1.4",
        endpoint,
        { method: "GET" },
        signal,
      ),
      "GPT-SoVITS WebTTS 1.4",
    );
    const audioUrl = remoteHttpUrl(
      generated.url,
      this.#baseUrl,
      "GPT-SoVITS WebTTS 1.4",
      false,
    );
    appendQuery(audioUrl, { ...config.parameters, text: request.text });
    return fetchAudio(
      this.#fetch,
      "GPT-SoVITS WebTTS 1.4 audio",
      audioUrl,
      { method: "GET" },
      signal,
      safeAudioExtension(audioUrl.pathname),
      maximumAudioBytes(config),
    );
  }

}
