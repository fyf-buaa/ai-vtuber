import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

import {
  WebSocketServer,
  type ServerOptions,
  type VerifyClientCallbackAsync,
} from "ws";

import type { EventSource, LiveEventHandler } from "../core/contracts.js";
import type {
  PayloadNormalizer,
  PlatformErrorHandler,
  WebSocketConnection,
  WebSocketServerFactory,
  WebSocketServerHandle,
  WebSocketServerOptions,
} from "./types.js";
import {
  abortError,
  asError,
  deferred,
  isRecord,
  linkAbortSignal,
  PlatformConfigurationError,
  PlatformConnectionError,
} from "./utilities.js";
import { decodeJsonWebSocketFrames } from "./websocket-client.js";

const DEFAULT_MAXIMUM_CONNECTIONS = 32;
const DEFAULT_MAXIMUM_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAXIMUM_QUEUED_FRAMES = 64;
const DEFAULT_MAXIMUM_QUEUED_BYTES = 4 * 1024 * 1024;
const PAYLOAD_OVERFLOW_CLOSE_CODE = 1009;
const PAYLOAD_OVERFLOW_CLOSE_REASON = "Inbound message limit exceeded";
const CONNECTION_OVERFLOW_CLOSE_CODE = 1013;
const CONNECTION_OVERFLOW_CLOSE_REASON = "Connection limit exceeded";
const RELAY_TOKEN_ENVIRONMENT_VARIABLE = "AI_VTUBER_RELAY_TOKEN";
const MAXIMUM_CREDENTIAL_BYTES = 1024;
const TRUSTED_BROWSER_RELAY_ORIGIN = "https://redlive.xiaohongshu.com";


interface BoundedWebSocketServerOptions extends WebSocketServerOptions {
  readonly maxPayload: number;
  readonly verifyClient: VerifyClientCallbackAsync;
}

interface QueuedFrame {
  readonly data: unknown;
  readonly byteLength: number;
}

interface ConnectionListeners {
  readonly message: (data: unknown, isBinary: boolean) => void;
  readonly close: (code: number, reason: Uint8Array) => void;
  readonly error: (error: Error) => void;
}

interface ConnectionState {
  readonly connection: WebSocketConnection;
  readonly queue: Array<QueuedFrame | undefined>;
  readonly listeners: ConnectionListeners;
  accepting: boolean;
  connected: boolean;
  queueHead: number;
  queuedFrames: number;
  queuedBytes: number;
  processing: Promise<void> | undefined;
}

interface UpgradeAwareWebSocketServerHandle {
  on(
    event: "connection",
    listener: (
      connection: WebSocketConnection,
      request?: IncomingMessage,
    ) => void,
  ): this;
}

type HandshakeDecision =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly statusCode: number;
      readonly closeCode: number;
      readonly message: string;
    };

export interface JsonWebSocketServerSourceOptions {
  readonly name: string;
  readonly listen: WebSocketServerOptions;
  readonly normalize: PayloadNormalizer;
  readonly maximumConnections?: number;
  readonly maximumPayloadBytes?: number;
  readonly maximumQueuedFrames?: number;
  readonly maximumQueuedBytes?: number;
  /**
   * Bearer credential required during the WebSocket upgrade. When omitted,
   * AI_VTUBER_RELAY_TOKEN is used if it is set.
   */
  readonly credential?: string;
  readonly webSocketServerFactory?: WebSocketServerFactory;
  readonly signal?: AbortSignal;
  readonly onError?: PlatformErrorHandler;
}

export class JsonWebSocketServerSource implements EventSource {
  readonly name: string;

  readonly #listen: WebSocketServerOptions;
  readonly #normalize: PayloadNormalizer;
  readonly #maximumConnections: number;
  readonly #maximumPayloadBytes: number;
  readonly #maximumQueuedFrames: number;
  readonly #maximumQueuedBytes: number;
  readonly #credential: string | undefined;
  readonly #serverFactory: WebSocketServerFactory;
  readonly #controller = new AbortController();
  readonly #unlinkExternalSignal: () => void;
  readonly #onError: PlatformErrorHandler;
  readonly #connections = new Set<ConnectionState>();

  #server: WebSocketServerHandle | undefined;
  #closingPromise: Promise<void> | undefined;
  #handler: LiveEventHandler | undefined;
  #started = false;

