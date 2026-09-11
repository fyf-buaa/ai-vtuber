import { createHash, createHmac, randomUUID } from "node:crypto";

import type { EventSource, LiveEventHandler } from "../core/contracts.js";
import {
  createBilibiliAcknowledgement,
  decodeBilibiliFrames,
  encodeBilibiliPacket,
} from "./bilibili-protocol.js";
import { normalizeLivePayload } from "./normalization.js";
import type {
  PlatformDependencies,
  PlatformErrorHandler,
  ReconnectOptions,
} from "./types.js";
import {
  abortError,
  isAbortError,
  isRecord,
  linkAbortSignal,
  PlatformConfigurationError,
  PlatformConnectionError,
  readJsonResponse,
} from "./utilities.js";
import {
  ReconnectingWebSocketSource,
  type WebSocketSession,
} from "./websocket-client.js";

const DEFAULT_START_URL = "https://live-open.biliapi.com/v2/app/start";
const DEFAULT_HEARTBEAT_URL =
  "https://live-open.biliapi.com/v2/app/heartbeat";
const DEFAULT_END_URL = "https://live-open.biliapi.com/v2/app/end";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_GAME_HEARTBEAT_INTERVAL_MS = 20_000;

export interface BilibiliPlatformOptions {
  readonly platform?: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly appId: number;
  readonly roomOwnerAuthCode: string;
  readonly startUrl?: string;
  readonly heartbeatUrl?: string;
  readonly endUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly socketHeartbeatIntervalMs?: number;
  readonly gameHeartbeatIntervalMs?: number;
  readonly reconnect: ReconnectOptions;
}

interface OpenLiveGame {
  readonly gameId: string;
  readonly authBody: string;
  readonly webSocketUrls: readonly string[];
}

class BilibiliOpenLiveApiError extends PlatformConnectionError {
  readonly code: number | undefined;

  constructor(
    platform: string,
    code: number | undefined,
    message: string | undefined,
  ) {
    super(
      platform,
      `Bilibili Open Live API error ${code ?? "unknown"}: ${message ?? "unknown error"}`,
    );
    this.name = "BilibiliOpenLiveApiError";
    this.code = code;
  }
}

export class BilibiliPlatformSource implements EventSource {
  readonly name: string;
  readonly #source: ReconnectingWebSocketSource;
  readonly #controller = new AbortController();
  readonly #unlinkExternalSignal: () => void;
  readonly #onError: PlatformErrorHandler;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #options: BilibiliPlatformOptions;
  readonly #requestTimeoutMs: number;
  readonly #gameHeartbeatIntervalMs: number;

  #activeGame: OpenLiveGame | undefined;
  #gameHeartbeatTimer: NodeJS.Timeout | undefined;
  #gameHeartbeatOperation: Promise<void> | undefined;
  #nextWebSocketUrl = 0;

