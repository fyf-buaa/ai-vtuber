import WebSocket, { type ClientOptions } from "ws";

import type { LiveEvent } from "../domain/types.js";
import type { EventSource, LiveEventHandler } from "../core/contracts.js";
import type {
  AbortableSleep,
  PayloadNormalizer,
  PlatformErrorHandler,
  ReconnectOptions,
  WebSocketConnection,
  WebSocketConnectOptions,
  WebSocketFactory,
} from "./types.js";
import {
  abortError,
  asError,
  backoffDelay,
  defaultSleep,
  deferred,
  isAbortError,
  linkAbortSignal,
  PlatformConfigurationError,
  PlatformConnectionError,
} from "./utilities.js";
const DEFAULT_MAXIMUM_QUEUED_FRAMES = 256;
const DEFAULT_MAXIMUM_QUEUED_BYTES = 4 * 1024 * 1024;
const QUEUE_OVERFLOW_CLOSE_CODE = 1009;
const QUEUE_OVERFLOW_CLOSE_REASON = "Inbound message queue overflow";

interface BoundedWebSocketConnectOptions extends WebSocketConnectOptions {
  readonly maxPayload: number;
}

export type WebSocketAcknowledgement = (
  payload: unknown,
) => boolean | Error;

export interface WebSocketSession {
  readonly url: string;
  readonly protocols?: string | readonly string[];
  readonly options?: WebSocketConnectOptions;
  readonly initialMessages?: readonly (string | Uint8Array)[];
  readonly decode?: (
    data: unknown,
    isBinary: boolean,
    connection: WebSocketConnection,
  ) => readonly unknown[] | Promise<readonly unknown[]>;
  readonly acknowledgement?: WebSocketAcknowledgement;
  readonly heartbeat?: {
    readonly intervalMs: number;
    readonly createPayload: () => string | Uint8Array;
    readonly sendImmediately?: boolean;
  };
  readonly dispose?: () => Promise<void>;
}

export interface ReconnectingWebSocketSourceOptions {
  readonly name: string;
  readonly session: (signal: AbortSignal) => Promise<WebSocketSession>;
  readonly normalize: PayloadNormalizer;
  readonly reconnect: ReconnectOptions;
  readonly maximumQueuedFrames?: number;
  readonly maximumQueuedBytes?: number;
  readonly maximumPayloadBytes?: number;
  readonly webSocketFactory?: WebSocketFactory;
  readonly sleep?: AbortableSleep;
  readonly signal?: AbortSignal;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly onError?: PlatformErrorHandler;
}

interface ConnectionResult {
  readonly lifetimeMs: number;
  readonly code: number;
  readonly reason: string;
}

interface QueuedWebSocketFrame {
  readonly data: unknown;
  readonly isBinary: boolean;
  readonly byteLength: number;
}

export class ReconnectingWebSocketSource implements EventSource {
  readonly name: string;

  readonly #sessionFactory: (signal: AbortSignal) => Promise<WebSocketSession>;
  readonly #normalize: PayloadNormalizer;
  readonly #reconnect: ReconnectOptions;
  readonly #maximumQueuedFrames: number;
  readonly #maximumQueuedBytes: number;
  readonly #maximumPayloadBytes: number;
  readonly #webSocketFactory: WebSocketFactory;
  readonly #sleep: AbortableSleep;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #onError: PlatformErrorHandler;
  readonly #controller = new AbortController();
  readonly #unlinkExternalSignal: () => void;
  readonly #ready = deferred<void>();

  #handler: LiveEventHandler | undefined;
  #activeConnection: WebSocketConnection | undefined;
  #runPromise: Promise<void> | undefined;
  #started = false;