  constructor(options: JsonWebSocketServerSourceOptions) {
    this.name = options.name;
    validateListenOptions(this.name, options.listen);
    this.#listen = options.listen;
    this.#normalize = options.normalize;
    this.#maximumConnections = positiveLimit(
      this.name,
      "maximumConnections",
      options.maximumConnections,
      DEFAULT_MAXIMUM_CONNECTIONS,
    );
    this.#maximumPayloadBytes = positiveLimit(
      this.name,
      "maximumPayloadBytes",
      options.maximumPayloadBytes,
      DEFAULT_MAXIMUM_PAYLOAD_BYTES,
    );
    this.#maximumQueuedFrames = positiveLimit(
      this.name,
      "maximumQueuedFrames",
      options.maximumQueuedFrames,
      DEFAULT_MAXIMUM_QUEUED_FRAMES,
    );
    this.#maximumQueuedBytes = positiveLimit(
      this.name,
      "maximumQueuedBytes",
      options.maximumQueuedBytes,
      DEFAULT_MAXIMUM_QUEUED_BYTES,
    );
    this.#credential = relayCredential(
      this.name,
      options.credential ??
        process.env[RELAY_TOKEN_ENVIRONMENT_VARIABLE],
    );
    if (
      !isLoopbackHostname(this.#listen.host) &&
      this.#credential === undefined
    ) {
      throw new PlatformConfigurationError(
        this.name,
        `non-loopback WebSocket listeners require ${RELAY_TOKEN_ENVIRONMENT_VARIABLE}`,
      );
    }
    this.#serverFactory =
      options.webSocketServerFactory ?? defaultWebSocketServerFactory;
    this.#onError =
      options.onError ??
      ((error) => console.error(`[${this.name}] ${error.message}`, error));
    this.#unlinkExternalSignal = linkAbortSignal(
      options.signal,
      this.#controller,
    );
    this.#controller.signal.addEventListener(
      "abort",
      () => {
        void this.#closeServer();
      },
      { once: true },
    );
  }

  async start(handler: LiveEventHandler): Promise<void> {
    if (this.#started) {
      throw new Error(`Event source "${this.name}" has already been started`);
    }
    if (this.#controller.signal.aborted) {
      throw abortError(this.#controller.signal.reason);
    }
    this.#started = true;
    this.#handler = handler;

    const listening = deferred<void>();
    let server: WebSocketServerHandle;
    const serverOptions: BoundedWebSocketServerOptions = {
      ...this.#listen,
      maxPayload: this.#maximumPayloadBytes,
      verifyClient: (info, callback) => {
        const decision = this.#handshakeDecision(info.req);
        if (decision.accepted) {
          callback(true);
        } else {
          callback(false, decision.statusCode, decision.message);
        }
      },
    };
    try {
      server = this.#serverFactory(serverOptions);
    } catch (error) {
      throw new PlatformConnectionError(
        this.name,
        `cannot bind ${this.#listen.host}:${this.#listen.port}`,
        { cause: error },
      );
    }
    this.#server = server;
    server.on("listening", () => listening.resolve());
    (
      server as unknown as UpgradeAwareWebSocketServerHandle
    ).on("connection", (connection, request) =>
      this.#accept(connection, request),
    );
    server.on("error", (error) => {
      const connectionError = new PlatformConnectionError(
        this.name,
        `WebSocket listener ${this.#listen.host}:${this.#listen.port} failed`,
        { cause: error },
      );
      if (!listening.settled()) {
        listening.reject(connectionError);
      } else {
        this.#onError(connectionError);
      }
    });

    const onAbort = (): void =>
      listening.reject(abortError(this.#controller.signal.reason));
    this.#controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await listening.promise;
    } catch (error) {
      await this.#closeServer();
      throw error;
    } finally {
      this.#controller.signal.removeEventListener("abort", onAbort);
    }
  }

  async dispose(): Promise<void> {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(
        new DOMException("Event source disposed", "AbortError"),
      );
    }
    try {
      await this.#closeServer();
    } finally {
      this.#connections.clear();
      this.#handler = undefined;
      this.#unlinkExternalSignal();
    }
  }

  #handshakeDecision(request: IncomingMessage | undefined): HandshakeDecision {
    if (this.#controller.signal.aborted) {
      return rejectedHandshake(503, 1013, "WebSocket listener is closing");
    }
    if (request === undefined) {
      if (this.#credential !== undefined) {
        return rejectedHandshake(401, 1008, "WebSocket authentication required");
      }
    } else {
      if (!hostMatchesListener(request.headers.host, this.#listen)) {
        return rejectedHandshake(403, 1008, "WebSocket Host is not allowed");
      }
      if (
        this.#credential !== undefined &&
        !hasValidBearerCredential(
          request.headers.authorization,
          this.#credential,
        )
      ) {
        return rejectedHandshake(401, 1008, "WebSocket authentication required");
      }
      if (
        !isAllowedOrigin(
          request.headers.origin,
          this.#credential !== undefined,
        )
      ) {
        return rejectedHandshake(403, 1008, "WebSocket Origin is not allowed");
      }
    }
    if (this.#connections.size >= this.#maximumConnections) {
      return rejectedHandshake(
        503,
        CONNECTION_OVERFLOW_CLOSE_CODE,
        CONNECTION_OVERFLOW_CLOSE_REASON,
      );
    }
    return { accepted: true };
  }

  #accept(
    connection: WebSocketConnection,
    request: IncomingMessage | undefined,
  ): void {
    const decision = this.#handshakeDecision(request);
    if (!decision.accepted) {
      closeConnection(connection, decision.closeCode, decision.message);
      return;
    }

    let state: ConnectionState;
    const listeners: ConnectionListeners = {
      message: (data, _isBinary) => this.#enqueue(state, data),
      close: (_code, _reason) => this.#connectionClosed(state),
      error: (error) => {
        if (!this.#controller.signal.aborted) {
          this.#onError(asError(error));
        }
      },
    };
    state = {
      connection,
      queue: [],
      listeners,
      accepting: true,
      connected: true,
      queueHead: 0,
      queuedFrames: 0,
      queuedBytes: 0,
      processing: undefined,
    };
    this.#connections.add(state);
    connection.on("message", listeners.message);
    connection.on("close", listeners.close);
    connection.on("error", listeners.error);
  }

  #enqueue(state: ConnectionState, data: unknown): void {
    if (!state.accepting || this.#controller.signal.aborted) {
      return;
    }
    const byteLength = webSocketFrameByteLength(data);
    if (byteLength > this.#maximumPayloadBytes) {
      this.#overflowConnection(
        state,
        `inbound frame payload (${byteLength} bytes) exceeds the configured ${this.#maximumPayloadBytes}-byte limit`,
      );
      return;
    }
    const nextFrameCount = state.queuedFrames + 1;
    const nextByteLength = state.queuedBytes + byteLength;
    if (
      nextFrameCount > this.#maximumQueuedFrames ||
      nextByteLength > this.#maximumQueuedBytes
    ) {
      this.#overflowConnection(
        state,
        `inbound frame backlog (${nextFrameCount} frames / ${nextByteLength} bytes) exceeds configured limits of ${this.#maximumQueuedFrames} frames / ${this.#maximumQueuedBytes} bytes`,
      );
      return;
    }

    const index =
      (state.queueHead + state.queuedFrames) % this.#maximumQueuedFrames;
    state.queue[index] = { data, byteLength };
    state.queuedFrames = nextFrameCount;
    state.queuedBytes = nextByteLength;
    this.#startProcessing(state);
  }

  #startProcessing(state: ConnectionState): void {
    if (state.processing !== undefined) {
      return;
    }
    const processing = this.#drain(state);
    state.processing = processing;
    void processing.then(
      () => this.#processingFinished(state, processing),
      (error: unknown) => {
        if (!this.#controller.signal.aborted) {
          this.#onError(asError(error));
        }
        this.#processingFinished(state, processing);
      },
    );
  }

  async #drain(state: ConnectionState): Promise<void> {
    while (state.accepting && state.queuedFrames > 0) {
      const frameIndex = state.queueHead;
      const frame = state.queue[frameIndex];
      if (frame === undefined) {
        return;
      }
      await this.#processMessage(state, frame.data);
      if (state.queue[frameIndex] === frame) {
        state.queue[frameIndex] = undefined;
        state.queueHead =
          (state.queueHead + 1) % this.#maximumQueuedFrames;
        state.queuedFrames -= 1;
        state.queuedBytes -= frame.byteLength;
        if (state.queuedFrames === 0) {
          clearQueue(state);
        }
      }
    }
  }

  #processingFinished(
    state: ConnectionState,
    processing: Promise<void>,
  ): void {
    if (state.processing !== processing) {
      return;
    }
    state.processing = undefined;
    if (state.accepting && state.queuedFrames > 0) {
      this.#startProcessing(state);
    } else if (!state.connected) {
      this.#connections.delete(state);
    }
  }

  async #processMessage(
    state: ConnectionState,
    data: unknown,
  ): Promise<void> {
    try {
      const payloads = await decodeJsonWebSocketFrames(data);
      for (const payload of payloads) {
        if (!state.accepting || this.#controller.signal.aborted) {
          return;
        }
        if (isRelayInfo(payload)) {
          state.connection.send(
            JSON.stringify({
              type: "ack",
              status: "ok",
              received: "info",
            }),
          );
          continue;
        }
        const handler = this.#handler;
        if (handler === undefined) {
          continue;
        }
        for (const event of this.#normalize(payload)) {
          if (!state.accepting || this.#controller.signal.aborted) {
            return;
          }
          await handler(event);
        }
      }
    } catch (error) {
      if (!state.accepting || this.#controller.signal.aborted) {
        return;
      }
      const parsed = asError(error);
      this.#onError(parsed);
      try {
        state.connection.send(
          JSON.stringify({ type: "ack", status: "error", error: parsed.message }),
        );
      } catch {
        state.accepting = false;
        clearQueue(state);
        closeConnection(state.connection, 1011, "Acknowledgement failed");
      }
    }
  }

  #overflowConnection(state: ConnectionState, message: string): void {
    if (!state.accepting) {
      return;
    }
    state.accepting = false;
    clearQueue(state);
    const error = new PlatformConnectionError(
      this.name,
      `${message}; closing with WebSocket status ${PAYLOAD_OVERFLOW_CLOSE_CODE}`,
    );
    closeConnection(
      state.connection,
      PAYLOAD_OVERFLOW_CLOSE_CODE,
      PAYLOAD_OVERFLOW_CLOSE_REASON,
    );
    this.#onError(error);
  }

  #connectionClosed(state: ConnectionState): void {
    if (!state.connected) {
      return;
    }
    state.connected = false;
    state.accepting = false;
    clearQueue(state);
    detachConnectionListeners(state);
    if (state.processing === undefined) {
      this.#connections.delete(state);
    }
  }

  #shutdownConnections(server: WebSocketServerHandle): void {
    const tracked = new Set<WebSocketConnection>();
    for (const state of this.#connections) {
      tracked.add(state.connection);
      state.accepting = false;
      state.connected = false;
      clearQueue(state);
      detachConnectionListeners(state);
      closeClientForShutdown(state.connection);
    }
    this.#connections.clear();
    for (const client of server.clients ?? []) {
      if (!tracked.has(client)) {
        closeClientForShutdown(client);
      }
    }
  }

  #closeServer(): Promise<void> {
    if (this.#closingPromise !== undefined) {
      return this.#closingPromise;
    }
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) {
      return Promise.resolve();
    }
    this.#shutdownConnections(server);
    const closing = new Promise<void>((resolve, reject) => {
      try {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    }).catch((error: unknown) => {
      const parsed = asError(error);
      if (!/not running/iu.test(parsed.message)) {
        this.#onError(parsed);
      }
    });
    this.#closingPromise = closing;
    return closing;
  }
}

