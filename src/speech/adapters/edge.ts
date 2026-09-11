import { createHash, randomUUID } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import type { SpeechRequest } from "../../domain/types.js";
import {
  SpeechConfigurationError,
  abortReason,
  errorMessage,
  throwIfAborted,
} from "../errors.js";
import { fetchJson } from "./bounded-http.js";
import { DEFAULT_MAX_AUDIO_BYTES } from "../http.js";
import type {
  SpeechFetch,
  SpeechSynthesizer,
  SynthesizedAudio,
} from "../types.js";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const DEFAULT_CHROMIUM_VERSION = "143.0.3650.75";
const DEFAULT_ENDPOINT =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const DEFAULT_VOICE_LIST_ENDPOINT =
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
const VOICE_LIST_TIMEOUT_MS = 15_000;
const MAXIMUM_VOICE_COUNT = 2_000;
const MAXIMUM_VOICE_FIELD_LENGTH = 512;
const MAX_TEXT_BYTES_PER_CONNECTION = 12_000;
const WINDOWS_EPOCH_SECONDS = 11_644_473_600n;
const FILETIME_TICKS_PER_SECOND = 10_000_000n;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export interface EdgeSocket {
  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number, reason: Buffer) => void): this;
  once(
    event: "unexpected-response",
    listener: (
      request: unknown,
      response: { readonly statusCode: number; readonly statusMessage?: string },
    ) => void,
  ): this;
  on(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void,
  ): this;
  off(event: "open", listener: () => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "close", listener: (code: number, reason: Buffer) => void): this;
  off(
    event: "unexpected-response",
    listener: (
      request: unknown,
      response: { readonly statusCode: number; readonly statusMessage?: string },
    ) => void,
  ): this;
  off(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void,
  ): this;
  send(data: string): void;
  terminate(): void;
}

export type EdgeWebSocketFactory = (
  url: URL,
  options: ClientOptions,
) => EdgeSocket;

export interface EdgeSpeechConfig {
  readonly voice: string;
  readonly rate: string;
  readonly volume: string;
  readonly pitch?: string;
  readonly proxy?: string;
  readonly endpoint?: string;
  readonly trustedClientToken?: string;
  readonly chromiumVersion?: string;
}

export interface EdgeVoice {
  readonly name: string;
  readonly shortName: string;
  readonly gender: string;
  readonly locale: string;
  readonly localeName: string;
  readonly friendlyName: string;
}