  constructor(options: ReconnectingWebSocketSourceOptions) {
    this.name = options.name;
    this.#sessionFactory = options.session;
    this.#normalize = options.normalize;
    this.#reconnect = options.reconnect;
    this.#maximumQueuedFrames = queueLimit(
      this.name,
      "maximumQueuedFrames",
      options.maximumQueuedFrames,
      DEFAULT_MAXIMUM_QUEUED_FRAMES,
    );
    this.#maximumQueuedBytes = queueLimit(
      this.name,
      "maximumQueuedBytes",
      options.maximumQueuedBytes,
      DEFAULT_MAXIMUM_QUEUED_BYTES,
    );
    this.#maximumPayloadBytes = queueLimit(
      this.name,
      "maximumPayloadBytes",
      options.maximumPayloadBytes,
      this.#maximumQueuedBytes,
    );
    if (this.#maximumPayloadBytes > this.#maximumQueuedBytes) {
      throw new PlatformConfigurationError(
        this.name,
        "maximumPayloadBytes must not exceed maximumQueuedBytes",
      );
    }
    this.#webSocketFactory =
      options.webSocketFactory ?? defaultWebSocketFactory;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#onError =
      options.onError ??
      ((error) => console.error(`[${this.name}] ${error.message}`, error));
    this.#unlinkExternalSignal = linkAbortSignal(
      options.signal,
      this.#controller,
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
    this.#runPromise = this.#run();
    await this.#ready.promise;
  }
  requestReconnect(reason = "Event source requested reconnection"): void {
    const connection = this.#activeConnection;
    if (connection !== undefined) {
      closeConnection(connection, 1012, reason);
    }
  }

  async dispose(): Promise<void> {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new DOMException("Event source disposed", "AbortError"));
    }
    const connection = this.#activeConnection;
    if (connection !== undefined) {
      closeConnection(connection, 1001, "Event source disposed");
    }
    if (this.#started && !this.#ready.settled()) {
      this.#ready.reject(abortError(this.#controller.signal.reason));
    }
    await this.#runPromise?.catch(() => undefined);
    this.#unlinkExternalSignal();
  }

  async #run(): Promise<void> {
    const signal = this.#controller.signal;
    let attempt = 0;
    let finalError: Error | undefined;

    while (!signal.aborted) {
      let session: WebSocketSession | undefined;
      try {
        session = await this.#sessionFactory(signal);
        validateSession(this.name, session);
        const result = await this.#runConnection(session, signal);
        if (signal.aborted) {
          break;
        }
        finalError = new PlatformConnectionError(
          this.name,
          `closed with code ${result.code}${result.reason.length > 0 ? ` (${result.reason})` : ""}`,
        );
        attempt =
          result.lifetimeMs >= this.#reconnect.stableConnectionMs
            ? 1
            : attempt + 1;
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          break;
        }
        finalError = asError(error);
        if (finalError instanceof PlatformConfigurationError) {
          if (!this.#ready.settled()) {
            this.#ready.reject(finalError);
          }
          this.#onError(finalError);
          return;
        }
        attempt += 1;
      } finally {
        this.#activeConnection = undefined;
        if (session?.dispose !== undefined) {
          try {
            await session.dispose();
          } catch (error) {
            if (!signal.aborted) {
              this.#onError(asError(error));
            }
          }
        }
      }

      if (finalError !== undefined) {
        this.#onError(finalError);
      }
      if (attempt > this.#reconnect.maximumAttempts) {
        const exhausted = new PlatformConnectionError(
          this.name,
          `reconnect limit (${this.#reconnect.maximumAttempts}) exhausted`,
          finalError === undefined ? undefined : { cause: finalError },
        );
        if (!this.#ready.settled()) {
          this.#ready.reject(exhausted);
        } else {
          this.#onError(exhausted);
        }
        return;
      }

      const delay = backoffDelay(attempt, this.#reconnect, this.#random);
      try {
        await this.#sleep(delay, signal);
      } catch (error) {
        if (!isAbortError(error) && !signal.aborted) {
          this.#onError(asError(error));
        }
        break;
      }
    }

    if (!this.#ready.settled()) {
      this.#ready.reject(abortError(signal.reason));
    }
  }

  async #runConnection(
    session: WebSocketSession,
    signal: AbortSignal,
  ): Promise<ConnectionResult> {
    const connectOptions: BoundedWebSocketConnectOptions = {
      ...(session.options ?? {}),
      maxPayload: this.#maximumPayloadBytes,
    };
    const connection = this.#webSocketFactory(
      session.url,
      session.protocols,
      connectOptions,
    );
    this.#activeConnection = connection;
    const opened = deferred<void>();
    const closed = deferred<{ code: number; reason: string }>();
    const acknowledged = deferred<void>();
    const failed = deferred<never>();
    const pendingPayloads: unknown[] = [];
    const frameQueue: Array<QueuedWebSocketFrame | undefined> = [];
    let pendingPayloadBytes = 0;
    let pendingPayloadHead = 0;
    let frameQueueHead = 0;
    let queuedFrameCount = 0;
    let queuedFrameBytes = 0;
    let acceptingMessages = true;
    let processingActive = false;
    let readyAt: number | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let processing = Promise.resolve();
    let listenersReleased = false;

    const releaseConnectionListeners = (): void => {
      if (listenersReleased) {
        return;
      }
      listenersReleased = true;
      connection.off?.("open", onOpen);
      connection.off?.("message", onMessage);
      connection.off?.("close", onClose);
      connection.off?.("error", onError);
    };


    const clearQueues = (): void => {
      pendingPayloads.length = 0;
      pendingPayloadBytes = 0;
      pendingPayloadHead = 0;
      frameQueue.length = 0;
      frameQueueHead = 0;
      queuedFrameCount = 0;
      queuedFrameBytes = 0;
    };
    const failQueue = (
      queue: string,
      attemptedFrames: number,
      attemptedBytes: number,
    ): void => {
      if (!acceptingMessages) {
        return;
      }
      const error = new PlatformConnectionError(
        this.name,
        `${queue} queue overflow: ${attemptedFrames} frames / ${attemptedBytes} bytes exceed configured limits of ${this.#maximumQueuedFrames} frames / ${this.#maximumQueuedBytes} bytes; closing with WebSocket status ${QUEUE_OVERFLOW_CLOSE_CODE}`,
      );
      acceptingMessages = false;
      clearQueues();
      failed.reject(error);
      closeConnection(
        connection,
        QUEUE_OVERFLOW_CLOSE_CODE,
        QUEUE_OVERFLOW_CLOSE_REASON,
      );
    };
    const onOpen = (): void => opened.resolve();
    const onClose = (code: number, reason: Uint8Array): void => {
      acceptingMessages = false;
      clearQueues();
      closed.resolve({ code, reason: Buffer.from(reason).toString("utf8") });
      if (!opened.settled()) {
        opened.reject(
          new PlatformConnectionError(this.name, `closed before opening (${code})`),
        );
      } else if (!acknowledged.settled()) {
        acknowledged.reject(
          new PlatformConnectionError(
            this.name,
            `closed before protocol acknowledgement (${code})`,
          ),
        );
      }
      releaseConnectionListeners();
    };
    const onError = (error: Error): void => {
      if (!acceptingMessages) {
        return;
      }
      if (!opened.settled()) {
        opened.reject(error);
      } else {
        this.#onError(asError(error));
      }
    };
    const dispatch = async (payload: unknown): Promise<void> => {
      if (!acceptingMessages) {
        return;
      }
      const events = this.#normalize(payload);
      const handler = this.#handler;
      if (handler === undefined) {
        return;
      }
      for (const event of events) {
        if (!acceptingMessages) {
          return;
        }
        await handler(event);
      }
    };
    const handlePayload = async (
      payload: unknown,
      byteLength: number,
    ): Promise<void> => {
      if (!acceptingMessages) {
        return;
      }
      if (!acknowledged.settled() && session.acknowledgement !== undefined) {
        const result = session.acknowledgement(payload);
        if (result instanceof Error) {
          acceptingMessages = false;
          clearQueues();
          acknowledged.reject(result);
          closeConnection(connection, 1008, "Protocol acknowledgement rejected");
          return;
        }
        if (result) {
          acknowledged.resolve();
          pendingPayloadBytes = 0;
          while (
            acceptingMessages &&
            pendingPayloadHead < pendingPayloads.length
          ) {
            const pending = pendingPayloads[pendingPayloadHead];
            pendingPayloads[pendingPayloadHead] = undefined;
            pendingPayloadHead += 1;
            await dispatch(pending);
          }
          pendingPayloads.length = 0;
          pendingPayloadHead = 0;
          return;
        }
        const nextFrameCount =
          pendingPayloads.length - pendingPayloadHead + 1;
        const nextByteLength = pendingPayloadBytes + byteLength;
        if (
          nextFrameCount > this.#maximumQueuedFrames ||
          nextByteLength > this.#maximumQueuedBytes
        ) {
          failQueue(
            "pre-acknowledgement payload",
            nextFrameCount,
            nextByteLength,
          );
          return;
        }
        pendingPayloads.push(payload);
        pendingPayloadBytes = nextByteLength;
        return;
      }
      await dispatch(payload);
    };
    const processFrameQueue = async (): Promise<void> => {
      const decoder = session.decode ?? decodeJsonWebSocketFrames;
      while (acceptingMessages && queuedFrameCount > 0) {
        const frameIndex = frameQueueHead;
        const frame = frameQueue[frameIndex];
        if (frame === undefined) {
          break;
        }
        try {
          const payloads = await decoder(
            frame.data,
            frame.isBinary,
            connection,
          );
          const payloadByteLength =
            payloads.length === 0
              ? 0
              : Math.ceil(frame.byteLength / payloads.length);
          for (const payload of payloads) {
            if (!acceptingMessages) {
              break;
            }
            await handlePayload(payload, payloadByteLength);
          }
        } catch (error) {
          this.#onError(asError(error));
        }
        if (frameQueue[frameIndex] === frame) {
          frameQueue[frameIndex] = undefined;
          frameQueueHead =
            (frameQueueHead + 1) % this.#maximumQueuedFrames;
          queuedFrameCount -= 1;
          queuedFrameBytes -= frame.byteLength;
          if (queuedFrameCount === 0) {
            frameQueue.length = 0;
            frameQueueHead = 0;
            queuedFrameBytes = 0;
          }
        }
      }
    };
    const startProcessing = (): void => {
      if (processingActive) {
        return;
      }
      processingActive = true;
      processing = processFrameQueue().finally(() => {
        processingActive = false;
        if (acceptingMessages && queuedFrameCount > 0) {
          startProcessing();
        }
      });
    };
    const onMessage = (data: unknown, isBinary: boolean): void => {
      if (!acceptingMessages) {
        return;
      }
      const byteLength = webSocketFrameByteLength(data);
      const nextFrameCount = queuedFrameCount + 1;
      const nextByteLength = queuedFrameBytes + byteLength;
      if (
        nextFrameCount > this.#maximumQueuedFrames ||
        nextByteLength > this.#maximumQueuedBytes
      ) {
        failQueue("inbound frame", nextFrameCount, nextByteLength);
        return;
      }
      const frameIndex =
        (frameQueueHead + queuedFrameCount) % this.#maximumQueuedFrames;
      frameQueue[frameIndex] = { data, isBinary, byteLength };
      queuedFrameCount = nextFrameCount;
      queuedFrameBytes = nextByteLength;
      startProcessing();
    };
    const onAbort = (): void => {
      acceptingMessages = false;
      clearQueues();
      const error = abortError(signal.reason);
      if (!opened.settled()) {
        opened.reject(error);
      } else if (!acknowledged.settled()) {
        acknowledged.reject(error);
      }
      closed.resolve({ code: 1001, reason: "aborted" });
      closeConnection(connection, 1001, "Event source aborted");
    };

    connection.on("open", onOpen);
    connection.on("message", onMessage);
    connection.on("close", onClose);
    connection.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await withTimeout(
        Promise.race([opened.promise, failed.promise]),
        this.#reconnect.connectionTimeoutMs,
        signal,
        `${this.name} WebSocket open`,
      );
      for (const message of session.initialMessages ?? []) {
        connection.send(message);
      }
      if (session.acknowledgement === undefined) {
        acknowledged.resolve();
      }
      await withTimeout(
        Promise.race([acknowledged.promise, failed.promise]),
        this.#reconnect.acknowledgementTimeoutMs,
        signal,
        `${this.name} protocol acknowledgement`,
      );
      readyAt = this.#now();
      this.#ready.resolve();

      if (session.heartbeat !== undefined) {
        const sendHeartbeat = (): void => {
          if (signal.aborted) {
            return;
          }
          try {
            connection.send(session.heartbeat!.createPayload());
          } catch (error) {
            this.#onError(asError(error));
            closeConnection(connection, 1011, "Heartbeat failed");
          }
        };
        if (session.heartbeat.sendImmediately === true) {
          sendHeartbeat();
        }
        heartbeatTimer = setInterval(
          sendHeartbeat,
          session.heartbeat.intervalMs,
        );
        heartbeatTimer.unref?.();
      }

      const close = await Promise.race([closed.promise, failed.promise]);
      await processing;
      return {
        lifetimeMs: Math.max(0, this.#now() - readyAt),
        code: close.code,
        reason: close.reason,
      };
    } finally {
      acceptingMessages = false;
      clearQueues();
      clearInterval(heartbeatTimer);
      signal.removeEventListener("abort", onAbort);
      closeConnection(connection, 1001, "Reconnecting");
      await processing;
    }
  }
}

