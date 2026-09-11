import { randomBytes } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import type { SpeechRequest } from "../../domain/types.js";
import {
  SpeechConfigurationError,
  abortReason,
  errorMessage,
  throwIfAborted,
} from "../errors.js";
import { appendUrlPath, fetchAudio, requireHttpUrl } from "../http.js";
import {
  DEFAULT_MAX_REFERENCE_AUDIO_BYTES,
  loadReferenceFile,
} from "../reference-files.js";
import type { SpeechFetch, SpeechSynthesizer, SynthesizedAudio } from "../types.js";
import {
  DEFAULT_MAX_AUDIO_BYTES,
  fetchJson,
  readBoundedResponse,
  remoteHttpUrl,
  safeAudioExtension,
} from "./bounded-http.js";
import { detectLegacyLanguage } from "./legacy-language.js";

const MAX_GRADIO_EVENT_BYTES = 4 * 1024 * 1024;
const GPT_SOVITS_LANGUAGE_BY_CODE: Readonly<Record<string, string>> = {
  zh: "中文",
  ja: "日文",
  en: "英文",
};

type UnknownObject = Readonly<Record<string, unknown>>;

export type GradioTransport = "websocket" | "http";

export interface GradioSocket {
  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number, reason: Buffer) => void): this;
  once(
    event: "unexpected-response",
    listener: (
      request: unknown,
      response: { readonly statusCode?: number; readonly statusMessage?: string },
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
      response: { readonly statusCode?: number; readonly statusMessage?: string },
    ) => void,
  ): this;
  off(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void,
  ): this;
  send(data: string): void;
  close(code?: number): void;
  terminate(): void;
}

export type GradioWebSocketFactory = (url: URL) => GradioSocket;

export interface GradioQueueClientOptions {
  readonly apiBase: string;
  readonly fetch?: SpeechFetch;
  readonly webSocketFactory?: GradioWebSocketFactory;
  readonly sessionHashFactory?: () => string;
  readonly timeoutMs?: number;
  readonly maxDownloadBytes?: number;
}

export interface GradioPredictionRequest {
  readonly data: readonly unknown[];
  readonly fnIndex?: number;
  readonly hashFnIndex?: number;
  readonly apiName?: string;
  readonly outputIndex?: number;
  readonly transport?: GradioTransport | undefined;
}

interface GradioInvocationResult {
  readonly data: readonly unknown[];
}

interface GradioFileData {
  readonly path: string;
  readonly url: string;
  readonly name: string;
  readonly data: string | null;
  readonly orig_name: string;
  readonly size?: number;
  readonly mime_type?: string;
  readonly is_file: true;
  readonly meta: Readonly<{ _type: "gradio.FileData" }>;
}

interface GradioAdapterLimits {
  readonly timeoutMs: number;
  readonly maxDownloadBytes?: number;
  readonly transport?: GradioTransport | undefined;
}