  constructor(
    options: BilibiliPlatformOptions,
    dependencies: PlatformDependencies = {},
  ) {
    this.name = options.platform ?? "bilibili-platform";
    if (
      options.accessKeyId.trim().length === 0 ||
      options.accessKeySecret.trim().length === 0 ||
      options.roomOwnerAuthCode.trim().length === 0
    ) {
      throw new PlatformConfigurationError(
        this.name,
        "Open Live credentials must not be empty",
      );
    }
    requirePositiveInteger(this.name, "appId", options.appId);
    this.#requestTimeoutMs = requirePositiveInteger(
      this.name,
      "requestTimeoutMs",
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const socketHeartbeatIntervalMs = requirePositiveInteger(
      this.name,
      "socketHeartbeatIntervalMs",
      options.socketHeartbeatIntervalMs ?? DEFAULT_SOCKET_HEARTBEAT_INTERVAL_MS,
    );
    this.#gameHeartbeatIntervalMs = requirePositiveInteger(
      this.name,
      "gameHeartbeatIntervalMs",
      options.gameHeartbeatIntervalMs ?? DEFAULT_GAME_HEARTBEAT_INTERVAL_MS,
    );
    this.#options = options;
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#now = dependencies.now ?? Date.now;
    this.#onError =
      dependencies.onError ??
      ((error) => console.error(`[${this.name}] ${error.message}`, error));
    this.#unlinkExternalSignal = linkAbortSignal(
      dependencies.signal,
      this.#controller,
    );

    this.#source = new ReconnectingWebSocketSource({
      name: this.name,
      session: async (signal): Promise<WebSocketSession> => {
        const game = await startOpenLiveGame(
          options,
          this.#fetch,
          this.#now,
          this.#requestTimeoutMs,
          signal,
          this.name,
        );
        this.#activeGame = game;
        const webSocketUrl =
          game.webSocketUrls[
            this.#nextWebSocketUrl % game.webSocketUrls.length
          ]!;
        this.#nextWebSocketUrl += 1;
        let ended = false;
        return {
          url: webSocketUrl,
          initialMessages: [encodeBilibiliPacket(7, game.authBody)],
          decode: decodeBilibiliFrames,
          acknowledgement: createBilibiliAcknowledgement(this.name),
          heartbeat: {
            intervalMs: socketHeartbeatIntervalMs,
            createPayload: () => encodeBilibiliPacket(2, "{}"),
            sendImmediately: true,
          },
          dispose: async () => {
            if (ended) {
              return;
            }
            ended = true;
            if (this.#activeGame === game) {
              this.#activeGame = undefined;
            }
            await endOpenLiveGame(
              options,
              game.gameId,
              this.#fetch,
              this.#now,
              this.#requestTimeoutMs,
              this.name,
            );
          },
        };
      },
      normalize: (payload) => {
        const gameId = interactionEndedGameId(payload);
        if (
          gameId !== undefined &&
          gameId === this.#activeGame?.gameId
        ) {
          this.#source.requestReconnect("Open Live interaction ended");
          return [];
        }
        return normalizeLivePayload(payload, {
          platform: this.name,
          now: this.#now,
        });
      },
      reconnect: options.reconnect,
      ...(dependencies.webSocketFactory === undefined
        ? {}
        : { webSocketFactory: dependencies.webSocketFactory }),
      ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
      signal: this.#controller.signal,
      ...(dependencies.random === undefined ? {} : { random: dependencies.random }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      onError: this.#onError,
    });
  }

  async start(handler: LiveEventHandler): Promise<void> {
    await this.#source.start(handler);
    if (this.#controller.signal.aborted) {
      throw abortError(this.#controller.signal.reason);
    }
    this.#gameHeartbeatTimer = setInterval(() => {
      this.#startGameHeartbeat();
    }, this.#gameHeartbeatIntervalMs);
    this.#gameHeartbeatTimer.unref?.();
  }

  async dispose(): Promise<void> {
    clearInterval(this.#gameHeartbeatTimer);
    this.#gameHeartbeatTimer = undefined;
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(
        new DOMException("Bilibili platform source disposed", "AbortError"),
      );
    }
    await this.#gameHeartbeatOperation?.catch(() => undefined);
    await this.#source.dispose();
    this.#unlinkExternalSignal();
  }

  #startGameHeartbeat(): void {
    if (
      this.#controller.signal.aborted ||
      this.#activeGame === undefined ||
      this.#gameHeartbeatOperation !== undefined
    ) {
      return;
    }
    const game = this.#activeGame;
    const operation = this.#sendGameHeartbeat(game).finally(() => {
      if (this.#gameHeartbeatOperation === operation) {
        this.#gameHeartbeatOperation = undefined;
      }
    });
    this.#gameHeartbeatOperation = operation;
  }

  async #sendGameHeartbeat(game: OpenLiveGame): Promise<void> {
    try {
      await requestOpenLiveApi(
        this.#options.heartbeatUrl ?? DEFAULT_HEARTBEAT_URL,
        { game_id: game.gameId },
        this.#options,
        this.#fetch,
        this.#now,
        this.#requestTimeoutMs,
        this.#controller.signal,
        this.name,
      );
    } catch (error) {
      if (this.#controller.signal.aborted || isAbortError(error)) {
        return;
      }
      this.#onError(
        error instanceof Error ? error : new Error(String(error)),
      );
      if (
        error instanceof BilibiliOpenLiveApiError &&
        error.code === 7003 &&
        this.#activeGame === game
      ) {
        this.#source.requestReconnect("Open Live heartbeat reported a closed game");
      }
    }
  }
}

async function startOpenLiveGame(
  options: BilibiliPlatformOptions,
  fetchImplementation: typeof globalThis.fetch,
  now: () => number,
  requestTimeoutMs: number,
  signal: AbortSignal,
  platform: string,
): Promise<OpenLiveGame> {
  const body = await requestOpenLiveApi(
    options.startUrl ?? DEFAULT_START_URL,
    {
      code: options.roomOwnerAuthCode,
      app_id: options.appId,
    },
    options,
    fetchImplementation,
    now,
    requestTimeoutMs,
    signal,
    platform,
  );
  if (!isRecord(body["data"])) {
    throw new PlatformConnectionError(
      platform,
      "Bilibili start response did not contain data",
    );
  }
  const data = body["data"];
  const gameInfo = data["game_info"];
  const websocketInfo = data["websocket_info"];
  if (!isRecord(gameInfo) || !isRecord(websocketInfo)) {
    throw new PlatformConnectionError(
      platform,
      "Bilibili start response omitted game_info or websocket_info",
    );
  }
  const gameId = scalarText(gameInfo["game_id"]);
  const authValue = websocketInfo["auth_body"];
  const authBody =
    typeof authValue === "string"
      ? authValue.trim().length === 0
        ? undefined
        : authValue
      : isRecord(authValue)
        ? JSON.stringify(authValue)
        : undefined;
  const links = websocketInfo["wss_link"];
  const candidates = Array.isArray(links)
    ? links.filter((link): link is string => typeof link === "string")
    : typeof links === "string"
      ? [links]
      : [];
  const webSocketUrls = candidates.filter((link) => {
    try {
      const url = new URL(link);
      return url.protocol === "wss:";
    } catch {
      return false;
    }
  });
  if (
    gameId === undefined ||
    authBody === undefined ||
    webSocketUrls.length === 0
  ) {
    throw new PlatformConnectionError(
      platform,
      "Bilibili start response omitted game_id, auth_body, or a WebSocket URL",
    );
  }
  return { gameId, authBody, webSocketUrls };
}