export async function decodeWebSocketText(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  if (Array.isArray(data)) {
    const chunks = data.map((chunk) => {
      if (ArrayBuffer.isView(chunk)) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
      if (chunk instanceof ArrayBuffer) {
        return Buffer.from(chunk);
      }
      throw new TypeError("Unsupported WebSocket data chunk");
    });
    return Buffer.concat(chunks).toString("utf8");
  }
  if (data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer()).toString("utf8");
  }
  throw new TypeError(`Unsupported WebSocket message type: ${typeof data}`);
}

export async function decodeJsonWebSocketFrames(
  data: unknown,
): Promise<readonly unknown[]> {
  const text = (await decodeWebSocketText(data)).trim();
  if (text.length === 0) {
    return [];
  }
  try {
    return [JSON.parse(text) as unknown];
  } catch (wholeError) {
    const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    if (lines.length < 2) {
      throw new Error("WebSocket frame is not valid JSON", { cause: wholeError });
    }
    return lines.map((line) => JSON.parse(line) as unknown);
  }
}

function queueLimit(
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
    return 0;
  }
  let total = 0;
  for (const chunk of data) {
    const byteLength = ArrayBuffer.isView(chunk)
      ? chunk.byteLength
      : chunk instanceof ArrayBuffer
        ? chunk.byteLength
        : 0;
    if (total > Number.MAX_SAFE_INTEGER - byteLength) {
      return Number.MAX_SAFE_INTEGER;
    }
    total += byteLength;
  }
  return total;
}