export interface EdgeVoiceListOptions {
  readonly fetch?: SpeechFetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly trustedClientToken?: string;
  readonly chromiumVersion?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function edgeTimestamp(now = new Date()): string {
  const dayName = DAY_NAMES[now.getUTCDay()];
  const monthName = MONTH_NAMES[now.getUTCMonth()];
  if (dayName === undefined || monthName === undefined) {
    throw new Error("Unable to construct Edge TTS timestamp");
  }
  const day = String(now.getUTCDate()).padStart(2, "0");
  const time = [now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return `${dayName} ${monthName} ${day} ${now.getUTCFullYear()} ${time} GMT+0000 (Coordinated Universal Time)`;
}

function secMsGec(token: string, now = Date.now()): string {
  const unixSeconds = BigInt(Math.floor(now / 1_000));
  const roundedSeconds = unixSeconds - (unixSeconds % 300n);
  const filetimeTicks =
    (roundedSeconds + WINDOWS_EPOCH_SECONDS) * FILETIME_TICKS_PER_SECOND;
  return createHash("sha256")
    .update(`${filetimeTicks}${token}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

function parseHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    headers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }
  return headers;
}

function rawDataBuffer(data: RawData): Buffer {
  let buffer: Buffer;
  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (Array.isArray(data)) {
    let totalBytes = 0;
    for (const part of data) {
      if (part.byteLength > DEFAULT_MAX_AUDIO_BYTES - totalBytes) {
        throw new Error(
          `Edge TTS WebSocket frame exceeds the ${DEFAULT_MAX_AUDIO_BYTES}-byte payload limit`,
        );
      }
      totalBytes += part.byteLength;
    }
    buffer = Buffer.concat(data, totalBytes);
  } else {
    buffer = Buffer.from(data);
  }
  if (buffer.byteLength > DEFAULT_MAX_AUDIO_BYTES) {
    throw new Error(
      `Edge TTS WebSocket frame exceeds the ${DEFAULT_MAX_AUDIO_BYTES}-byte payload limit`,
    );
  }
  return buffer;
}

function cleanedEdgeText(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu,
    " ",
  );
}

function splitText(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (currentBytes + characterBytes > MAX_TEXT_BYTES_PER_CONNECTION) {
      const ready = current.trim();
      if (ready.length > 0) {
        parts.push(ready);
      }
      current = character;
      currentBytes = characterBytes;
    } else {
      current += character;
      currentBytes += characterBytes;
    }
  }
  const remainder = current.trim();
  if (remainder.length > 0) {
    parts.push(remainder);
  }
  return parts;
}

export async function listEdgeVoices(
  options: EdgeVoiceListOptions = {},
): Promise<readonly EdgeVoice[]> {
  const token = options.trustedClientToken ?? TRUSTED_CLIENT_TOKEN;
  const chromiumVersion = options.chromiumVersion ?? DEFAULT_CHROMIUM_VERSION;
  if (token.trim().length === 0 || chromiumVersion.trim().length === 0) {
    throw new SpeechConfigurationError(
      "Edge TTS voice-list token and Chromium version must not be empty",
    );
  }

  const endpoint = new URL(DEFAULT_VOICE_LIST_ENDPOINT);
  endpoint.searchParams.set("trustedclienttoken", token);
  endpoint.searchParams.set("Sec-MS-GEC", secMsGec(token, options.now?.()));
  endpoint.searchParams.set("Sec-MS-GEC-Version", `1-${chromiumVersion}`);
  const majorVersion = chromiumVersion.split(".", 1)[0] ?? "143";
  const timeoutSignal = AbortSignal.timeout(VOICE_LIST_TIMEOUT_MS);
  const signal = options.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([options.signal, timeoutSignal]);
  const payload = await fetchJson(
    options.fetch ?? globalThis.fetch,
    "Edge TTS voice list",
    endpoint,
    {
      headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        cookie: `muid=${randomUUID().replaceAll("-", "").toUpperCase()};`,
        "sec-ch-ua":
          `" Not;A Brand";v="99", "Microsoft Edge";v="${majorVersion}", ` +
          `"Chromium";v="${majorVersion}"`,
        "sec-ch-ua-mobile": "?0",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "none",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 ` +
          `Safari/537.36 Edg/${majorVersion}.0.0.0`,
      },
    },
    signal,
  );
  if (!Array.isArray(payload)) {
    throw new Error("Edge TTS voice list returned a non-array response");
  }

  const voices: EdgeVoice[] = [];
  const seen = new Set<string>();
  for (const candidate of payload) {
    if (
      voices.length >= MAXIMUM_VOICE_COUNT ||
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const source = candidate as Readonly<Record<string, unknown>>;
    const name = voiceField(source["Name"]);
    const shortName = voiceField(source["ShortName"]);
    const gender = voiceField(source["Gender"]);
    const locale = voiceField(source["Locale"]);
    const localeName = voiceField(source["LocaleName"]);
    const friendlyName = voiceField(source["FriendlyName"]);
    if (
      name === undefined ||
      shortName === undefined ||
      gender === undefined ||
      locale === undefined ||
      localeName === undefined ||
      friendlyName === undefined ||
      seen.has(shortName)
    ) {
      continue;
    }
    seen.add(shortName);
    voices.push(Object.freeze({
      name,
      shortName,
      gender,
      locale,
      localeName,
      friendlyName,
    }));
  }
  if (voices.length === 0) {
    throw new Error("Edge TTS voice list did not contain any valid voices");
  }
  voices.sort((left, right) =>
    left.locale === right.locale
      ? left.shortName.localeCompare(right.shortName, "en")
      : left.locale.localeCompare(right.locale, "en")
  );
  return Object.freeze(voices);
}

function voiceField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAXIMUM_VOICE_FIELD_LENGTH
    ? normalized
    : undefined;
}

export class EdgeSpeechSynthesizer implements SpeechSynthesizer {
  readonly name = "edge-tts";

  readonly #voice: string;
  readonly #rate: string;
  readonly #volume: string;
  readonly #pitch: string;
  readonly #endpoint: URL;
  readonly #token: string;
  readonly #chromiumVersion: string;
  readonly #proxyAgent: HttpsProxyAgent<string> | undefined;
  readonly #webSocketFactory: EdgeWebSocketFactory;

