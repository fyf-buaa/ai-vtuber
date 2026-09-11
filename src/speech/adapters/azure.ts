import type { SpeechRequest } from "../../domain/types.js";
import { SpeechConfigurationError } from "../errors.js";
import { fetchAudio, requireHttpUrl } from "../http.js";
import type { SpeechFetch, SpeechSynthesizer, SynthesizedAudio } from "../types.js";

export interface AzureSpeechConfig {
  readonly subscriptionKey: string;
  readonly region: string;
  readonly voiceName: string;
  readonly endpoint?: string;
  readonly outputFormat?: string;
  readonly rate?: string;
  readonly volume?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function validXmlText(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu,
    "",
  );
}

function azureExtension(outputFormat: string): string {
  if (outputFormat.includes("riff")) {
    return "wav";
  }
  if (outputFormat.includes("ogg")) {
    return "ogg";
  }
  if (outputFormat.includes("webm")) {
    return "webm";
  }
  if (outputFormat.includes("flac")) {
    return "flac";
  }
  if (outputFormat.includes("raw")) {
    return "pcm";
  }
  return "mp3";
}

export class AzureSpeechSynthesizer implements SpeechSynthesizer {
  readonly name = "azure_tts";

  readonly #fetch: SpeechFetch;
  readonly #endpoint: URL;
  readonly #subscriptionKey: string;
  readonly #voiceName: string;
  readonly #locale: string;
  readonly #outputFormat: string;
  readonly #rate: string | undefined;
  readonly #volume: string | undefined;

  constructor(config: AzureSpeechConfig, fetchImpl: SpeechFetch = globalThis.fetch) {
    if (config.subscriptionKey.trim().length === 0) {
      throw new SpeechConfigurationError("azure_tts.subscription_key must not be empty");
    }
    if (!/^[a-z0-9-]+$/iu.test(config.region)) {
      throw new SpeechConfigurationError(
        "azure_tts.region must contain only letters, digits, and hyphens",
      );
    }
    if (config.voiceName.trim().length === 0) {
      throw new SpeechConfigurationError("azure_tts.voice_name must not be empty");
    }

    const endpoint =
      config.endpoint ??
      `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    this.#endpoint = requireHttpUrl(endpoint, "azure_tts.endpoint");
    this.#fetch = fetchImpl;
    this.#subscriptionKey = config.subscriptionKey;
    this.#voiceName = config.voiceName;
    this.#locale = /^([a-z]{2,3}-[A-Z]{2})-/u.exec(config.voiceName)?.[1] ?? "en-US";
    this.#outputFormat =
      config.outputFormat ?? "audio-24khz-48kbitrate-mono-mp3";
    this.#rate = config.rate;
    this.#volume = config.volume;
  }

  async synthesize(
    request: SpeechRequest,
    signal: AbortSignal,
  ): Promise<SynthesizedAudio> {
    const escapedText = escapeXml(validXmlText(request.text));
    const prosodyAttributes = [
      this.#rate === undefined ? undefined : `rate='${escapeXml(this.#rate)}'`,
      this.#volume === undefined
        ? undefined
        : `volume='${escapeXml(this.#volume)}'`,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" ");
    const speech =
      prosodyAttributes.length === 0
        ? escapedText
        : `<prosody ${prosodyAttributes}>${escapedText}</prosody>`;
    const ssml =
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' ` +
      `xml:lang='${escapeXml(this.#locale)}'><voice name='${escapeXml(this.#voiceName)}'>` +
      `${speech}</voice></speak>`;

    return fetchAudio(
      this.#fetch,
      "Azure speech",
      this.#endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/ssml+xml",
          "ocp-apim-subscription-key": this.#subscriptionKey,
          "user-agent": "AI-Vtuber-Node",
          "x-microsoft-outputformat": this.#outputFormat,
        },
        body: ssml,
      },
      signal,
      azureExtension(this.#outputFormat),
    );
  }
}