function defaultWebSocketFactory(
  url: string,
  protocols?: string | readonly string[],
  options?: WebSocketConnectOptions,
): WebSocketConnection {
  const mutableProtocols: string | string[] | undefined =
    typeof protocols === "string"
      ? protocols
      : protocols === undefined
        ? undefined
        : [...protocols];
  const boundedOptions = options as BoundedWebSocketConnectOptions | undefined;
  const mutableOptions: ClientOptions = {
    maxPayload: boundedOptions?.maxPayload ?? DEFAULT_MAXIMUM_QUEUED_BYTES,
    ...(options?.headers === undefined
      ? {}
      : { headers: { ...options.headers } }),
  };
  if (options?.agent !== undefined) {
    mutableOptions.agent = options.agent as NonNullable<ClientOptions["agent"]>;
  }
  const connection =
    mutableProtocols === undefined
      ? new WebSocket(url, mutableOptions)
      : new WebSocket(url, mutableProtocols, mutableOptions);
  return connection as unknown as WebSocketConnection;
}

function validateSession(platform: string, session: WebSocketSession): void {
  let url: URL;
  try {
    url = new URL(session.url);
  } catch {
    throw new PlatformConfigurationError(platform, "WebSocket URL is invalid");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new PlatformConfigurationError(
      platform,
      "WebSocket endpoint must use ws:// or wss://",
    );
  }
}

function closeConnection(
  connection: WebSocketConnection,
  code: number,
  reason: string,
): void {
  try {
    if (connection.readyState === WebSocket.CONNECTING) {
      connection.terminate?.();
    } else if (
      connection.readyState === WebSocket.OPEN ||
      connection.readyState === WebSocket.CLOSING
    ) {
      connection.close(code, reason);
    }
  } catch {
    connection.terminate?.();
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  if (signal.aborted) {
    throw abortError(signal.reason);
  }
  const { promise: timeout, reject: rejectTimeout } =
    Promise.withResolvers<never>();
  const timer = setTimeout(
    () => rejectTimeout(new Error(`${label} timed out after ${milliseconds}ms`)),
    milliseconds,
  );
  timer.unref?.();
  const { promise: aborted, reject: rejectAborted } =
    Promise.withResolvers<never>();
  const onAbort = (): void => {
    rejectAborted(abortError(signal.reason));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, timeout, aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