async function endOpenLiveGame(
  options: BilibiliPlatformOptions,
  gameId: string,
  fetchImplementation: typeof globalThis.fetch,
  now: () => number,
  requestTimeoutMs: number,
  platform: string,
): Promise<void> {
  try {
    await requestOpenLiveApi(
      options.endUrl ?? DEFAULT_END_URL,
      { app_id: options.appId, game_id: gameId },
      options,
      fetchImplementation,
      now,
      requestTimeoutMs,
      undefined,
      platform,
      [7000, 7003],
    );
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
  }
}

async function requestOpenLiveApi(
  endpoint: string,
  payload: Readonly<Record<string, unknown>>,
  options: BilibiliPlatformOptions,
  fetchImplementation: typeof globalThis.fetch,
  now: () => number,
  requestTimeoutMs: number,
  signal: AbortSignal | undefined,
  platform: string,
  additionallyAcceptedCodes: readonly number[] = [],
): Promise<Readonly<Record<string, unknown>>> {
  const requestBody = JSON.stringify(payload);
  const signedHeaders: Record<string, string> = {
    "x-bili-accesskeyid": options.accessKeyId,
    "x-bili-content-md5": createHash("md5")
      .update(requestBody)
      .digest("hex"),
    "x-bili-signature-method": "HMAC-SHA256",
    "x-bili-signature-nonce": randomUUID().replaceAll("-", ""),
    "x-bili-signature-version": "1.0",
    "x-bili-timestamp": String(Math.floor(now() / 1_000)),
  };
  const signaturePayload = Object.keys(signedHeaders)
    .sort()
    .map((key) => `${key}:${signedHeaders[key]}`)
    .join("\n");
  const authorization = createHmac("sha256", options.accessKeySecret)
    .update(signaturePayload)
    .digest("hex");

  return withRequestTimeout(requestTimeoutMs, signal, async (requestSignal) => {
    let response: Response;
    try {
      response = await fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          ...signedHeaders,
          Authorization: authorization,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: requestBody,
        signal: requestSignal,
      });
    } catch (cause) {
      throw new PlatformConnectionError(
        platform,
        `Bilibili Open Live request to ${endpointOrigin(endpoint)} failed`,
        { cause },
      );
    }
    const responseBody = await readJsonResponse(response, requestSignal);
    if (!response.ok) {
      throw new PlatformConnectionError(
        platform,
        `Bilibili Open Live returned HTTP ${response.status}`,
      );
    }
    if (!isRecord(responseBody)) {
      throw new PlatformConnectionError(
        platform,
        "Bilibili Open Live returned a non-object response",
      );
    }
    const numericCode = Number(responseBody["code"]);
    const code = Number.isFinite(numericCode) ? numericCode : undefined;
    if (
      code !== 0 &&
      (code === undefined || !additionallyAcceptedCodes.includes(code))
    ) {
      throw new BilibiliOpenLiveApiError(
        platform,
        code,
        scalarText(responseBody["message"] ?? responseBody["msg"]),
      );
    }
    return responseBody;
  });
}


function interactionEndedGameId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const command = scalarText(payload["cmd"] ?? payload["command"])
    ?.split(":", 1)[0]
    ?.toUpperCase();
  if (command !== "LIVE_OPEN_PLATFORM_INTERACTION_END") {
    return undefined;
  }
  const data = isRecord(payload["data"]) ? payload["data"] : undefined;
  return data === undefined ? undefined : scalarText(data["game_id"]);
}

function scalarText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "an invalid endpoint";
  }
}

function requirePositiveInteger(
  platform: string,
  name: string,
  value: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PlatformConfigurationError(
      platform,
      `${name} must be a positive safe integer`,
    );
  }
  return value;
}

async function withRequestTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () =>
      timeoutController.abort(
        new DOMException("Bilibili Open Live request timed out", "TimeoutError"),
      ),
    timeoutMs,
  );
  timeout.unref?.();
  const requestSignal =
    signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([signal, timeoutController.signal]);
  try {
    return await operation(requestSignal);
  } finally {
    clearTimeout(timeout);
  }
}