export interface GptSovitsGradioConfig extends GradioAdapterLimits {
  readonly engine: "gpt_sovits";
  readonly apiBase: string;
  readonly cwd: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export type LegacyGradioSpeechConfig = GptSovitsGradioConfig;

function recordValue(value: unknown, label: string): UnknownObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} returned an invalid object`);
  }
  return value as UnknownObject;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function sseEvents(payload: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  for (const block of payload.split(/\r?\n\r?\n/gu)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/gu)) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
    }
    if (data.length > 0) {
      events.push({ ...(event === undefined ? {} : { event }), data: data.join("\n") });
    }
  }
  return events;
}

function outputData(value: unknown, label: string): readonly unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const object = recordValue(value, label);
  if (Array.isArray(object.data)) {
    return object.data;
  }
  throw new Error(`${label} did not contain output data`);
}

function configuredAutomaticLanguage(
  configured: unknown,
  text: string,
  nameByLanguage: Readonly<Record<string, string>>,
): unknown {
  if (
    configured !== "自动识别" &&
    configured !== "auto" &&
    configured !== "AUTO"
  ) {
    return configured;
  }
  return nameByLanguage[detectLegacyLanguage(text)];
}

export class GradioQueueClient {
  readonly #baseUrl: URL;
  readonly #fetch: SpeechFetch;
  readonly #webSocketFactory: GradioWebSocketFactory;
  readonly #sessionHashFactory: () => string;
  readonly #timeoutMs: number;
  readonly #maxDownloadBytes: number;

  constructor(options: GradioQueueClientOptions) {
    this.#baseUrl = requireHttpUrl(options.apiBase, "Gradio URL");
    if (!this.#baseUrl.pathname.endsWith("/")) {
      this.#baseUrl.pathname += "/";
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#webSocketFactory =
      options.webSocketFactory ??
      ((url) =>
        new WebSocket(url, {
          maxPayload: MAX_GRADIO_EVENT_BYTES,
        }) as unknown as GradioSocket);
    this.#sessionHashFactory =
      options.sessionHashFactory ??
      (() => randomBytes(8).toString("hex"));
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxDownloadBytes =
      options.maxDownloadBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new SpeechConfigurationError(
        "Gradio timeoutMs must be a positive safe integer",
      );
    }
    if (
      !Number.isSafeInteger(this.#maxDownloadBytes) ||
      this.#maxDownloadBytes < 1
    ) {
      throw new SpeechConfigurationError(
        "Gradio maxDownloadBytes must be a positive safe integer",
      );
    }
  }

  async predictAudio(
    request: GradioPredictionRequest,
    signal: AbortSignal,
    fallbackExtension = "wav",
  ): Promise<SynthesizedAudio> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const boundedSignal = AbortSignal.any([signal, timeoutSignal]);
    let result: GradioInvocationResult;
    try {
      if (
        request.apiName !== undefined &&
        request.transport === "websocket"
      ) {
        const fnIndex = await this.#fnIndexForApiName(
          request.apiName,
          boundedSignal,
        );
        result = await this.#predictWebSocket(
          { ...request, fnIndex },
          boundedSignal,
        );
      } else if (request.apiName !== undefined) {
        result = await this.#predictNamed(request, boundedSignal);
      } else if ((request.transport ?? "websocket") === "http") {
        result = await this.#predictHttpQueue(request, boundedSignal);
      } else {
        result = await this.#predictWebSocket(request, boundedSignal);
      }
    } catch (error) {
      if (timeoutSignal.aborted && !signal.aborted) {
        throw new Error(`Gradio request timed out after ${this.#timeoutMs} ms`, {
          cause: error,
        });
      }
      throw error;
    }

    const outputIndex = request.outputIndex ?? 0;
    const selected = result.data[outputIndex];
    if (selected === undefined) {
      throw new Error(
        `Gradio response does not contain output index ${outputIndex}`,
      );
    }
    const output = this.#audioOutput(selected);
    return fetchAudio(
      this.#fetch,
      "Gradio audio download",
      output.url,
      { method: "GET" },
      boundedSignal,
      safeAudioExtension(output.name, fallbackExtension),
      this.#maxDownloadBytes,
    );
  }

  async uploadFile(
    configuredPath: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<GradioFileData> {
    const boundedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.#timeoutMs),
    ]);
    const file = await loadReferenceFile({
      configuredPath,
      cwd,
      label: "Gradio upload file",
      signal: boundedSignal,
      maximumBytes: DEFAULT_MAX_REFERENCE_AUDIO_BYTES,
    });
    const form = new FormData();
    const blob = new Blob([file.data as unknown as BlobPart], {
      type: file.contentType,
    });
    form.append("files", blob, file.name);
    const endpoint = appendUrlPath(this.#baseUrl, "upload");
    endpoint.searchParams.set("upload_id", this.#sessionHashFactory());
    const response = await fetchJson(
      this.#fetch,
      "Gradio file upload",
      endpoint,
      { method: "POST", body: form },
      boundedSignal,
    );
    const remotePath = Array.isArray(response)
      ? response[0]
      : recordValue(response, "Gradio file upload").path;
    if (
      typeof remotePath !== "string" ||
      remotePath.length === 0 ||
      remotePath.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(remotePath)
    ) {
      throw new Error("Gradio file upload returned an unsafe remote path");
    }
    const fileUrl = this.#fileUrl(remotePath);
    return {
      path: remotePath,
      url: fileUrl.href,
      name: remotePath,
      data: null,
      orig_name: file.name,
      size: file.size,
      mime_type: file.contentType,
      is_file: true,
      meta: { _type: "gradio.FileData" },
    };
  }

  async #fnIndexForApiName(
    apiName: string,
    signal: AbortSignal,
  ): Promise<number> {
    const normalizedName = `/${apiName.replace(/^\//u, "")}`;
    const config = recordValue(
      await fetchJson(
        this.#fetch,
        "Gradio config",
        appendUrlPath(this.#baseUrl, "config"),
        { method: "GET" },
        signal,
      ),
      "Gradio config",
    );
    if (!Array.isArray(config.dependencies)) {
      throw new Error(
        `Gradio config does not expose dependency metadata for ${normalizedName}`,
      );
    }
    for (const [index, value] of config.dependencies.entries()) {
      if (value === null || Array.isArray(value) || typeof value !== "object") {
        continue;
      }
      const dependency = value as UnknownObject;
      const configuredName =
        typeof dependency.api_name === "string"
          ? `/${dependency.api_name.replace(/^\//u, "")}`
          : undefined;
      if (configuredName !== normalizedName) {
        continue;
      }
      const configuredIndex = dependency.id ?? dependency.fn_index ?? index;
      if (
        typeof configuredIndex !== "number" ||
        !Number.isSafeInteger(configuredIndex) ||
        configuredIndex < 0
      ) {
        throw new Error(
          `Gradio config returned an invalid function index for ${normalizedName}`,
        );
      }
      return configuredIndex;
    }
    throw new Error(
      `Gradio config does not expose API ${normalizedName}; select a supported remote protocol variant`,
    );
  }

  async #predictNamed(
    request: GradioPredictionRequest,
    signal: AbortSignal,
  ): Promise<GradioInvocationResult> {
    const apiName = request.apiName?.replace(/^\//u, "");
    if (apiName === undefined || !/^[A-Za-z0-9_-]+$/u.test(apiName)) {
      throw new SpeechConfigurationError(
        "Gradio apiName must contain only letters, numbers, underscore, or hyphen",
      );
    }
    const callEndpoint = appendUrlPath(this.#baseUrl, `call/${apiName}`);
    const joined = recordValue(
      await fetchJson(
        this.#fetch,
        `Gradio /call/${apiName}`,
        callEndpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: request.data }),
        },
        signal,
      ),
      `Gradio /call/${apiName}`,
    );
    if (
      typeof joined.event_id !== "string" ||
      !/^[A-Za-z0-9_-]+$/u.test(joined.event_id)
    ) {
      throw new Error("Gradio named call did not return a safe event_id");
    }
    const eventEndpoint = appendUrlPath(
      this.#baseUrl,
      `call/${apiName}/${joined.event_id}`,
    );
    const response = await this.#fetch(eventEndpoint, {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal,
    });
    const bytes = await readBoundedResponse(
      response,
      `Gradio /call/${apiName} events`,
      MAX_GRADIO_EVENT_BYTES,
      signal,
    );
    for (const event of sseEvents(new TextDecoder().decode(bytes))) {
      if (event.event === "error") {
        throw new Error(`Gradio named call failed: ${event.data.slice(0, 512)}`);
      }
      if (event.event === "complete") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data) as unknown;
        } catch (error) {
          throw new Error("Gradio named call returned invalid completion JSON", {
            cause: error,
          });
        }
        return { data: outputData(parsed, "Gradio named call") };
      }
    }
    throw new Error("Gradio named call ended without a complete event");
  }

  async #predictHttpQueue(
    request: GradioPredictionRequest,
    signal: AbortSignal,
  ): Promise<GradioInvocationResult> {
    if (request.fnIndex === undefined) {
      throw new SpeechConfigurationError(
        "Gradio HTTP queue requests require fnIndex",
      );
    }
    const sessionHash = this.#sessionHashFactory();
    const joined = recordValue(
      await fetchJson(
        this.#fetch,
        "Gradio queue join",
        appendUrlPath(this.#baseUrl, "queue/join"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            data: request.data,
            event_data: null,
            fn_index: request.fnIndex,
            trigger_id: request.fnIndex,
            session_hash: sessionHash,
          }),
        },
        signal,
      ),
      "Gradio queue join",
    );
    const eventId = typeof joined.event_id === "string" ? joined.event_id : undefined;
    const eventsEndpoint = appendUrlPath(this.#baseUrl, "queue/data");
    eventsEndpoint.searchParams.set("session_hash", sessionHash);
    const response = await this.#fetch(eventsEndpoint, {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal,
    });
    const bytes = await readBoundedResponse(
      response,
      "Gradio queue events",
      MAX_GRADIO_EVENT_BYTES,
      signal,
    );
    for (const event of sseEvents(new TextDecoder().decode(bytes))) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch (error) {
        throw new Error("Gradio queue returned invalid event JSON", {
          cause: error,
        });
      }
      const message = recordValue(parsed, "Gradio queue event");
      if (
        eventId !== undefined &&
        typeof message.event_id === "string" &&
        message.event_id !== eventId
      ) {
        continue;
      }
      if (message.msg === "process_completed") {
        if (message.success === false) {
          throw new Error(
            `Gradio queue failed: ${String(message.output ?? "unknown error").slice(0, 512)}`,
          );
        }
        const output = recordValue(message.output, "Gradio queue output");
        return { data: outputData(output.data, "Gradio queue output") };
      }
      if (message.msg === "queue_full") {
        throw new Error("Gradio queue is full");
      }
    }
    throw new Error("Gradio queue ended without a process_completed event");
  }

  #predictWebSocket(
    request: GradioPredictionRequest,
    signal: AbortSignal,
  ): Promise<GradioInvocationResult> {
    if (request.fnIndex === undefined) {
      throw new SpeechConfigurationError(
        "Gradio WebSocket queue requests require fnIndex",
      );
    }
    return new Promise<GradioInvocationResult>((resolvePrediction, rejectPrediction) => {
      throwIfAborted(signal, "Gradio request was cancelled");
      const endpoint = appendUrlPath(this.#baseUrl, "queue/join");
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      const socket = this.#webSocketFactory(endpoint);
      const sessionHash = this.#sessionHashFactory();
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
        rejectPrediction(
          error instanceof Error
            ? error
            : new Error(`Gradio WebSocket failed: ${String(error)}`),
        );
      };
      const complete = (data: readonly unknown[]): void => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          socket.close(1000);
        } catch {
          release();
        }
        resolvePrediction({ data });
      };
      const onAbort = (): void => {
        fail(abortReason(signal, "Gradio request was cancelled"));
      };
      const onOpen = (): void => {
        // Legacy Gradio queue servers prompt with send_hash before accepting data.
      };
      const onMessage = (rawData: RawData, isBinary: boolean): void => {
        try {
          if (isBinary) {
            throw new Error("Gradio queue returned an unexpected binary frame");
          }
          const bytes = rawDataBuffer(rawData);
          if (bytes.byteLength > MAX_GRADIO_EVENT_BYTES) {
            throw new Error("Gradio queue event exceeds the size limit");
          }
          const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
          const message = recordValue(parsed, "Gradio WebSocket event");
          switch (message.msg) {
            case "send_hash":
              socket.send(
                JSON.stringify({
                  session_hash: sessionHash,
                  fn_index: request.hashFnIndex ?? request.fnIndex,
                }),
              );
              break;
            case "send_data":
              socket.send(
                JSON.stringify({
                  data: request.data,
                  event_data: null,
                  fn_index: request.fnIndex,
                  session_hash: sessionHash,
                }),
              );
              break;
            case "process_completed": {
              if (message.success === false) {
                throw new Error(
                  `Gradio synthesis failed: ${String(message.output ?? "unknown error").slice(0, 512)}`,
                );
              }
              const output = recordValue(message.output, "Gradio output");
              complete(outputData(output.data, "Gradio output"));
              break;
            }
            case "queue_full":
              throw new Error("Gradio queue is full");
            case "estimation":
            case "process_starts":
            case "process_generating":
              break;
            default:
              throw new Error(
                `Gradio queue returned unexpected event ${JSON.stringify(message.msg)}`,
              );
          }
        } catch (error) {
          fail(
            new Error(`Unable to process Gradio queue event: ${errorMessage(error)}`, {
              cause: error,
            }),
          );
        }
      };
      const onUnexpectedResponse = (
        _request: unknown,
        response: { readonly statusCode?: number; readonly statusMessage?: string },
      ): void => {
        fail(
          new Error(
            `Gradio WebSocket handshake failed with HTTP ${response.statusCode ?? "unknown"} ${response.statusMessage ?? ""}`.trim(),
          ),
        );
      };
      const onError = (error: Error): void => {
        fail(new Error(`Gradio WebSocket error: ${error.message}`, { cause: error }));
      };
      const onClose = (code: number, reason: Buffer): void => {
        if (settled) {
          release();
          return;
        }
        fail(
          new Error(
            `Gradio WebSocket closed before completion (code ${code}${
              reason.byteLength === 0 ? "" : `: ${reason.toString("utf8")}`
            })`,
          ),
          false,
        );
      };

      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("open", onOpen);
      socket.on("message", onMessage);
      socket.once("unexpected-response", onUnexpectedResponse);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }

  #audioOutput(value: unknown): { readonly url: URL; readonly name?: string } {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        throw new Error("Gradio returned an empty audio output array");
      }
      return this.#audioOutput(value[0]);
    }
    if (typeof value === "string") {
      return this.#audioOutputFromString(value);
    }
    const object = recordValue(value, "Gradio audio output");
    if (typeof object.url === "string") {
      return {
        url: remoteHttpUrl(
          object.url,
          this.#baseUrl,
          "Gradio audio output",
          true,
        ),
        ...(typeof object.orig_name === "string"
          ? { name: object.orig_name }
          : typeof object.path === "string"
            ? { name: object.path }
            : typeof object.name === "string"
              ? { name: object.name }
              : {}),
      };
    }
    const path = typeof object.path === "string"
      ? object.path
      : typeof object.name === "string"
        ? object.name
        : undefined;
    if (path === undefined) {
      throw new Error("Gradio audio output does not contain a URL or remote path");
    }
    return { url: this.#fileUrl(path), name: path };
  }

  #audioOutputFromString(value: string): { readonly url: URL; readonly name: string } {
    const candidate = value.trim();
    if (candidate.length === 0) {
      throw new Error("Gradio returned an empty audio output path");
    }
    if (/^https?:\/\//iu.test(candidate)) {
      return {
        url: remoteHttpUrl(candidate, this.#baseUrl, "Gradio audio output", true),
        name: candidate,
      };
    }
    return { url: this.#fileUrl(candidate), name: candidate };
  }

  #fileUrl(path: string): URL {
    if (
      path.length === 0 ||
      path.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(path)
    ) {
      throw new Error("Gradio returned an unsafe remote file path");
    }
    return new URL(`file=${encodeURIComponent(path)}`, this.#baseUrl);
  }
}