function defaultWebSocketServerFactory(
  options: WebSocketServerOptions,
): WebSocketServerHandle {
  const bounded = options as BoundedWebSocketServerOptions;
  const serverOptions: ServerOptions = {
    host: bounded.host,
    port: bounded.port,
    maxPayload: bounded.maxPayload,
    verifyClient: bounded.verifyClient,
    ...(bounded.path === undefined ? {} : { path: bounded.path }),
  };
  return new WebSocketServer(
    serverOptions,
  ) as unknown as WebSocketServerHandle;
}

function isRelayInfo(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  return String(payload["type"] ?? "").toLowerCase() === "info";
}

function rejectedHandshake(
  statusCode: number,
  closeCode: number,
  message: string,
): HandshakeDecision {
  return { accepted: false, statusCode, closeCode, message };
}

function validateListenOptions(
  platform: string,
  options: WebSocketServerOptions,
): void {
  if (normalizeHostname(options.host).length === 0) {
    throw new PlatformConfigurationError(
      platform,
      "WebSocket listen host must not be empty",
    );
  }
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 1 ||
    options.port > 65_535
  ) {
    throw new PlatformConfigurationError(
      platform,
      "WebSocket listen port must be an integer between 1 and 65535",
    );
  }
}

function positiveLimit(
  platform: string,
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new PlatformConfigurationError(
      platform,
      `${name} must be a positive safe integer`,
    );
  }
  return limit;
}