  constructor(
    config: EdgeSpeechConfig,
    webSocketFactory: EdgeWebSocketFactory = (url, options) =>
      new WebSocket(url, options) as unknown as EdgeSocket,
  ) {
    if (config.voice.trim().length === 0) {
      throw new SpeechConfigurationError("edge-tts.voice must not be empty");
    }
    const endpointValue = config.endpoint ?? DEFAULT_ENDPOINT;
    let endpoint: URL;
    try {
      endpoint = new URL(endpointValue);
    } catch (error) {
      throw new SpeechConfigurationError(
        `edge-tts.endpoint is not a valid URL: ${endpointValue}`,
        { cause: error },
      );
    }
    if (endpoint.protocol !== "wss:") {
      throw new SpeechConfigurationError("edge-tts.endpoint must use wss:");
    }

    const token = config.trustedClientToken ?? TRUSTED_CLIENT_TOKEN;
    const chromiumVersion = config.chromiumVersion ?? DEFAULT_CHROMIUM_VERSION;
    if (token.trim().length === 0 || chromiumVersion.trim().length === 0) {
      throw new SpeechConfigurationError(
        "edge-tts trusted client token and Chromium version must not be empty",
      );
    }

    let proxyAgent: HttpsProxyAgent<string> | undefined;
    if (config.proxy !== undefined && config.proxy.trim().length > 0) {
      try {
        const proxyUrl = new URL(config.proxy);
        if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
          throw new Error(`unsupported protocol ${proxyUrl.protocol}`);
        }
        proxyAgent = new HttpsProxyAgent(proxyUrl);
      } catch (error) {
        throw new SpeechConfigurationError(
          `edge-tts.proxy is invalid: ${config.proxy}`,
          { cause: error },
        );
      }
    }

