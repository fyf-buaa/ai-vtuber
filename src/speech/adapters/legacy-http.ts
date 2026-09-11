import type { SpeechRequest } from "../../domain/types.js";
import { SpeechConfigurationError } from "../errors.js";
import { appendUrlPath, fetchAudio, requireHttpUrl } from "../http.js";
import type { SpeechFetch, SpeechSynthesizer, SynthesizedAudio } from "../types.js";

interface VitsConfig {
  readonly engine: "vits";
  readonly apiBase: string;
  readonly type: "vits" | "bert_vits2";
  readonly id: string;
  readonly format: string;
  readonly language: string;
  readonly length: string;
  readonly noise: string;
  readonly noiseW: string;
  readonly max: string;
  readonly sdpRatio: string;
}

interface BertVitsConfig {
  readonly engine: "bert_vits2";
  readonly apiBase: string;
  readonly modelId: number;
  readonly speakerName: string;
  readonly speakerId: number;
  readonly language: string;
  readonly length: number;
  readonly noise: number;
  readonly noiseW: number;
  readonly sdpRatio: number;
  readonly autoTranslate: boolean;
  readonly autoSplit: boolean;
  readonly emotion: string;
  readonly styleText: string;
  readonly styleWeight: number;
}

export type LegacyHttpSpeechConfig = VitsConfig | BertVitsConfig;

function normalizeVitsLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  const languageByLegacyName: Record<string, string> = {
    "中文": "zh",
    "汉语": "zh",
    "英文": "en",
    "英语": "en",
    "韩文": "ko",
    "韩语": "ko",
    "日文": "ja",
    "日语": "ja",
    "自动": "auto",
    "自动识别": "auto",
  };
  return languageByLegacyName[language.trim()] ?? (normalized || "auto");
}

function assertExtension(value: string, key: string): string {
  const extension = value.replace(/^\./u, "").toLowerCase();
  if (!/^[a-z0-9]{2,8}$/u.test(extension)) {
    throw new SpeechConfigurationError(`${key} is not a safe audio format`);
  }
  return extension;
}

export class LegacyHttpSpeechSynthesizer implements SpeechSynthesizer {
  readonly name: string;

  readonly #config: LegacyHttpSpeechConfig;
  readonly #fetch: SpeechFetch;
  readonly #baseUrl: URL;

  constructor(
    config: LegacyHttpSpeechConfig,
    fetchImpl: SpeechFetch = globalThis.fetch,
  ) {
    this.name = config.engine;
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#baseUrl = requireHttpUrl(
      config.apiBase,
      `${config.engine}.api_ip_port`,
    );

    if (config.engine === "vits") {
      assertExtension(config.format, "vits.format");
    }
  }

  async synthesize(
    request: SpeechRequest,
    signal: AbortSignal,
  ): Promise<SynthesizedAudio> {
    switch (this.#config.engine) {
      case "vits":
        return this.#synthesizeVits(request, signal, this.#config);
      case "bert_vits2":
        return this.#synthesizeBertVits(request, signal, this.#config);
    }
  }

  async #synthesizeVits(
    request: SpeechRequest,
    signal: AbortSignal,
    config: VitsConfig,
  ): Promise<SynthesizedAudio> {
    const route = config.type === "bert_vits2" ? "voice/bert-vits2" : "voice/vits";
    const endpoint = appendUrlPath(this.#baseUrl, route);
    const parameters: Record<string, string> = {
      text: request.text,
      id: config.id,
      format: config.format,
      lang: normalizeVitsLanguage(config.language),
      length: config.length,
      noise: config.noise,
      noisew: config.noiseW,
      max: config.max,
    };
    if (config.type === "bert_vits2") {
      parameters.sdp_radio = config.sdpRatio;
    }
    for (const [key, value] of Object.entries(parameters)) {
      endpoint.searchParams.set(key, value);
    }
    return fetchAudio(
      this.#fetch,
      "VITS",
      endpoint,
      { method: "GET" },
      signal,
      assertExtension(config.format, "vits.format"),
    );
  }

  async #synthesizeBertVits(
    request: SpeechRequest,
    signal: AbortSignal,
    config: BertVitsConfig,
  ): Promise<SynthesizedAudio> {
    const endpoint = appendUrlPath(this.#baseUrl, "voice");
    const parameters: Record<string, string> = {
      text: request.text,
      model_id: String(config.modelId),
      speaker_name: config.speakerName,
      speaker_id: String(config.speakerId),
      language: config.language,
      length: String(config.length),
      noise: String(config.noise),
      noisew: String(config.noiseW),
      sdp_radio: String(config.sdpRatio),
      auto_translate: String(config.autoTranslate),
      auto_split: String(config.autoSplit),
      emotion: config.emotion,
      style_text: config.styleText,
      style_weight: String(config.styleWeight),
    };
    for (const [key, value] of Object.entries(parameters)) {
      endpoint.searchParams.set(key, value);
    }
    return fetchAudio(
      this.#fetch,
      "Bert-VITS2",
      endpoint,
      { method: "GET" },
      signal,
      "wav",
    );
  }
}