function relayCredential(
  platform: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > MAXIMUM_CREDENTIAL_BYTES ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    throw new PlatformConfigurationError(
      platform,
      `${RELAY_TOKEN_ENVIRONMENT_VARIABLE} must be a non-empty visible ASCII token no longer than ${MAXIMUM_CREDENTIAL_BYTES} bytes`,
    );
  }
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1"
  ) {
    return true;
  }
  if (isIP(normalized) === 4) {
    return normalized.split(".", 1)[0] === "127";
  }
  return /^::ffff:127(?:\.\d{1,3}){3}$/iu.test(normalized);
}

function isWildcardHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "0.0.0.0" || normalized === "::";
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function hostMatchesListener(
  header: string | undefined,
  listen: WebSocketServerOptions,
): boolean {
  if (header === undefined || header.length === 0) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${header}`);
  } catch {
    return false;
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return false;
  }
  const requestPort = parsed.port.length === 0 ? 80 : Number(parsed.port);
  const requestHostname = normalizeHostname(parsed.hostname);
  if (
    !Number.isInteger(requestPort) ||
    requestPort !== listen.port ||
    requestHostname.length === 0 ||
    isWildcardHostname(requestHostname)
  ) {
    return false;
  }
  return (
    isWildcardHostname(listen.host) ||
    requestHostname === normalizeHostname(listen.host)
  );
}

function isAllowedOrigin(
  header: string | string[] | undefined,
  authenticated: boolean,
): boolean {
  if (header === undefined) {
    return true;
  }
  if (Array.isArray(header) || header.length === 0) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(header);
  } catch {
    return false;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.origin === "null" ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return false;
  }
  return authenticated || parsed.origin === TRUSTED_BROWSER_RELAY_ORIGIN;
}

function hasValidBearerCredential(
  header: string | undefined,
  expected: string,
): boolean {
  const match =
    header === undefined ? null : /^Bearer ([\x21-\x7e]+)$/iu.exec(header);
  const supplied = match?.[1] ?? "";
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function webSocketFrameByteLength(data: unknown): number {
  if (typeof data === "string") {
    return Buffer.byteLength(data);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (data instanceof Blob) {
    return data.size;
  }
  if (!Array.isArray(data)) {
    return Number.MAX_SAFE_INTEGER;
  }
  let total = 0;
  for (const chunk of data) {
    const byteLength = ArrayBuffer.isView(chunk)
      ? chunk.byteLength
      : chunk instanceof ArrayBuffer
        ? chunk.byteLength
        : Number.MAX_SAFE_INTEGER;
    if (total > Number.MAX_SAFE_INTEGER - byteLength) {
      return Number.MAX_SAFE_INTEGER;
    }
    total += byteLength;
  }
  return total;
}

function clearQueue(state: ConnectionState): void {
  state.queue.length = 0;
  state.queueHead = 0;
  state.queuedFrames = 0;
  state.queuedBytes = 0;
}

function detachConnectionListeners(state: ConnectionState): void {
  state.connection.off?.("message", state.listeners.message);
  state.connection.off?.("close", state.listeners.close);
  state.connection.off?.("error", state.listeners.error);
}

function closeConnection(
  connection: WebSocketConnection,
  code: number,
  reason: string,
): void {
  try {
    connection.close(code, reason);
  } catch {
    connection.terminate?.();
  }
}

function closeClientForShutdown(connection: WebSocketConnection): void {
  closeConnection(connection, 1001, "Event source disposed");
  if (connection.readyState !== 3) {
    try {
      connection.terminate?.();
    } catch {
      // The transport is already gone.
    }
  }
}