export class LegacyGradioSpeechSynthesizer implements SpeechSynthesizer {
  readonly name: string;

  readonly #config: LegacyGradioSpeechConfig;
  readonly #client: GradioQueueClient;

  constructor(
    config: LegacyGradioSpeechConfig,
    fetchImpl: SpeechFetch = globalThis.fetch,
  ) {
    this.name = config.engine;
    this.#config = config;
    const apiBase = config.apiBase;
    this.#client = new GradioQueueClient({
      apiBase,
      fetch: fetchImpl,
      timeoutMs: config.timeoutMs,
      ...(config.maxDownloadBytes === undefined
        ? {}
        : { maxDownloadBytes: config.maxDownloadBytes }),
    });
  }

  async synthesize(
    request: SpeechRequest,
    signal: AbortSignal,
  ): Promise<SynthesizedAudio> {
    const configuredReference = this.#config.parameters.ref_audio_path;
    if (
      typeof configuredReference !== "string" ||
      configuredReference.trim().length === 0
    ) {
      throw new SpeechConfigurationError(
        "gpt_sovits.api_0322.ref_audio_path must be a non-empty local file path",
      );
    }
    const reference = await this.#client.uploadFile(
      configuredReference,
      this.#config.cwd,
      signal,
    );
    return this.#client.predictAudio(
      {
        data: [
          request.text,
          configuredAutomaticLanguage(
            this.#config.parameters.text_lang,
            request.text,
            GPT_SOVITS_LANGUAGE_BY_CODE,
          ),
          reference,
          this.#config.parameters.prompt_text,
          this.#config.parameters.prompt_lang,
          this.#config.parameters.top_k,
          this.#config.parameters.top_p,
          this.#config.parameters.temperature,
          this.#config.parameters.text_split_method,
          this.#config.parameters.batch_size,
          this.#config.parameters.speed_factor,
          this.#config.parameters.split_bucket,
          this.#config.parameters.return_fragment,
          this.#config.parameters.fragment_interval,
        ],
        apiName: "inference",
        transport: this.#config.transport ?? "websocket",
      },
      signal,
    );
  }
}
