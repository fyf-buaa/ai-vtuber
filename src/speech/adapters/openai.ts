import type { SpeechRequest } from "../../domain/types.js";
import { SpeechConfigurationError } from "../errors.js";
import { appendUrlPath, fetchAudio, requireHttpUrl } from "../http.js";
import type { SpeechFetch, SpeechSynthesizer, SynthesizedAudio } from "../types.js";

export interface OpenAiSpeechConfig {
  readonly type: string;
  readonly apiBase: string;
  readonly apiKey: string;
  readonly model: string;
  readonly voice: string;
  readonly responseFormat?: string;
  readonly speed?: number;
  readonly organization?: string;
}

const OPENAI_FORMATS: Readonly<Record<string, true>> = {
  mp3: true,
  opus: true,
  aac: true,
  flac: true,
  wav: true,
  pcm: true,
};

export class OpenAiSpeechSynthesizer implements SpeechSynthesizer {
  readonly name = "openai_tts";

  readonly #fetch: SpeechFetch;
  readonly #endpoint: URL;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #voice: string;
  readonly #responseFormat: string;
  readonly #speed: number | undefined;
  readonly #organization: string | undefined;

  constructor(config: OpenAiSpeechConfig, fetchImpl: SpeechFetch = globalThis.fetch) {
    if (config.type !== "api") {
      throw new SpeechConfigurationError(
        `openai_tts.type ${JSON.stringify(config.type)} is unsupported; only "api" is supported`,
      );
    }
    if (config.apiKey.trim().length === 0) {
      throw new SpeechConfigurationError("openai_tts.api_key must not be empty");
    }
    if (config.model.trim().length === 0) {
      throw new SpeechConfigurationError("openai_tts.model must not be empty");
    }
    if (config.voice.trim().length === 0) {
      throw new SpeechConfigurationError("openai_tts.voice must not be empty");
    }

    const format = config.responseFormat ?? "mp3";
    if (OPENAI_FORMATS[format] !== true) {
      throw new SpeechConfigurationError(
        `openai_tts.response_format ${JSON.stringify(format)} is unsupported`,
      );
    }
    if (
      config.speed !== undefined &&
      (!Number.isFinite(config.speed) || config.speed < 0.25 || config.speed > 4)
    ) {
      throw new SpeechConfigurationError(
        "openai_tts.speed must be a finite number between 0.25 and 4",
      );
    }

    this.#fetch = fetchImpl;
    this.#endpoint = appendUrlPath(
      requireHttpUrl(config.apiBase, "openai_tts.api_ip_port"),
      "audio/speech",
    );
    this.#apiKey = config.apiKey;
    this.#model = config.model;
    this.#voice = config.voice;
    this.#responseFormat = format;
    this.#speed = config.speed;
    this.#organization = config.organization;
  }

  async synthesize(
    request: SpeechRequest,
    signal: AbortSignal,
  ): Promise<SynthesizedAudio> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      "content-type": "application/json",
    };
    if (this.#organization !== undefined && this.#organization.length > 0) {
      headers["openai-organization"] = this.#organization;
    }

    return fetchAudio(
      this.#fetch,
      "OpenAI-compatible speech",
      this.#endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.#model,
          voice: this.#voice,
          input: request.text,
          response_format: this.#responseFormat,
          ...(this.#speed === undefined ? {} : { speed: this.#speed }),
        }),
      },
      signal,
      this.#responseFormat === "pcm" ? "pcm" : this.#responseFormat,
    );
  }
}