    this.#voice = config.voice;
    this.#rate = config.rate;
    this.#volume = config.volume;
    this.#pitch = config.pitch ?? "+0Hz";
    this.#endpoint = endpoint;
    this.#token = token;
    this.#chromiumVersion = chromiumVersion;
    this.#proxyAgent = proxyAgent;
    this.#webSocketFactory = webSocketFactory;
  }

  async synthesize(
    request: SpeechRequest,
    signal: AbortSignal,
  ): Promise<SynthesizedAudio> {
    const text = cleanedEdgeText(request.text);
    const parts = splitText(text);
    if (parts.length === 0) {
      throw new Error("Edge TTS text is empty after removing unsupported characters");
    }

    return {
      extension: "mp3",
      contentType: "audio/mpeg",
      stream: this.#streamParts(parts, signal),
    };
  }

  async *#streamParts(
    parts: readonly string[],
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const budget = { remainingBytes: DEFAULT_MAX_AUDIO_BYTES };
    for (const part of parts) {
      throwIfAborted(signal, "Edge TTS request was cancelled");
      const chunks = await this.#requestPart(part, signal, budget);
      for (const chunk of chunks) {
        throwIfAborted(signal, "Edge TTS request was cancelled");
        yield chunk;
      }
    }
  }

  #requestPart(
    text: string,
    signal: AbortSignal,
    budget: { remainingBytes: number },
  ): Promise<readonly Buffer[]> {
    return new Promise<readonly Buffer[]>((resolve, reject) => {
      throwIfAborted(signal, "Edge TTS request was cancelled");

      const connectionId = randomUUID().replaceAll("-", "");
      const requestId = randomUUID().replaceAll("-", "");
      const endpoint = new URL(this.#endpoint.href);
      endpoint.searchParams.set("TrustedClientToken", this.#token);
      endpoint.searchParams.set("Sec-MS-GEC", secMsGec(this.#token));
      endpoint.searchParams.set("Sec-MS-GEC-Version", `1-${this.#chromiumVersion}`);
      endpoint.searchParams.set("ConnectionId", connectionId);

      const majorVersion = this.#chromiumVersion.split(".", 1)[0] ?? "143";
      const socket = this.#webSocketFactory(endpoint, {
        agent: this.#proxyAgent,
        perMessageDeflate: true,
        maxPayload: DEFAULT_MAX_AUDIO_BYTES,
        headers: {
          pragma: "no-cache",
          "cache-control": "no-cache",
          origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 ` +
            `Safari/537.36 Edg/${majorVersion}.0.0.0`,
          "accept-encoding": "gzip, deflate, br, zstd",
          "accept-language": "en-US,en;q=0.9",
        },
      });

      const chunks: Buffer[] = [];
      let receivedAudio = false;
      let settled = false;
      let released = false;

      const release = (): void => {
        if (released) {
          return;
        }
        released = true;
        signal.removeEventListener("abort", onAbort);
        socket.off("open", onOpen);
        socket.off("message", onMessage);
        socket.off("unexpected-response", onUnexpectedResponse);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const terminate = (): void => {
        try {
          socket.terminate();
        } catch {
          release();
        }
      };
      const fail = (error: unknown, terminateConnection = true): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (terminateConnection) {
          terminate();
        } else {
          release();
        }
        reject(
          error instanceof Error
            ? error
            : new Error(`Edge TTS WebSocket failed: ${String(error)}`),
        );
      };
      const finish = (): void => {
        if (settled) {
          return;
        }
        if (!receivedAudio) {
          fail(new Error("Edge TTS completed without returning audio"));
          return;
        }
        settled = true;
        terminate();
        resolve(chunks);
      };
      const onAbort = (): void => {
        fail(abortReason(signal, "Edge TTS request was cancelled"));
      };
      const onOpen = (): void => {
        try {
          const timestamp = edgeTimestamp();
          socket.send(
            `X-Timestamp:${timestamp}\r\n` +
              "Content-Type:application/json; charset=utf-8\r\n" +
              "Path:speech.config\r\n\r\n" +
              JSON.stringify({
                context: {
                  synthesis: {
                    audio: {
                      metadataoptions: {
                        sentenceBoundaryEnabled: false,
                        wordBoundaryEnabled: false,
                      },
                      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
                    },
                  },
                },
              }) +
              "\r\n",
          );
          const ssml =
            "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
            `<voice name='${escapeXml(this.#voice)}'><prosody pitch='${escapeXml(this.#pitch)}' ` +
            `rate='${escapeXml(this.#rate)}' volume='${escapeXml(this.#volume)}'>` +
            `${escapeXml(text)}</prosody></voice></speak>`;
          socket.send(
            `X-RequestId:${requestId}\r\n` +
              "Content-Type:application/ssml+xml\r\n" +
              `X-Timestamp:${timestamp}Z\r\n` +
              `Path:ssml\r\n\r\n${ssml}`,
          );
        } catch (error) {
          fail(new Error(`Unable to send Edge TTS request: ${errorMessage(error)}`, { cause: error }));
        }
      };
      const onMessage = (rawData: RawData, isBinary: boolean): void => {
        try {
          const data = rawDataBuffer(rawData);
          if (!isBinary) {
            const message = data.toString("utf8");
            const separator = message.indexOf("\r\n\r\n");
            const headers = parseHeaders(
              separator === -1 ? message : message.slice(0, separator),
            );
            const path = headers.path;
            if (path === "turn.end") {
              finish();
            } else if (
              path !== "turn.start" &&
              path !== "response" &&
              path !== "audio.metadata"
            ) {
              fail(new Error(`Edge TTS returned unexpected text frame path ${JSON.stringify(path)}`));
            }
            return;
          }

          if (data.byteLength < 2) {
            fail(new Error("Edge TTS returned a truncated binary frame"));
            return;
          }
          const headerLength = data.readUInt16BE(0);
          const bodyOffset = headerLength + 2;
          if (bodyOffset > data.byteLength) {
            fail(new Error("Edge TTS binary frame header exceeds frame size"));
            return;
          }
          const headers = parseHeaders(data.subarray(2, bodyOffset).toString("utf8"));
          if (headers.path !== "audio") {
            fail(new Error(`Edge TTS returned unexpected binary frame path ${JSON.stringify(headers.path)}`));
            return;
          }
          const body = data.subarray(bodyOffset);
          if (body.byteLength > budget.remainingBytes) {
            fail(
              new Error(
                `Edge TTS audio exceeds the ${DEFAULT_MAX_AUDIO_BYTES}-byte download limit`,
              ),
            );
            return;
          }
          if (body.byteLength > 0) {
            budget.remainingBytes -= body.byteLength;
            receivedAudio = true;
            chunks.push(Buffer.from(body));
          }
        } catch (error) {
          fail(new Error(`Unable to parse Edge TTS response: ${errorMessage(error)}`, { cause: error }));
        }
      };
      const onUnexpectedResponse = (
        _request: unknown,
        response: { readonly statusCode: number; readonly statusMessage?: string },
      ): void => {
        fail(
          new Error(
            `Edge TTS WebSocket handshake failed with HTTP ${response.statusCode} ${response.statusMessage ?? ""}`.trim(),
          ),
        );
      };
      const onError = (error: Error): void => {
        fail(new Error(`Edge TTS WebSocket error: ${error.message}`, { cause: error }));
      };
      const onClose = (code: number, reason: Buffer): void => {
        if (settled) {
          release();
          return;
        }
        fail(
          new Error(
            `Edge TTS WebSocket closed before turn.end (code ${code}${
              reason.byteLength === 0 ? "" : `: ${reason.toString("utf8")}`
            })`,
          ),
          false,
        );
      };

      socket.once("open", onOpen);
      socket.on("message", onMessage);
      socket.once("unexpected-response", onUnexpectedResponse);
      socket.once("error", onError);
      socket.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }
}
