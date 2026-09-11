import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import {
  PiAgentConfigValidationError,
  createPiAgentCatalog,
  defaultPiCompatibleBaseUrl,
  validatePiAgentConfig,
  normalizePiAgentProvider,
  resolvePiAgentConfig,
} from "../agent/index.js";
import type { ObsCameraStatus } from "../output/obs-camera.js";
import { resolveCaptionDestination } from "../output/captions.js";

import {
  AnalyticsError,
  type CommentWordFrequencyOptions,
  type CommentWordFrequencyResult,
  type GiftAggregatesResult,
  type IntegralRankingResult,
} from "../features/analytics/index.js";
import type { IntegralRankingMetric } from "../persistence/index.js";
import { ContentServiceError } from "../features/content/errors.js";
import { mapOnlineSearchConfig } from "../features/content/legacy-config.js";
import {
  ConfigGenerationConflictError,
  type ConfigStore,
  type JsonObject,
} from "../config/config-store.js";
import { IdleConfigurationError, validateIdleConfig } from "../config/idle.js";
import { parseScheduleConfig, ScheduleConfigurationError } from "../config/schedule.js";
import {
  PENDING_PLATFORM_CONFIG_PATHS,
  isPlatformAvailable,
  platformAvailability,
} from "../platforms/availability.js";
import { SUPPORTED_PLATFORM_IDS } from "../platforms/registry.js";
import type {
  ProcessedReply,
  SpeechEnqueueOptions,
} from "../core/contracts.js";
import { EventProcessorOverloadError } from "../core/event-processor.js";
import type {
  AppEvent,
  EventPublisher,
  LiveEvent,
  LiveEventType,
  Metadata,
  SpeechRequest,
  SpeechStatus,
  SystemState,
} from "../domain/types.js";
import {
  SpeechCapacityError,
  listEdgeVoices,
  type EdgeVoice,
  type EdgeVoiceListOptions,
} from "../speech/index.js";
import {
  ConfigDocumentError,
  isSecretKey,
  REDACTED_VALUE,
  redactSecrets,
  restoreRedactedValues,
  validateConfigDocument,
} from "./config-redaction.js";

const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_OPERATOR_PORT = 8_081;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_SSE_CLIENTS = 32;
const DEFAULT_SSE_HISTORY_SIZE = 200;
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
const MAX_SSE_WRITE_BUFFER_BYTES = 256 * 1024;
const MAX_SSE_EVENT_BYTES = 32 * 1024;
const MAX_SSE_HISTORY_BYTES = 128 * 1024;
const AVATAR_COOKIE_NAME = "ai-vtuber-avatar";
const AVATAR_COOKIE_LIFETIME_MS = 60 * 60 * 1_000;
const AVATAR_PREFIX = "/avatar/Live2D/";
const MAX_CONTENT_LENGTH = 20_000;
const MAX_USERNAME_LENGTH = 256;
const MAX_PLATFORM_LENGTH = 128;
const ANALYTICS_RANKING_METRICS = new Set<IntegralRankingMetric>([
  "integral",
  "view_num",
  "sign_num",
  "total_price",
]);

const LIVE_EVENT_TYPES = new Set<LiveEventType>([
  "comment",
  "gift",
  "entrance",
  "follow",
  "talk",
  "schedule",
  "idle",
  "image",
]);

const LEGACY_PATHS = new Set([
  "/send",
  "/llm",
  "/tts",
  "/callback",
  "/get_sys_info",
  "/sys_cmd",
]);

const RESERVED_STATIC_PREFIXES = [
  "/api",
  "/avatar",
  "/healthz",
  "/readyz",
  ...LEGACY_PATHS,
] as const;

const LEGACY_ENVELOPE_FIELDS = new Set([
  "content",
  "username",
  "platform",
  "type",
  "metadata",
]);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".moc3": "application/octet-stream",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const NATIVE_EXECUTION_POLICY_PATHS: readonly (readonly string[])[] = [
  ["executable_actions"],
  ["action_executable_allowlist"],
  ["action_working_directory_allowlist"],
  ["actions", "executables"],
  ["actions", "executableAllowlist"],
  ["actions", "executable_allowlist"],
  ["actions", "workingDirectoryAllowlist"],
  ["actions", "working_directory_allowlist"],
  ["speech", "player"],
  ["play_audio", "player"],
  ["play_audio", "executable"],
  ["play_audio", "args"],
  ["virtual_microphone", "args"],
  ["virtual_microphone", "executable"],
  ["live2d", "host"],
  ["live2d", "port"],
  ["live2d", "camera", "obs_websocket_url"],
];

const CONFIG_READ_ONLY_PATHS: readonly (readonly string[])[] = [
  ...NATIVE_EXECUTION_POLICY_PATHS,
  ...PENDING_PLATFORM_CONFIG_PATHS,
];

export interface EventSubmitter {
  submit(
    event: LiveEvent,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProcessedReply | undefined>;
}

export interface RuntimeControls {
  status(): unknown | Promise<unknown>;
  stop(): Promise<void>;
  reload(): Promise<void>;
  updateConfig?(config: JsonObject, expectedGeneration: number): Promise<number>;
  start?(): Promise<void>;
  restore?(): Promise<void>;
  requestRestart?(): Promise<void>;
}

export interface OperatorSpeechService {
  enqueue(
    request: SpeechRequest,
    options?: SpeechEnqueueOptions,
  ): Promise<string>;
  status(): SpeechStatus;
}

export interface OperatorEventBus extends EventPublisher {
  subscribe(listener: (event: AppEvent) => void): () => void;
}

export interface PlaybackCallback {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ServerLogger {
  info?(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn?(message: string, context?: Readonly<Record<string, unknown>>): void;
  error?(message: string, context?: Readonly<Record<string, unknown>>): void;
}
export interface LocalBearerAuthorization {
  readonly configured: boolean;
  readonly authorized: boolean;
}

export type OperatorRequestAuthorizer = (
  request: IncomingMessage,
  localBearer: LocalBearerAuthorization,
) => boolean | Promise<boolean>;

type MaybePromise<T> = T | Promise<T>;

export interface OperatorAnalyticsService {
  commentWordFrequency(
    options?: CommentWordFrequencyOptions,
  ): MaybePromise<CommentWordFrequencyResult>;
  integralRanking(
    metric?: IntegralRankingMetric,
    requestedLimit?: number,
  ): MaybePromise<IntegralRankingResult>;
  giftAggregates(requestedLimit?: number): MaybePromise<GiftAggregatesResult>;
  isAvailable?(): MaybePromise<boolean>;
}

export interface OperatorAvatarStatus {
  readonly enabled: boolean;
  readonly modelName: string;
  readonly previewUrl: string | null;
  readonly camera: ObsCameraStatus;
}

export interface OperatorAvatarService {
  status(): Promise<OperatorAvatarStatus>;
  camera(action: "start" | "stop"): Promise<OperatorAvatarStatus>;
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

export interface OperatorServerDependencies {
  readonly configStore: Pick<
    ConfigStore,
    "get" | "path" | "reload" | "save" | "snapshot"
  > &
    Partial<Pick<ConfigStore, "generation">>;
  readonly eventSubmitter: EventSubmitter;
  readonly runtime: RuntimeControls;
  readonly speech: OperatorSpeechService;
  readonly events: OperatorEventBus;
  /**
   * Additional deny-only authorization. It runs only after the local bearer
   * check has succeeded and therefore cannot grant access around that check.
   */
  readonly authorizeRequest?: OperatorRequestAuthorizer;
  readonly analytics?: OperatorAnalyticsService;
  readonly avatar?: OperatorAvatarService;
  readonly edgeVoiceCatalog?: (
    options?: EdgeVoiceListOptions,
  ) => Promise<readonly EdgeVoice[]>;
  readonly onPlaybackCallback?: (
    callback: PlaybackCallback,
  ) => void | Promise<void>;
  readonly logger?: ServerLogger;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly createId?: () => string;
}

export interface OperatorServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly webRoot?: string;
  readonly applicationRoot?: string;
  readonly maxRequestBytes?: number;
  readonly maxSseClients?: number;
  readonly sseHistorySize?: number;
  readonly sseHeartbeatMs?: number;
}

export interface OperatorServerStartOptions {
  readonly host?: string;
  readonly port?: number;
}

export interface OperatorServerAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

type ServerState = "created" | "starting" | "ready" | "closing" | "closed";

type SerializedSseEvent = {
  readonly sequence: number;
  readonly frame: string;
  readonly byteLength: number;
};

type SseClient = {
  readonly id: string;
  readonly response: ServerResponse;
};

type AvatarRequest = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly dispose: () => void;
};

type PlaybackStatus = {
  readonly waitPlayAudio: number;
  readonly waitSynthesis: number;
  readonly updatedAt: number | null;
};

type ConfiguredStaticMatch = {
  readonly root: string;
  readonly relativePath: string;
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export class OperatorServer {
  private readonly applicationRoot: string;
  private readonly applicationRootRealPath: Promise<string>;
  private readonly dependencies: OperatorServerDependencies;
  private readonly options: Required<
    Pick<
      OperatorServerOptions,
      | "maxRequestBytes"
      | "maxSseClients"
      | "sseHeartbeatMs"
      | "sseHistorySize"
    >
  > &
    Pick<OperatorServerOptions, "host" | "port">;
  private readonly webRoot: string;
  private readonly webRootRealPath: Promise<string>;
  private readonly nodeServer: NodeHttpServer;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly avatarCookieSecret = randomBytes(32);
  private readonly eventHistory: SerializedSseEvent[] = [];
  private readonly sseClients = new Map<string, SseClient>();
  private readonly avatarRequests = new Set<AvatarRequest>();
  private eventHistoryBytes = 0;
  private readonly unsubscribeEvents: () => void;
  private state: ServerState = "created";
  private startedAt: number | null = null;
  private sequence = 0;
  private heartbeat: NodeJS.Timeout | undefined;
  private fallbackConfigRevision = 0;
  private configOperationTail: Promise<void> = Promise.resolve();
  private actionInProgress = false;
  private startOperation: Promise<OperatorServerAddress> | undefined;
  private closeOperation: Promise<void> | undefined;
  private startupController: AbortController | undefined;
  private playbackStatus: PlaybackStatus = {
    waitPlayAudio: 0,
    waitSynthesis: 0,
    updatedAt: null,
  };

  constructor(
    dependencies: OperatorServerDependencies,
    options: OperatorServerOptions = {},
  ) {
    this.dependencies = dependencies;
    this.options = {
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      maxRequestBytes: positiveInteger(
        options.maxRequestBytes,
        DEFAULT_MAX_REQUEST_BYTES,
        "maxRequestBytes",
      ),
      maxSseClients: positiveInteger(
        options.maxSseClients,
        DEFAULT_MAX_SSE_CLIENTS,
        "maxSseClients",
      ),
      sseHistorySize: positiveInteger(
        options.sseHistorySize,
        DEFAULT_SSE_HISTORY_SIZE,
        "sseHistorySize",
      ),
      sseHeartbeatMs: positiveInteger(
        options.sseHeartbeatMs,
        DEFAULT_SSE_HEARTBEAT_MS,
        "sseHeartbeatMs",
      ),
    };
    this.webRoot = resolve(options.webRoot ?? resolve(process.cwd(), "web"));
    this.applicationRoot = resolve(
      options.applicationRoot ?? resolve(this.webRoot, ".."),
    );
    this.webRootRealPath = realpath(this.webRoot).catch(() => this.webRoot);
    this.applicationRootRealPath = realpath(this.applicationRoot).catch(
      () => this.applicationRoot,
    );
    this.now = dependencies.now ?? Date.now;
    this.createId = dependencies.createId ?? randomUUID;
    this.nodeServer = createNodeServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.nodeServer.requestTimeout = 30_000;
    this.nodeServer.headersTimeout = 10_000;
    this.nodeServer.keepAliveTimeout = 5_000;
    this.nodeServer.maxHeadersCount = 100;
    this.nodeServer.on("clientError", (_error, socket) => {
      if (socket.writable) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      }
    });
    this.unsubscribeEvents = dependencies.events.subscribe((event) => {
      this.recordEvent(event);
    });
  }

  async start(
    overrides: OperatorServerStartOptions = {},
  ): Promise<OperatorServerAddress> {
    if (this.state !== "created") {
      throw new Error(`Operator server cannot start from state ${this.state}`);
    }
    const operation = this.startOnce(overrides);
    this.startOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.startOperation === operation) {
        this.startOperation = undefined;
      }
    }
  }

  close(): Promise<void> {
    if (this.state === "closed") {
      return Promise.resolve();
    }
    this.closeOperation ??= this.closeOnce();
    return this.closeOperation;
  }

  private async startOnce(
    overrides: OperatorServerStartOptions,
  ): Promise<OperatorServerAddress> {
    const host = normalizeHost(
      overrides.host ??
        this.options.host ??
        this.dependencies.configStore.get<string>("webui", "ip") ??
        this.dependencies.configStore.get<string>("api_ip") ??
        DEFAULT_HOST,
    );
    const port = normalizePort(
      overrides.port ??
        this.options.port ??
        this.dependencies.configStore.get<number>("webui", "port") ??
        this.dependencies.configStore.get<number>("api_port") ??
        DEFAULT_OPERATOR_PORT,
    );
    if (!isLoopbackAddress(host) && this.resolveAuthToken() === undefined) {
      throw new Error(
        "Operator server requires a bearer token before binding to a non-loopback host",
      );
    }

    this.state = "starting";
    const startupController = new AbortController();
    this.startupController = startupController;
    this.publishSystemStatus("starting", "操作台 HTTP 服务正在启动");

    try {
      await new Promise<void>((resolveStart, rejectStart) => {
        const cleanup = (): void => {
          this.nodeServer.off("error", onError);
          this.nodeServer.off("listening", onListening);
          startupController.signal.removeEventListener("abort", onAbort);
        };
        const onError = (error: Error): void => {
          cleanup();
          rejectStart(error);
        };
        const onListening = (): void => {
          cleanup();
          if (startupController.signal.aborted) {
            rejectStart(
              startupController.signal.reason ??
                new DOMException("Operator server startup cancelled", "AbortError"),
            );
            return;
          }
          resolveStart();
        };
        const onAbort = (): void => {
          cleanup();
          rejectStart(
            startupController.signal.reason ??
              new DOMException("Operator server startup cancelled", "AbortError"),
          );
        };
        this.nodeServer.once("error", onError);
        this.nodeServer.once("listening", onListening);
        startupController.signal.addEventListener("abort", onAbort, {
          once: true,
        });
        this.nodeServer.listen({
          host,
          port,
          signal: startupController.signal,
        });
      });
      startupController.signal.throwIfAborted();

      const address = this.nodeServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("Operator server did not expose a TCP address");
      }

      this.state = "ready";
      this.startedAt = this.now();
      this.startHeartbeat();
      const result = formatAddress(address, host);
      this.publishSystemStatus("ready", "操作台 HTTP 服务已就绪", {
        host: result.host,
        port: result.port,
      });
      this.dependencies.logger?.info?.("Operator HTTP server ready", {
        host: result.host,
        port: result.port,
      });
      return result;
    } catch (error) {
      if (this.state === "starting") {
        this.state = "created";
        this.publishSystemStatus("error", "操作台 HTTP 服务启动失败");
      }
      throw error;
    } finally {
      if (this.startupController === startupController) {
        this.startupController = undefined;
      }
    }
  }

  private async closeOnce(): Promise<void> {
    this.state = "closing";
    this.publishSystemStatus("stopping", "操作台 HTTP 服务正在关闭");
    this.startupController?.abort(
      new DOMException("Operator server shutdown requested", "AbortError"),
    );
    if (this.startOperation !== undefined) {
      await this.startOperation.catch(() => undefined);
    }

    let closeError: unknown;
    try {
      if (this.heartbeat !== undefined) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
      for (const client of this.sseClients.values()) {
        client.response.end();
      }
      this.sseClients.clear();
      for (const avatarRequest of this.avatarRequests) {
        avatarRequest.dispose();
      }
      this.avatarRequests.clear();

      if (this.nodeServer.listening) {
        await new Promise<void>((resolveClose, rejectClose) => {
          this.nodeServer.close((error) => {
            if (error === undefined) {
              resolveClose();
            } else {
              rejectClose(error);
            }
          });
          this.nodeServer.closeIdleConnections();
        });
      }
    } catch (error) {
      closeError = error;
    } finally {
      this.publishSystemStatus("stopped", "操作台 HTTP 服务已关闭");
      this.unsubscribeEvents();
      this.state = "closed";
    }
    if (closeError !== undefined) {
      throw closeError;
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestId = randomUUID();
    setSecurityHeaders(response, requestId);

    try {
      const url = parseRequestUrl(request.url);
      const path = url.pathname;
      const isAvatarPath = path.startsWith(AVATAR_PREFIX);
      const configuredStatic =
        path === "/settings" || path === "/settings/" || isAvatarPath
          ? undefined
          : this.matchConfiguredStatic(path);
      if (
        path.startsWith("/api/") ||
        isAvatarPath ||
        path === "/api" ||
        LEGACY_PATHS.has(path) ||
        configuredStatic !== undefined
      ) {
        const localBearer = isAvatarPath
          ? this.authenticateAvatar(request)
          : this.authenticate(request);
        await this.authorizeRequest(request, localBearer);
      }
      if (isAvatarPath) {
        requireMethod(request, ["GET", "HEAD"]);
        response.setHeader("X-Frame-Options", "SAMEORIGIN");
        response.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'",
        );
        await this.handleAvatarRequest(request, response);
        return;
      }
      switch (path) {
        case "/healthz":
          requireMethod(request, ["GET", "HEAD"]);
          sendJson(request, response, 200, {
            status: "ok",
            service: "operator-http",
          });
          return;
        case "/readyz":
          requireMethod(request, ["GET", "HEAD"]);
          await this.handleReadiness(request, response);
          return;
        case "/api/agent/catalog":
          requireMethod(request, ["GET", "HEAD"]);
          await this.handleAgentCatalog(request, response);
          return;
        case "/api/speech/edge/voices":
          requireMethod(request, ["GET", "HEAD"]);
          await this.handleEdgeVoiceCatalog(request, response);
          return;
        case "/api/avatar":
          requireMethod(request, ["GET", "HEAD"]);
          this.issueAvatarCookie(request, response);
          sendJson(request, response, 200, await this.requireAvatar().status());
          return;
        case "/api/avatar/camera":
          requireMethod(request, ["POST"]);
          await this.handleAvatarCamera(request, response);
          return;
        case "/api/config":
          if (request.method === "GET" || request.method === "HEAD") {
            this.handleGetConfig(request, response);
            return;
          }
          if (request.method === "PUT") {
            await this.handlePutConfig(request, response);
            return;
          }
          throw methodNotAllowed(["GET", "HEAD", "PUT"]);
        case "/api/events/manual":
          requireMethod(request, ["POST"]);
          await this.handleManualEvent(request, response);
          return;
        case "/api/events":
          requireMethod(request, ["GET"]);
          this.handleEventStream(request, response);
          return;
        case "/api/status":
          requireMethod(request, ["GET", "HEAD"]);
          await this.handleStatus(request, response);
          return;
        case "/api/actions":
          requireMethod(request, ["POST"]);
          await this.handleAction(request, response);
          return;
        case "/api/analytics/comment-word-frequency":
          requireMethod(request, ["GET", "HEAD"]);
          await this.handleCommentWordFrequency(request, response, url);
          return;
        case "/api/analytics/integral-ranking":
          requireMethod(request, ["GET", "HEAD"]);
          await this.handleIntegralRanking(request, response, url);
          return;
        case "/api/analytics/gift-aggregates":
          requireMethod(request, ["GET", "HEAD"]);
          await this.handleGiftAggregates(request, response, url);
          return;
        case "/send":
          requireMethod(request, ["POST"]);
          await this.handleLegacySend(request, response);
          return;
        case "/llm":
          requireMethod(request, ["POST"]);
          await this.handleLegacyLlm(request, response);
          return;
        case "/tts":
          requireMethod(request, ["POST"]);
          await this.handleLegacyTts(request, response);
          return;
        case "/callback":
          requireMethod(request, ["POST"]);
          await this.handleLegacyCallback(request, response);
          return;
        case "/get_sys_info":
          requireMethod(request, ["GET", "HEAD"]);
          await this.handleLegacySystemInfo(request, response);
          return;
        case "/sys_cmd":
          requireMethod(request, ["POST"]);
          await this.handleLegacySystemCommand(request, response);
          return;
        default:
          if (request.method !== "GET" && request.method !== "HEAD") {
            throw new HttpError(404, "not_found", "请求的资源不存在");
          }
          if (configuredStatic !== undefined) {
            await this.serveStaticFile(
              request,
              response,
              configuredStatic.root,
              configuredStatic.relativePath,
              await this.applicationRootRealPath,
            );
          } else {
            await this.handleWebStatic(request, response, path);
          }
      }
    } catch (error) {
      this.handleRequestError(error, requestId, response);
    }
  }

  private async handleAvatarRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let tracked: AvatarRequest | undefined;
    const dispose = (): void => {
      if (tracked === undefined) return;
      this.avatarRequests.delete(tracked);
      response.off("close", dispose);
      response.off("finish", dispose);
    };
    tracked = { request, response, dispose: () => {
      dispose();
      if (!response.writableEnded) response.end();
      if (!response.destroyed) response.destroy();
      if (!request.destroyed) request.destroy();
    } };
    this.avatarRequests.add(tracked);
    response.once("close", dispose);
    response.once("finish", dispose);
    try {
      await this.requireAvatar().handleRequest(request, response);
    } finally {
      // SSE handlers return before their response finishes; retain ownership until then.
      if (response.writableEnded || response.destroyed) dispose();
    }
  }

  private requireAvatar(): OperatorAvatarService {
    const avatar = this.dependencies.avatar;
    if (avatar === undefined) {
      throw new HttpError(503, "avatar_unavailable", "当前运行时未提供 Live2D 预览服务");
    }
    return avatar;
  }

  private avatarCookieSignature(expires: string): string {
    return createHmac("sha256", this.avatarCookieSecret)
      .update(expires)
      .update("\0")
      .update(this.resolveAuthToken() ?? "")
      .digest("base64url");
  }

  private issueAvatarCookie(request: IncomingMessage, response: ServerResponse): void {
    const expires = String(this.now() + AVATAR_COOKIE_LIFETIME_MS);
    const secure = "encrypted" in request.socket && request.socket.encrypted === true;
    response.setHeader(
      "Set-Cookie",
      `${AVATAR_COOKIE_NAME}=${expires}.${this.avatarCookieSignature(expires)}; Path=/avatar/; HttpOnly; SameSite=Strict; Max-Age=${AVATAR_COOKIE_LIFETIME_MS / 1_000}${secure ? "; Secure" : ""}`,
    );
  }

  private authenticateAvatar(request: IncomingMessage): LocalBearerAuthorization {
    if (request.headers.authorization !== undefined || this.resolveAuthToken() === undefined) {
      return this.authenticate(request);
    }
    const cookies = (request.headers.cookie ?? "").split(";");
    const value = cookies
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(`${AVATAR_COOKIE_NAME}=`))
      ?.slice(AVATAR_COOKIE_NAME.length + 1);
    const match = value?.match(/^(\d{13})\.([A-Za-z0-9_-]{43})$/u);
    if (
      match !== undefined &&
      match !== null &&
      Number(match[1]) > this.now() &&
      Number(match[1]) <= this.now() + AVATAR_COOKIE_LIFETIME_MS &&
      secureEqual(match[2]!, this.avatarCookieSignature(match[1]!))
    ) {
      return { configured: true, authorized: true };
    }
    return this.authenticate(request);
  }

  private async handleAvatarCamera(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = requireRecord(
      await readJson(request, this.options.maxRequestBytes),
      "请求体必须是 JSON 对象",
    );
    if (body.action !== "start" && body.action !== "stop") {
      throw new HttpError(422, "invalid_camera_action", "摄像头操作必须是 start 或 stop");
    }
    try {
      const status = await this.requireAvatar().camera(body.action);
      sendJson(request, response, 200, status);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : "OBS 虚拟摄像头操作失败";
      throw new HttpError(502, "avatar_camera_failed", String(redactSecrets(message)));
    }
  }

  private authenticate(request: IncomingMessage): LocalBearerAuthorization {
    const expectedToken = this.resolveAuthToken();
    if (expectedToken === undefined) {
      if (
        !isLoopbackAddress(request.socket.remoteAddress) ||
        !isSafeLoopbackHost(request.headers.host)
      ) {
        throw new HttpError(
          401,
          "unauthorized",
          "无令牌模式仅允许通过安全 Host 访问本机回环地址",
        );
      }
      return { configured: false, authorized: true };
    }

    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);
    if (match === null || match === undefined || !secureEqual(match[1] ?? "", expectedToken)) {
      throw new HttpError(
        401,
        "unauthorized",
        "需要有效的 Bearer 令牌",
        undefined,
        {
          "WWW-Authenticate": "Bearer realm=\"ai-vtuber-operator\", charset=\"UTF-8\"",
        },
      );
    }
    return { configured: true, authorized: true };
  }

  private async authorizeRequest(
    request: IncomingMessage,
    localBearer: LocalBearerAuthorization,
  ): Promise<void> {
    if (!localBearer.authorized) {
      throw new HttpError(401, "unauthorized", "需要有效的本地访问授权");
    }
    const authorize = this.dependencies.authorizeRequest;
    if (authorize === undefined) {
      return;
    }
    let authorized = false;
    try {
      authorized = await authorize(request, localBearer);
    } catch (error) {
      this.dependencies.logger?.warn?.("External request authorization failed", {
        error,
      });
    }
    if (!authorized) {
      throw new HttpError(
        403,
        "authorization_denied",
        "账户状态不允许访问此资源",
      );
    }
  }

  private resolveAuthToken(): string | undefined {
    const env = this.dependencies.env ?? process.env;
    const candidates: unknown[] = [
      env.AI_VTUBER_OPERATOR_TOKEN,
      env.AI_VTUBER_AUTH_TOKEN,
      this.dependencies.configStore.get<string>("server", "operator", "token"),
      this.dependencies.configStore.get<string>("server", "auth", "token"),
      this.dependencies.configStore.get<string>("operator", "auth", "token"),
      this.dependencies.configStore.get<string>("webui", "auth", "token"),
      this.dependencies.configStore.get<string>("webui", "auth_token"),
      this.dependencies.configStore.get<string>("webui", "api_token"),
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim() !== "") {
        return candidate.trim();
      }
    }
    return undefined;
  }

  private async handleReadiness(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.state !== "ready") {
      sendJson(request, response, 503, {
        status: "not_ready",
        error: { code: "server_not_ready", message: "操作台服务尚未就绪" },
      });
      return;
    }

    try {
      const runtime = await this.dependencies.runtime.status();
      const speech = this.dependencies.speech.status();
      if (
        !isRunningRuntimeStatus(runtime) ||
        speech.state === "stopping" ||
        speech.state === "stopped"
      ) {
        sendJson(request, response, 503, {
          status: "not_ready",
          error: {
            code: "dependency_not_ready",
            message: "运行时依赖尚未就绪",
          },
        });
        return;
      }
      sendJson(request, response, 200, { status: "ready" });
    } catch {
      sendJson(request, response, 503, {
        status: "not_ready",
        error: { code: "dependency_unavailable", message: "运行时依赖不可用" },
      });
    }
  }

  private handleGetConfig(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const revision = this.currentConfigRevision();
    response.setHeader("x-config-revision", String(revision));
    response.setHeader("etag", configRevisionEtag(revision));
    sendJson(request, response, 200, {
      config: redactSecrets(this.dependencies.configStore.snapshot()),
      revision,
      readOnlyPaths: CONFIG_READ_ONLY_PATHS.map((path) => [...path]),
    });
  }

  private async handleAgentCatalog(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const env = this.dependencies.env;
    const catalog = await createPiAgentCatalog(
      this.dependencies.configStore.snapshot(),
      env === undefined ? {} : { env },
    );
    sendJson(request, response, 200, catalog);
  }

  private async handleEdgeVoiceCatalog(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const root = this.dependencies.configStore.snapshot();
    const configured = root["edge-tts"];
    let trustedClientToken: string | undefined;
    let chromiumVersion: string | undefined;
    if (
      configured !== null &&
      typeof configured === "object" &&
      !Array.isArray(configured)
    ) {
      const section = configured as Readonly<Record<string, unknown>>;
      const configuredToken = section["trusted_client_token"];
      const configuredVersion = section["chromium_version"];
      if (
        typeof configuredToken === "string" &&
        configuredToken.trim().length > 0
      ) {
        trustedClientToken = configuredToken;
      }
      if (
        typeof configuredVersion === "string" &&
        configuredVersion.trim().length > 0
      ) {
        chromiumVersion = configuredVersion;
      }
    }
    const options: EdgeVoiceListOptions = {
      now: this.now,
      ...(trustedClientToken === undefined ? {} : { trustedClientToken }),
      ...(chromiumVersion === undefined ? {} : { chromiumVersion }),
    };

    let voices: readonly EdgeVoice[];
    try {
      voices = await (this.dependencies.edgeVoiceCatalog ?? listEdgeVoices)(
        options,
      );
    } catch (error) {
      this.dependencies.logger?.warn?.("Edge TTS voice list synchronization failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HttpError(
        502,
        "edge_voice_catalog_unavailable",
        "Edge TTS 语音列表同步失败",
      );
    }
    sendJson(request, response, 200, {
      schemaVersion: 1,
      fetchedAt: this.now(),
      voices,
    });
  }

  private async handlePutConfig(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const expectedRevision = requireConfigRevision(request.headers["if-match"]);
    const candidate = await readJson(request, this.options.maxRequestBytes);
    validateConfigDocument(candidate);

    const result = await this.enqueueConfigOperation(async () => {
      const currentRevision = this.currentConfigRevision();
      if (expectedRevision !== currentRevision) {
        throw configRevisionConflict(expectedRevision, currentRevision);
      }

      const current = this.dependencies.configStore.snapshot();
      const previousSearch = current["search_online"];
      const nextSearch = candidate["search_online"] === undefined
        ? undefined
        : requireRecord(candidate["search_online"], "search_online 必须是 JSON 对象");
      if (
        previousSearch !== null && typeof previousSearch === "object" && !Array.isArray(previousSearch) &&
        nextSearch !== null && typeof nextSearch === "object" && !Array.isArray(nextSearch) &&
        nextSearch["api_key"] === REDACTED_VALUE &&
        (previousSearch["provider"] !== nextSearch["provider"] || previousSearch["endpoint"] !== nextSearch["endpoint"])
      ) {
        throw new HttpError(422, "invalid_search_config", "修改 search_online.provider 或 endpoint 后必须重新填写 api_key，不能复用脱敏密钥");
      }
      assertRedactedAgentCredentialBindingUnchanged(
        current,
        candidate as JsonObject,
      );
      const restored = restoreRedactedValues(candidate, current);
      validateConfigDocument(restored);
      assertAvailablePlatformSelection(restored as JsonObject);
      validateCaptionOutputConfig(restored as JsonObject, this.applicationRoot);
      assertPendingPlatformConfigurationUnchanged(current, restored as JsonObject);
      try {
        parseScheduleConfig((restored as JsonObject)["schedule"]);
      } catch (error) {
        if (error instanceof ScheduleConfigurationError) {
          throw new HttpError(422, "invalid_schedule_config", error.message, {
            path: error.path.join("."),
          });
        }
        throw error;
      }
      if ((restored as JsonObject)["idle_time_task"] !== undefined) {
        try {
          validateIdleConfig((restored as JsonObject)["idle_time_task"]);
        } catch (error) {
          if (error instanceof IdleConfigurationError) {
            throw new HttpError(422, "invalid_idle_config", error.message, {
              path: error.path.join("."),
            });
          }
          throw error;
        }
      }
      try {
        mapOnlineSearchConfig(restored);
      } catch (error) {
        if (error instanceof ContentServiceError) {
          throw new HttpError(422, "invalid_search_config", error.message);
        }
        throw error;
      }
      assertNativeExecutionPolicyUnchanged(
        current,
        restored as JsonObject,
      );
      assertOperatorBindUnchangedForRemote(current, restored as JsonObject);
      try {
        const env = this.dependencies.env;
        await validatePiAgentConfig(
          restored,
          env === undefined ? {} : { env },
        );
      } catch (error) {
        if (error instanceof PiAgentConfigValidationError) {
          throw new HttpError(
            422,
            "invalid_agent_config",
            error.message,
          );
        }
        throw error;
      }
      try {
        let revision: number;
        if (this.dependencies.runtime.updateConfig !== undefined) {
          const reportedRevision =
            await this.dependencies.runtime.updateConfig(
              restored as JsonObject,
              expectedRevision,
            );
          revision = this.commitReportedConfigRevision(reportedRevision);
        } else {
          await this.dependencies.configStore.save(
            restored as JsonObject,
            expectedRevision,
          );
          await this.dependencies.configStore.reload();
          revision = this.commitFallbackConfigRevision();
        }
        this.publishStatus("config", "ready", "配置已原子保存并重新载入", {
          revision,
        });
        return {
          config: this.dependencies.configStore.snapshot(),
          revision,
        };
      } catch (error) {
        if (error instanceof ConfigGenerationConflictError) {
          throw configRevisionConflict(
            error.expectedGeneration,
            error.currentGeneration,
          );
        }
        throw new HttpError(
          500,
          "config_save_failed",
          "配置保存失败，原文件未被非原子覆盖",
        );
      }
    });

    response.setHeader("x-config-revision", String(result.revision));
    response.setHeader("etag", configRevisionEtag(result.revision));
    sendJson(request, response, 200, {
      message: "配置已保存并重新载入",
      config: redactSecrets(result.config),
      revision: result.revision,
      readOnlyPaths: CONFIG_READ_ONLY_PATHS.map((path) => [...path]),
    });
  }

  private async handleManualEvent(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = requireRecord(
      await readJson(request, this.options.maxRequestBytes),
      "请求体必须是 JSON 对象",
    );
    const event = this.createManualEvent(body);
    const reply = await this.submitEvent(event, request, response);
    sendJson(
      request,
      response,
      200,
      redactSecrets({
        accepted: true,
        processed: reply !== undefined,
        event: { id: event.id, type: event.type, timestamp: event.timestamp },
        reply,
      }),
    );
  }

  private async handleStatus(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let runtime: unknown;
    let speech: SpeechStatus;
    try {
      [runtime, speech] = await Promise.all([
        this.dependencies.runtime.status(),
        Promise.resolve(this.dependencies.speech.status()),
      ]);
    } catch {
      throw new HttpError(503, "status_unavailable", "暂时无法读取运行状态");
    }

    sendJson(
      request,
      response,
      200,
      redactSecrets({
        http: {
          state: this.state,
          startedAt: this.startedAt,
          uptimeMs: this.startedAt === null
            ? 0
            : Math.max(0, this.now() - this.startedAt),
          liveClients: this.sseClients.size,
        },
        runtime,
        speech,
        playback: this.playbackStatus,
      }),
    );
  }
  private async handleCommentWordFrequency(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const analytics = await this.requireAnalytics();
    const limit = optionalQueryInteger(url.searchParams, "limit");
    const sampleLimit = optionalQueryInteger(url.searchParams, "sampleLimit");
    const result = await this.runAnalytics(() =>
      analytics.commentWordFrequency({
        ...(limit === undefined ? {} : { limit }),
        ...(sampleLimit === undefined ? {} : { sampleLimit }),
      }),
    );
    sendJson(request, response, 200, redactSecrets(result));
  }

  private async handleIntegralRanking(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const analytics = await this.requireAnalytics();
    const requestedMetric = url.searchParams.get("metric");
    if (
      requestedMetric !== null &&
      !ANALYTICS_RANKING_METRICS.has(requestedMetric as IntegralRankingMetric)
    ) {
      throw new HttpError(
        422,
        "invalid_metric",
        `不支持的积分排行指标: ${requestedMetric}`,
        { field: "metric" },
      );
    }
    const metric =
      requestedMetric === null
        ? undefined
        : requestedMetric as IntegralRankingMetric;
    const limit = optionalQueryInteger(url.searchParams, "limit");
    const result = await this.runAnalytics(() =>
      analytics.integralRanking(metric, limit),
    );
    sendJson(request, response, 200, redactSecrets(result));
  }

  private async handleGiftAggregates(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const analytics = await this.requireAnalytics();
    const limit = optionalQueryInteger(url.searchParams, "limit");
    const result = await this.runAnalytics(() =>
      analytics.giftAggregates(limit)
    );
    sendJson(request, response, 200, redactSecrets(result));
  }

  private async requireAnalytics(): Promise<OperatorAnalyticsService> {
    const analytics = this.dependencies.analytics;
    if (
      analytics === undefined ||
      (analytics.isAvailable !== undefined && !await analytics.isAvailable())
    ) {
      throw new HttpError(404, "not_found", "请求的资源不存在");
    }
    return analytics;
  }

  private async runAnalytics<T>(
    operation: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AnalyticsError) {
        throw new HttpError(
          422,
          error.code === "INVALID_METRIC" ? "invalid_metric" : "invalid_limit",
          error.message,
        );
      }
      throw error;
    }
  }


  private async handleAction(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = requireRecord(
      await readJson(request, this.options.maxRequestBytes),
      "请求体必须是 JSON 对象",
    );
    const action = requiredString(body.action, "action", 32);
    if (action !== "stop" && action !== "reload") {
      throw new HttpError(
        422,
        "unsupported_action",
        "action 仅支持 stop 或 reload",
        { field: "action" },
      );
    }

    if (action === "stop") {
      this.reserveRuntimeAction();
      sendJson(request, response, 202, {
        ok: true,
        action,
        status: "scheduled",
      });
      this.scheduleRuntimeControl(
        "stop",
        () => this.dependencies.runtime.stop(),
        "stopped",
        "运行时已停止",
      );
      return;
    }

    await this.runRuntimeReload();
    let runtime: unknown = null;
    try {
      runtime = await this.dependencies.runtime.status();
    } catch {
      // The requested action succeeded; null explicitly marks no follow-up snapshot.
    }
    sendJson(
      request,
      response,
      200,
      redactSecrets({ ok: true, action, runtime }),
    );
  }

  private handleEventStream(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (this.sseClients.size >= this.options.maxSseClients) {
      throw new HttpError(503, "event_stream_full", "实时事件连接数已达上限");
    }

    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    response.socket?.setKeepAlive(true);

    const client: SseClient = { id: this.createId(), response };
    this.sseClients.set(client.id, client);
    response.write(
      `event: connected\ndata: ${JSON.stringify({ connectedAt: this.now() })}\n\n`,
    );

    const lastEventId = parseLastEventId(request.headers["last-event-id"]);
    const history = lastEventId === undefined
      ? this.eventHistory
      : this.eventHistory.filter((event) => event.sequence > lastEventId);
    for (const event of history) {
      if (!this.writeSseEvent(client, event)) {
        break;
      }
    }

    const remove = (): void => {
      this.sseClients.delete(client.id);
    };
    request.once("close", remove);
    response.once("close", remove);
  }

  private async handleLegacySend(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = requireRecord(
      await readJson(request, this.options.maxRequestBytes),
      "请求体必须是 JSON 对象",
    );
    const event = this.createLegacySendEvent(body);
    const reply = await this.submitEvent(event, request, response);
    sendJson(
      request,
      response,
      200,
      redactSecrets({
        code: 200,
        message: reply === undefined ? "已接收，事件未生成回复" : "成功",
        data: {
          event_id: event.id,
          processed: reply !== undefined,
          content: reply?.text,
        },
      }),
    );
  }

  private async handleLegacyLlm(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = requireRecord(
      await readJson(request, this.options.maxRequestBytes),
      "请求体必须是 JSON 对象",
    );
    const requestedType = optionalString(body.type, "comment", 128);
    const metadata: Record<string, unknown> = {
      legacyEndpoint: "llm",
      requestedType,
    };
    if (requestedType === "reread" || requestedType === "reread_top_priority") {
      metadata.chatType = "reread";
      metadata.legacyType = requestedType;
    }
    const event: LiveEvent = {
      id: this.createId(),
      type: "comment",
      platform: optionalString(body.platform, "http-api", MAX_PLATFORM_LENGTH),
      username: requiredString(body.username, "username", MAX_USERNAME_LENGTH),
      content: requiredString(body.content, "content", MAX_CONTENT_LENGTH),
      timestamp: this.now(),
      metadata,
    };
    const reply = await this.submitEvent(event, request, response);
    if (reply === undefined) {
      throw new HttpError(
        409,
        "event_not_processed",
        "请求被事件规则拦截，未生成回复",
      );
    }
    sendJson(request, response, 200, redactSecrets({
      code: 200,
      message: "成功",
      data: { content: reply.text },
    }));
  }

  private async handleLegacyTts(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = requireRecord(
      await readJson(request, this.options.maxRequestBytes),
      "请求体必须是 JSON 对象",
    );
    const speechRequest: SpeechRequest = {
      text: requiredString(body.content, "content", MAX_CONTENT_LENGTH),
      sourceEventId: typeof body.source_event_id === "string"
        ? body.source_event_id
        : undefined,
      metadata: {
        legacyEndpoint: "tts",
        legacyType: optionalString(body.type, "reread", 128),
        requestedTtsType: optionalString(body.tts_type, "configured", 128),
        username: optionalString(body.username, "操作员", MAX_USERNAME_LENGTH),
      },
    };

    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort(
        new DOMException("TTS client disconnected before admission", "AbortError"),
      );
    };
    request.once("aborted", cancel);
    response.once("close", cancel);
    try {
      const speechId = await this.dependencies.speech.enqueue(
        speechRequest,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || response.destroyed) {
        return;
      }
      sendJson(request, response, 202, {
        code: 200,
        message: "已加入语音队列",
        data: { speech_id: speechId, status: "queued" },
      });
    } catch (error) {
      if (controller.signal.aborted && (request.destroyed || response.destroyed)) {
        return;
      }
      if (error instanceof SpeechCapacityError) {
        throw new HttpError(429, "speech_busy", "语音队列繁忙，请稍后重试");
      }
      throw new HttpError(502, "speech_enqueue_failed", "语音任务入队失败");
    } finally {
      request.removeListener("aborted", cancel);
      response.removeListener("close", cancel);
    }
  }

  private async handleLegacyCallback(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = requireRecord(
      await readJson(request, this.options.maxRequestBytes),
      "请求体必须是 JSON 对象",
    );
    const type = requiredString(body.type, "type", 128);
    const data = requireRecord(body.data, "data 必须是 JSON 对象");

    let nextPlayback = this.playbackStatus;
    if (type === "audio_playback_completed") {
      nextPlayback = {
        waitPlayAudio: nonNegativeInteger(
          data.wait_play_audio_num,
          "data.wait_play_audio_num",
        ),
        waitSynthesis: nonNegativeInteger(
          data.wait_synthesis_msg_num,
          "data.wait_synthesis_msg_num",
        ),
        updatedAt: this.now(),
      };
    }

    try {
      await this.dependencies.onPlaybackCallback?.({ type, data });
    } catch {
      throw new HttpError(502, "callback_rejected", "播放状态回调处理失败");
    }
    this.playbackStatus = nextPlayback;
    this.publishStatus("speech", "ready", "已接收播放状态回调", {
      callbackType: type,
      waitPlayAudio: nextPlayback.waitPlayAudio,
      waitSynthesis: nextPlayback.waitSynthesis,
    });
    sendJson(request, response, 200, {
      code: 200,
      message: "callback处理成功！",
    });
  }

  private async handleLegacySystemInfo(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let runtime: unknown;
    let speech: SpeechStatus;
    try {
      [runtime, speech] = await Promise.all([
        this.dependencies.runtime.status(),
        Promise.resolve(this.dependencies.speech.status()),
      ]);
    } catch {
      throw new HttpError(503, "status_unavailable", "get_sys_info 暂时不可用");
    }

    sendJson(
      request,
      response,
      200,
      redactSecrets({
        code: 200,
        message: "get_sys_info处理成功！",
        data: {
          audio: speech,
          runtime,
        },
      }),
    );
  }

  private async handleLegacySystemCommand(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = requireRecord(
      await readJson(request, this.options.maxRequestBytes),
      "请求体必须是 JSON 对象",
    );
    const command = requiredString(body.type, "type", 32);
    const data = body.data === undefined
      ? Object.create(null) as Record<string, unknown>
      : requireRecord(body.data, "data 必须是 JSON 对象");
    assertLegacyConfigPaths(
      command,
      data,
      basename(this.dependencies.configStore.path),
    );

    if (!["run", "stop", "restart", "factory"].includes(command)) {
      throw new HttpError(
        422,
        "unsupported_action",
        "type 仅支持 run、stop、restart 或 factory",
        { field: "type" },
      );
    }

    if (command === "stop" || command === "restart") {
      if (
        command === "restart" &&
        this.dependencies.runtime.requestRestart === undefined
      ) {
        throw new HttpError(
          501,
          "restart_unsupported",
          "当前进程没有受监督重启能力",
        );
      }
      const operation = command === "stop"
        ? () => this.dependencies.runtime.stop()
        : () => this.dependencies.runtime.requestRestart!();
      this.reserveRuntimeAction();
      sendJson(request, response, 200, {
        code: 200,
        message: `${command} 命令已请求`,
      });
      this.scheduleRuntimeControl(
        command,
        operation,
        command === "stop" ? "stopped" : "stopping",
        command === "stop" ? "运行时已停止" : "已向进程监督器请求重启",
      );
      return;
    }

    this.reserveRuntimeAction();
    try {
      if (command === "run") {
        if (this.dependencies.runtime.start === undefined) {
          throw unsupportedRuntimeCommand(command);
        }
        await this.dependencies.runtime.start();
        this.publishStatus("runtime", "ready", "运行时已启动");
      } else {
        if (this.dependencies.runtime.restore === undefined) {
          throw unsupportedRuntimeCommand(command);
        }
        await this.dependencies.runtime.restore();
        this.publishStatus(
          "config",
          "ready",
          `已从 ${basename(this.dependencies.configStore.path)}.bak 原子恢复配置`,
        );
      }
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      this.publishStatus("runtime", "error", `系统命令 ${command} 执行失败`);
      throw new HttpError(502, "runtime_action_failed", `系统命令 ${command} 执行失败`);
    } finally {
      this.actionInProgress = false;
    }

    sendJson(request, response, 200, {
      code: 200,
      message: `${command} 命令执行成功`,
    });
  }

  private async runRuntimeReload(): Promise<void> {
    this.reserveRuntimeAction();
    try {
      this.publishStatus("runtime", "starting", "操作员请求重新载入运行时");
      await this.enqueueConfigOperation(async () => {
        await this.dependencies.runtime.reload();
      });
      this.publishStatus("runtime", "ready", "运行时已重新载入");
    } catch {
      this.publishStatus("runtime", "error", "运行时 reload 操作失败");
      throw new HttpError(502, "runtime_action_failed", "运行时 reload 操作失败");
    } finally {
      this.actionInProgress = false;
    }
  }

  private reserveRuntimeAction(): void {
    if (this.actionInProgress) {
      throw new HttpError(409, "action_in_progress", "另一个运行时操作正在执行");
    }
    this.actionInProgress = true;
  }

  private scheduleRuntimeControl(
    action: string,
    operation: () => Promise<void>,
    successStatus: SystemState,
    successMessage: string,
  ): void {
    this.publishStatus("runtime", "stopping", `操作员请求 ${action}`);
    setImmediate(() => {
      void Promise.resolve()
        .then(operation)
        .then(() => {
          this.publishStatus("runtime", successStatus, successMessage);
        })
        .catch(() => {
          this.publishStatus("runtime", "error", `运行时 ${action} 操作失败`);
          this.dependencies.logger?.error?.("Scheduled runtime control failed", {
            action,
          });
        })
        .finally(() => {
          this.actionInProgress = false;
        });
    });
  }

  private async handleWebStatic(
    request: IncomingMessage,
    response: ServerResponse,
    encodedPath: string,
  ): Promise<void> {
    const decodedPath = decodePath(encodedPath);
    const relativePath = decodedPath === "/"
      ? "index.html"
      : decodedPath === "/settings" || decodedPath === "/settings/"
        ? "settings.html"
        : decodedPath.slice(1);
    await this.serveStaticFile(
      request,
      response,
      await this.webRootRealPath,
      relativePath,
    );
  }

  private matchConfiguredStatic(encodedPath: string): ConfiguredStaticMatch | undefined {
    if (this.dependencies.configStore.get<boolean>(
      "webui",
      "local_dir_to_endpoint",
      "enable",
    ) !== true) {
      return undefined;
    }
    let requestPath: string;
    try {
      requestPath = decodeURIComponent(encodedPath);
    } catch {
      return undefined;
    }
    const entries = this.dependencies.configStore.get<unknown[]>(
      "webui",
      "local_dir_to_endpoint",
      "config",
    );
    if (!Array.isArray(entries)) {
      return undefined;
    }

    for (const entry of entries) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.url_path !== "string" || typeof record.local_dir !== "string") {
        continue;
      }
      const prefix = normalizeStaticPrefix(record.url_path);
      if (
        prefix === undefined ||
        RESERVED_STATIC_PREFIXES.some(
          (reserved) => prefix === reserved || prefix.startsWith(`${reserved}/`),
        )
      ) {
        continue;
      }
      if (!requestPath.startsWith(`${prefix}/`)) {
        continue;
      }
      const root = resolve(this.applicationRoot, record.local_dir);
      if (!isSafeRelativePath(relative(this.applicationRoot, root))) {
        continue;
      }
      return {
        root,
        relativePath: requestPath.slice(prefix.length + 1),
      };
    }
    return undefined;
  }

  private async serveStaticFile(
    request: IncomingMessage,
    response: ServerResponse,
    rootPath: string,
    relativePath: string,
    confinementRoot?: string,
  ): Promise<void> {
    assertSafeStaticRelativePath(relativePath);

    let root: string;
    try {
      root = await realpath(rootPath);
    } catch {
      throw new HttpError(404, "not_found", "请求的资源不存在");
    }
    if (
      confinementRoot !== undefined &&
      !isSafeRelativePath(relative(confinementRoot, root))
    ) {
      throw new HttpError(404, "not_found", "请求的资源不存在");
    }
    const candidate = resolve(root, relativePath);
    if (!isSafeRelativePath(relative(root, candidate))) {
      throw new HttpError(404, "not_found", "请求的资源不存在");
    }

    let actualPath: string;
    try {
      actualPath = await realpath(candidate);
    } catch {
      throw new HttpError(404, "not_found", "请求的资源不存在");
    }
    if (!isSafeRelativePath(relative(root, actualPath)) || this.isSensitiveFile(actualPath)) {
      throw new HttpError(404, "not_found", "请求的资源不存在");
    }

    const contentType = CONTENT_TYPES[extname(actualPath).toLowerCase()];
    if (contentType === undefined) {
      throw new HttpError(404, "not_found", "请求的资源不存在");
    }
    const fileStat = await stat(actualPath);
    if (!fileStat.isFile()) {
      throw new HttpError(404, "not_found", "请求的资源不存在");
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Length", String(fileStat.size));
    response.setHeader("Cache-Control", "no-cache");
    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const stream = createReadStream(actualPath);
    const controller = new AbortController();
    const abort = (): void => {
      if (!response.writableFinished) {
        controller.abort(
          new DOMException("Static file client disconnected", "AbortError"),
        );
      }
    };
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      await pipeline(stream, response, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) {
        return;
      }
      throw error;
    } finally {
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
      stream.destroy();
    }
  }

  private isSensitiveFile(actualPath: string): boolean {
    const configPath = resolve(this.dependencies.configStore.path);
    const resolvedPath = resolve(actualPath);
    if (resolvedPath === configPath || resolvedPath === `${configPath}.bak`) {
      return true;
    }
    const name = basename(resolvedPath).toLowerCase();
    return name.startsWith(".env") || [".key", ".p12", ".pem", ".pfx"].includes(extname(name));
  }

  private createManualEvent(body: Record<string, unknown>): LiveEvent {
    const rawType = optionalString(body.type, "comment", 32);
    if (!LIVE_EVENT_TYPES.has(rawType as LiveEventType)) {
      throw new HttpError(
        422,
        "unsupported_event_type",
        "不支持的事件类型",
        { field: "type" },
      );
    }
    const metadata = body.metadata === undefined
      ? Object.create(null) as Record<string, unknown>
      : requireRecord(body.metadata, "metadata 必须是 JSON 对象");

    return {
      id: this.createId(),
      type: rawType as LiveEventType,
      platform: optionalString(body.platform, "operator", MAX_PLATFORM_LENGTH),
      username: optionalString(body.username, "操作员", MAX_USERNAME_LENGTH),
      content: requiredString(body.content, "content", MAX_CONTENT_LENGTH),
      timestamp: this.now(),
      metadata,
    };
  }

  private createLegacySendEvent(body: Record<string, unknown>): LiveEvent {
    const envelopeType = requiredString(body.type, "type", 128);
    const data = requireRecord(body.data, "data 必须是 JSON 对象");
    const legacyType = typeof data.type === "string" && data.type.trim() !== ""
      ? data.type.trim()
      : envelopeType;
    const type = normalizeLegacyType(legacyType);
    const metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (!LEGACY_ENVELOPE_FIELDS.has(key)) {
        metadata[key] = value;
      }
    }
    if (data.metadata !== undefined) {
      Object.assign(metadata, requireRecord(data.metadata, "data.metadata 必须是 JSON 对象"));
    }
    metadata.legacyEndpoint = "send";
    metadata.legacyType = legacyType;
    if (legacyType === "reread" || legacyType === "reread_top_priority") {
      metadata.chatType = "reread";
    }

    return {
      id: this.createId(),
      type,
      platform: optionalString(data.platform, "http-api", MAX_PLATFORM_LENGTH),
      username: optionalString(data.username, "匿名用户", MAX_USERNAME_LENGTH),
      content: legacyContent(data, type),
      timestamp: this.now(),
      metadata,
    };
  }

  private async submitEvent(
    event: LiveEvent,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<ProcessedReply | undefined> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const abortIfOpen = (): void => {
      if (!response.writableEnded) {
        controller.abort();
      }
    };
    request.once("aborted", abort);
    response.once("close", abortIfOpen);
    try {
      return await this.dependencies.eventSubmitter.submit(event, {
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw error;
      }
      if (error instanceof EventProcessorOverloadError) {
        throw new HttpError(
          503,
          "event_processor_overloaded",
          "事件处理器当前已满，请稍后重试",
          { resource: error.resource, limit: error.limit },
        );
      }
      throw new HttpError(502, "event_processing_failed", "事件处理失败");
    } finally {
      request.off("aborted", abort);
      response.off("close", abortIfOpen);
    }
  }

  private recordEvent(event: AppEvent): void {
    const sequence = ++this.sequence;
    const payload = JSON.stringify(
      redactSecrets(stripSseImageBlobs(event)),
    );
    const frame = `id: ${sequence}\nevent: app-event\ndata: ${payload}\n\n`;
    const byteLength = Buffer.byteLength(frame);
    if (byteLength > MAX_SSE_EVENT_BYTES) {
      this.dependencies.logger?.warn?.("Operator SSE event exceeded byte limit", {
        sequence,
        byteLength,
        maximumBytes: MAX_SSE_EVENT_BYTES,
      });
      return;
    }

    const serialized: SerializedSseEvent = {
      sequence,
      frame,
      byteLength,
    };
    this.eventHistory.push(serialized);
    this.eventHistoryBytes += byteLength;
    while (
      this.eventHistory.length > this.options.sseHistorySize ||
      this.eventHistoryBytes > MAX_SSE_HISTORY_BYTES
    ) {
      const removed = this.eventHistory.shift();
      if (removed !== undefined) {
        this.eventHistoryBytes -= removed.byteLength;
      }
    }
    for (const client of this.sseClients.values()) {
      this.writeSseEvent(client, serialized);
    }
  }

  private writeSseEvent(client: SseClient, event: SerializedSseEvent): boolean {
    const response = client.response;
    if (response.destroyed || response.writableEnded) {
      this.sseClients.delete(client.id);
      return false;
    }
    if (
      response.writableLength + event.byteLength >
      MAX_SSE_WRITE_BUFFER_BYTES
    ) {
      response.end();
      this.sseClients.delete(client.id);
      return false;
    }
    response.write(event.frame);
    return true;
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      const frame = `: heartbeat ${this.now()}\n\n`;
      const frameBytes = Buffer.byteLength(frame);
      for (const client of this.sseClients.values()) {
        if (client.response.destroyed || client.response.writableEnded) {
          this.sseClients.delete(client.id);
          continue;
        }
        if (
          client.response.writableLength + frameBytes >
          MAX_SSE_WRITE_BUFFER_BYTES
        ) {
          client.response.end();
          this.sseClients.delete(client.id);
          continue;
        }
        client.response.write(frame);
      }
    }, this.options.sseHeartbeatMs);
    this.heartbeat.unref();
  }

  private publishSystemStatus(
    status: SystemState,
    message: string,
    metadata?: Metadata,
  ): void {
    this.publishStatus("operator-server", status, message, metadata);
  }

  private publishStatus(
    component: string,
    status: SystemState,
    message: string,
    metadata?: Metadata,
  ): void {
    try {
      this.dependencies.events.publish({
        type: "system.status",
        component,
        status,
        message,
        metadata,
        timestamp: this.now(),
      });
    } catch {
      this.dependencies.logger?.warn?.("Operator status event listener failed", {
        component,
        status,
      });
    }
  }

  private enqueueConfigOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.configOperationTail.then(operation, operation);
    this.configOperationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private currentConfigRevision(): number {
    const generation = this.dependencies.configStore.generation;
    return typeof generation === "number" &&
        Number.isSafeInteger(generation) &&
        generation >= 0
      ? generation
      : this.fallbackConfigRevision;
  }

  private commitFallbackConfigRevision(): number {
    const generation = this.dependencies.configStore.generation;
    if (
      typeof generation === "number" &&
      Number.isSafeInteger(generation) &&
      generation >= 0
    ) {
      return generation;
    }
    if (this.fallbackConfigRevision === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Configuration revision limit reached");
    }
    this.fallbackConfigRevision += 1;
    return this.fallbackConfigRevision;
  }

  private commitReportedConfigRevision(reportedRevision: number): number {
    const generation = this.dependencies.configStore.generation;
    if (
      typeof generation === "number" &&
      Number.isSafeInteger(generation) &&
      generation >= 0
    ) {
      return generation;
    }
    if (!Number.isSafeInteger(reportedRevision) || reportedRevision < 0) {
      throw new TypeError("Runtime returned an invalid configuration revision");
    }
    this.fallbackConfigRevision = reportedRevision;
    return reportedRevision;
  }

  private handleRequestError(
    error: unknown,
    requestId: string,
    response: ServerResponse,
  ): void {
    if (response.destroyed || response.writableEnded) {
      return;
    }
    if (response.headersSent) {
      response.destroy();
      return;
    }

    let httpError: HttpError;
    if (error instanceof ConfigDocumentError) {
      httpError = new HttpError(
        422,
        "invalid_config",
        error.message,
        { path: error.path },
      );
    } else if (error instanceof HttpError) {
      httpError = error;
    } else {
      this.dependencies.logger?.error?.("Operator HTTP request failed", {
        requestId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      httpError = new HttpError(500, "internal_error", "服务器处理请求失败");
    }

    for (const [key, value] of Object.entries(httpError.headers ?? {})) {
      response.setHeader(key, value);
    }
    sendJson(undefined, response, httpError.status, redactSecrets({
      error: {
        code: httpError.code,
        message: httpError.message,
        details: httpError.details,
      },
      requestId,
    }));
  }
}

const OMITTED_SSE_IMAGE = Symbol("omitted-sse-image");
const SSE_BINARY_IMAGE_FIELDS = new Set([
  "base64image",
  "imagebase64",
  "imageblob",
  "imagedata",
  "imagedataurl",
]);

function stripSseImageBlobs(
  value: unknown,
  field = "",
): unknown | typeof OMITTED_SSE_IMAGE {
  const normalizedField = field.replace(/[_-]/gu, "").toLowerCase();
  if (SSE_BINARY_IMAGE_FIELDS.has(normalizedField)) {
    return OMITTED_SSE_IMAGE;
  }
  if (typeof value === "string") {
    return isInlineImageBlob(value, normalizedField)
      ? OMITTED_SSE_IMAGE
      : value;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const stripped = stripSseImageBlobs(item, field);
      if (stripped !== OMITTED_SSE_IMAGE) {
        result.push(stripped);
      }
    }
    return result;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const stripped = stripSseImageBlobs(child, key);
    if (stripped !== OMITTED_SSE_IMAGE) {
      result[key] = stripped;
    }
  }
  return result;
}

function isInlineImageBlob(value: string, normalizedField: string): boolean {
  const trimmed = value.trim();
  if (/^data:image\/[^;,]+;base64,/iu.test(trimmed)) {
    return true;
  }
  if (normalizedField !== "images") {
    return false;
  }
  if (
    /^(?:[a-z][a-z0-9+.-]*:\/\/|[./\\]|[a-z]:[\\/])/iu.test(trimmed) ||
    /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/iu.test(trimmed)
  ) {
    return false;
  }
  const compact = trimmed.replace(/\s+/gu, "");
  return compact.length >= 8 &&
    compact.length % 4 === 0 &&
    /^[a-z0-9+/]+={0,2}$/iu.test(compact);
}

function isRunningRuntimeStatus(value: unknown): boolean {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Readonly<Record<string, unknown>>)["state"] === "running";
}

function configRevisionConflict(
  expectedRevision: number,
  currentRevision: number,
): HttpError {
  return new HttpError(
    412,
    "config_revision_conflict",
    "配置已被其他操作修改，请重新载入后再保存",
    { expectedRevision, currentRevision },
    {
      ETag: configRevisionEtag(currentRevision),
      "x-config-revision": String(currentRevision),
    },
  );
}

function assertRedactedAgentCredentialBindingUnchanged(
  current: JsonObject,
  candidate: JsonObject,
): void {
  const currentResolved = resolvedAgentCredentialBinding(current);
  const candidateResolved = resolvedAgentCredentialBinding(candidate);
  const resolvedBindingChanged =
    currentResolved !== undefined &&
    candidateResolved !== undefined &&
    candidateResolved.credentialRedacted &&
    !isDeepStrictEqual(currentResolved.binding, candidateResolved.binding);

  const rawCredentialBindingChanged = ["agent", "image_recognition"].some(
    (section) => {
      const currentOwner =
        current[section] !== null &&
        typeof current[section] === "object" &&
        !Array.isArray(current[section])
          ? current[section] as JsonObject
          : undefined;
      const candidateOwner =
        candidate[section] !== null &&
        typeof candidate[section] === "object" &&
        !Array.isArray(candidate[section])
          ? candidate[section] as JsonObject
          : undefined;
      return currentOwner !== undefined &&
        candidateOwner !== undefined &&
        containsRedactedValue(candidateOwner) &&
        !isDeepStrictEqual(
          effectiveAgentCredentialBinding(currentOwner),
          effectiveAgentCredentialBinding(candidateOwner),
        );
    },
  );
  const localCredentialEndpointChanged =
    hasChangedRedactedCredentialEndpoint(current, candidate);
  if (
    !resolvedBindingChanged &&
    !rawCredentialBindingChanged &&
    !localCredentialEndpointChanged
  ) {
    return;
  }

  throw new HttpError(
    422,
    "invalid_agent_config",
    "修改 Agent 或专用视觉模型凭据所属的 provider、baseUrl 时必须重新输入凭据，不能复用脱敏占位符",
  );
}

function resolvedAgentCredentialBinding(
  config: JsonObject,
): {
  readonly binding: {
    readonly provider: string;
    readonly baseUrl: string;
  };
  readonly credentialRedacted: boolean;
} | undefined {
  try {
    const resolved = resolvePiAgentConfig(config);
    return {
      binding: {
        provider: resolved.credentialProvider,
        baseUrl:
          resolved.baseUrl ??
          (resolved.openAICompatible
            ? defaultPiCompatibleBaseUrl(resolved.provider) ?? ""
            : ""),
      },
      credentialRedacted: resolved.credentialRedacted,
    };
  } catch {
    return undefined;
  }
}

function effectiveAgentCredentialBinding(agent: JsonObject): {
  readonly provider: string;
  readonly baseUrl: string;
} {
  const provider =
    typeof agent["provider"] === "string"
      ? normalizePiAgentProvider(agent["provider"])
      : "";
  const baseUrl = normalizeCredentialEndpoint(
    typeof agent["baseUrl"] === "string" ? agent["baseUrl"] : "",
  );
  return { provider, baseUrl };
}

function hasChangedRedactedCredentialEndpoint(
  current: unknown,
  candidate: unknown,
): boolean {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return false;
  }
  const next = candidate as JsonObject;
  const previous =
    current !== null &&
    typeof current === "object" &&
    !Array.isArray(current)
      ? current as JsonObject
      : {};
  const hasMaskedCredential = Object.entries(next).some(([key, value]) =>
    (isSecretKey(key) && containsRedactedValue(value)) ||
    (key === "headers" && containsRedactedValue(value))
  );
  if (
    hasMaskedCredential &&
    localCredentialEndpoint(previous) !== localCredentialEndpoint(next)
  ) {
    return true;
  }
  return Object.entries(next).some(([key, value]) =>
    hasChangedRedactedCredentialEndpoint(previous[key], value),
  );
}

function localCredentialEndpoint(owner: JsonObject): string {
  const endpoint = [
    "baseUrl",
    "base_url",
    "endpoint",
    "api_url",
    "api",
    "api_ip_port",
  ].map((field) => owner[field])
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  const umsApi = owner["ums_api"];
  let umsEndpoint = "";
  if (typeof umsApi === "string" && umsApi.trim() !== "") {
    try {
      umsEndpoint = new URL(umsApi.trim()).origin;
    } catch {
      umsEndpoint = umsApi.trim();
    }
  }
  const region = ["region", "location"].map((field) => owner[field])
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  return JSON.stringify({
    endpoint: endpoint !== undefined
      ? normalizeCredentialEndpoint(endpoint)
      : "",
    umsEndpoint,
    region: region?.trim().toLowerCase() ?? "",
  });
}

function normalizeCredentialEndpoint(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname
      .replace(/\/(?:chat\/completions|responses)\/?$/iu, "")
      .replace(/\/+$/u, "");
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return trimmed;
  }
}


function containsRedactedValue(value: unknown): boolean {
  if (value === REDACTED_VALUE) return true;
  if (Array.isArray(value)) return value.some(containsRedactedValue);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(containsRedactedValue);
}

function assertOperatorBindUnchangedForRemote(
  current: JsonObject,
  candidate: JsonObject,
): void {
  const currentBind = effectiveOperatorBind(current);
  const candidateBind = effectiveOperatorBind(candidate);
  if (isDeepStrictEqual(currentBind, candidateBind)) {
    return;
  }
  throw new HttpError(
    409,
    "operator_bind_restart_required",
    "修改 webui.ip/webui.port 或 api_ip/api_port 需要重启进程",
    { current: currentBind, candidate: candidateBind },
  );
}

function effectiveOperatorBind(config: JsonObject): {
  readonly host: unknown;
  readonly port: unknown;
} {
  const webui =
    config["webui"] !== null &&
    typeof config["webui"] === "object" &&
    !Array.isArray(config["webui"])
      ? config["webui"] as JsonObject
      : {};
  return {
    host: webui["ip"] ?? config["api_ip"] ?? DEFAULT_HOST,
    port: webui["port"] ?? config["api_port"] ?? DEFAULT_OPERATOR_PORT,
  };
}

export function createOperatorServer(
  dependencies: OperatorServerDependencies,
  options: OperatorServerOptions = {},
): OperatorServer {
  return new OperatorServer(dependencies, options);
}

function setSecurityHeaders(response: ServerResponse, requestId: string): void {
  response.setHeader("x-request-id", requestId);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'",
  );
}

function parseRequestUrl(rawUrl: string | undefined): URL {
  try {
    return new URL(rawUrl ?? "/", "http://operator.local");
  } catch {
    throw new HttpError(400, "invalid_url", "请求 URL 无效");
  }
}

function sendJson(
  request: IncomingMessage | undefined,
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  if (request?.method === "HEAD") {
    response.end();
  } else {
    response.end(body);
  }
}

function requireMethod(request: IncomingMessage, methods: readonly string[]): void {
  if (request.method === undefined || !methods.includes(request.method)) {
    throw methodNotAllowed(methods);
  }
}

function methodNotAllowed(methods: readonly string[]): HttpError {
  return new HttpError(
    405,
    "method_not_allowed",
    "该资源不支持此 HTTP 方法",
    undefined,
    { Allow: methods.join(", ") },
  );
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Content-Type 必须是 application/json",
    );
  }
  const contentEncoding = request.headers["content-encoding"]?.trim().toLowerCase();
  if (contentEncoding !== undefined && contentEncoding !== "" && contentEncoding !== "identity") {
    throw new HttpError(415, "unsupported_content_encoding", "不支持压缩的请求体");
  }

  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new HttpError(400, "invalid_content_length", "Content-Length 无效");
    }
    if (Number(declaredLength) > maxBytes) {
      throw new HttpError(413, "request_too_large", "请求体超过大小限制");
    }
  }

  const chunks = await new Promise<Buffer[]>((resolveBody, rejectBody) => {
    const collected: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      request.resume();
      rejectBody(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        fail(new HttpError(413, "request_too_large", "请求体超过大小限制"));
        return;
      }
      collected.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolveBody(collected);
    };
    const onAborted = (): void => {
      fail(new HttpError(400, "request_aborted", "请求体传输中断"));
    };
    const onError = (): void => {
      fail(new HttpError(400, "request_read_failed", "无法读取请求体"));
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });

  if (chunks.length === 0) {
    throw new HttpError(400, "empty_body", "请求体不能为空");
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, "invalid_utf8", "请求体必须使用有效的 UTF-8 编码");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "请求体不是有效的 JSON");
  }
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "invalid_request", message);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(422, "invalid_field", `${field} 必须是非空字符串`, { field });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new HttpError(
      422,
      "invalid_field",
      `${field} 长度不能超过 ${maxLength}`,
      { field, maxLength },
    );
  }
  return normalized;
}

function optionalString(value: unknown, fallback: string, maxLength: number): string {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return requiredString(value, "value", maxLength);
}
function optionalQueryInteger(
  searchParams: URLSearchParams,
  field: string,
): number | undefined {
  const raw = searchParams.get(field);
  if (raw === null) {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new HttpError(
      422,
      "invalid_query_parameter",
      `${field} 必须是正整数`,
      { field },
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new HttpError(
      422,
      "invalid_query_parameter",
      `${field} 超出安全整数范围`,
      { field },
    );
  }
  return value;
}


function nonNegativeInteger(value: unknown, field: string): number {
  const numberValue = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;
  if (
    typeof numberValue !== "number" ||
    !Number.isSafeInteger(numberValue) ||
    numberValue < 0
  ) {
    throw new HttpError(
      422,
      "invalid_field",
      `${field} 必须是非负整数`,
      { field },
    );
  }
  return numberValue;
}

function normalizeLegacyType(type: string): LiveEventType {
  if (type === "reread" || type === "reread_top_priority" || type === "tuning") {
    return "talk";
  }
  if (LIVE_EVENT_TYPES.has(type as LiveEventType)) {
    return type as LiveEventType;
  }
  throw new HttpError(
    422,
    "unsupported_event_type",
    `不支持的旧版事件类型 ${type}`,
    { field: "type" },
  );
}

function legacyContent(data: Record<string, unknown>, type: LiveEventType): string {
  if (typeof data.content === "string" && data.content.trim() !== "") {
    return requiredString(data.content, "data.content", MAX_CONTENT_LENGTH);
  }
  if (type === "gift") {
    const giftName =
      typeof data.gift_name === "string" && data.gift_name.trim() !== ""
        ? requiredString(
            data.gift_name,
            "data.gift_name",
            MAX_CONTENT_LENGTH,
          )
        : "礼物";
    const quantity =
      typeof data.num === "number" || typeof data.num === "string"
        ? requiredString(String(data.num), "data.num", MAX_CONTENT_LENGTH)
        : "1";
    return requiredString(
      `${giftName} × ${quantity}`,
      "data.content",
      MAX_CONTENT_LENGTH,
    );
  }
  if (type === "entrance") {
    return "进入直播间";
  }
  if (type === "follow") {
    return "关注直播间";
  }
  throw new HttpError(
    422,
    "invalid_field",
    "data.content 必须是非空字符串",
    { field: "data.content" },
  );
}

function configRevisionEtag(revision: number): string {
  return `"${String(revision)}"`;
}

function requireConfigRevision(
  header: string | string[] | undefined,
): number {
  if (header === undefined) {
    throw new HttpError(
      428,
      "precondition_required",
      "保存配置必须提供 If-Match 修订号",
    );
  }
  if (typeof header !== "string") {
    throw new HttpError(400, "invalid_config_revision", "If-Match 修订号格式无效");
  }
  const match = header.match(/^"([0-9]+)"$/u);
  const revision = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new HttpError(400, "invalid_config_revision", "If-Match 修订号格式无效");
  }
  return revision;
}

function assertNativeExecutionPolicyUnchanged(
  current: JsonObject,
  candidate: JsonObject,
): void {
  for (const path of NATIVE_EXECUTION_POLICY_PATHS) {
    if (
      jsonValuesEqual(
        configValueAt(current, path),
        configValueAt(candidate, path),
      )
    ) {
      continue;
    }
    const displayPath = path.join(".");
    throw new HttpError(
      403,
      "native_execution_policy_immutable",
      `远程配置不能修改本机执行策略 ${displayPath}`,
      { path: displayPath },
    );
  }
}

function assertAvailablePlatformSelection(candidate: JsonObject): void {
  const configured = configValueAt(candidate, ["platform"]);
  if (configured === undefined || configured === "talk") {
    return;
  }
  if (typeof configured === "string" && isPlatformAvailable(configured)) {
    return;
  }
  const pending =
    typeof configured === "string" ? platformAvailability(configured) : undefined;
  const display = typeof configured === "string" ? configured : JSON.stringify(configured);
  throw new HttpError(
    422,
    pending?.status === "pending" ? "platform_pending" : "platform_unsupported",
    pending?.status === "pending"
      ? `平台 ${pending.label} 待完善，当前可用平台为 ${SUPPORTED_PLATFORM_IDS.join(", ")}`
      : `不支持的平台 ${display}；当前可用平台为 ${SUPPORTED_PLATFORM_IDS.join(", ")}`,
    { path: "platform" },
  );
}

function assertPendingPlatformConfigurationUnchanged(
  current: JsonObject,
  candidate: JsonObject,
): void {
  for (const path of PENDING_PLATFORM_CONFIG_PATHS) {
    if (
      jsonValuesEqual(
        configValueAt(current, path),
        configValueAt(candidate, path),
      )
    ) {
      continue;
    }
    const displayPath = path.join(".");
    throw new HttpError(
      403,
      "platform_pending",
      `待完善平台配置不能修改 ${displayPath}`,
      { path: displayPath },
    );
  }
}

function configValueAt(
  document: JsonObject,
  path: readonly string[],
): unknown {
  let value: unknown = document;
  for (const segment of path) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, segment)
    ) {
      return undefined;
    }
    value = (value as Readonly<Record<string, unknown>>)[segment];
  }
  return value;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        jsonValuesEqual(leftRecord[key], rightRecord[key]),
    );
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  const normalized = address.toLowerCase().split("%", 1)[0]!;
  if (normalized === "::1") {
    return true;
  }
  const ipv4 = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  const octets = ipv4.split(".").map(Number);
  return (
    octets.length === 4 &&
    octets[0] === 127 &&
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    )
  );
}

function isSafeLoopbackHost(host: string | string[] | undefined): boolean {
  if (typeof host !== "string") {
    return false;
  }
  const value = host.trim();
  const bracketed = value.match(/^\[([^\]]+)\](?::\d{1,5})?$/u);
  const plain = value.match(/^([^:]+)(?::\d{1,5})?$/u);
  const hostname = (bracketed?.[1] ?? plain?.[1])
    ?.toLowerCase()
    .replace(/\.$/u, "");
  return hostname === "localhost" || isLoopbackAddress(hostname);
}


function normalizeHost(host: unknown): string {
  if (typeof host !== "string" || host.trim() === "") {
    throw new TypeError("Operator server host must be a non-empty string");
  }
  return host.trim();
}

function normalizePort(port: unknown): number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Operator server port must be an integer from 0 through 65535");
  }
  return port;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return result;
}

function formatAddress(address: AddressInfo, requestedHost: string): OperatorServerAddress {
  const host = address.address === "::" ? requestedHost : address.address;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return {
    host,
    port: address.port,
    url: `http://${displayHost}:${address.port}`,
  };
}

function secureEqual(received: string, expected: string): boolean {
  const receivedDigest = createHash("sha256").update(received, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

function parseLastEventId(header: string | string[] | undefined): number | undefined {
  if (typeof header !== "string" || !/^\d+$/.test(header)) {
    return undefined;
  }
  const parsed = Number(header);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function decodePath(path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new HttpError(400, "invalid_path", "URL 路径编码无效");
  }
  if (decoded.includes("\\") || decoded.includes("\0")) {
    throw new HttpError(404, "not_found", "请求的资源不存在");
  }
  return decoded;
}

function normalizeStaticPrefix(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/" || !trimmed.startsWith("/")) {
    return undefined;
  }
  if (trimmed.includes("\\") || trimmed.includes("\0")) {
    return undefined;
  }
  const segments = trimmed.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return trimmed;
}

function assertSafeStaticRelativePath(relativePath: string): void {
  if (relativePath === "" || relativePath.includes("\\") || relativePath.includes("\0")) {
    throw new HttpError(404, "not_found", "请求的资源不存在");
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    throw new HttpError(404, "not_found", "请求的资源不存在");
  }
}

function isSafeRelativePath(relativePath: string): boolean {
  return relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
}

function validateCaptionOutputConfig(config: JsonObject, rootDirectory: string): void {
  const captions = config["captions"];
  if (
    captions === null ||
    typeof captions !== "object" ||
    Array.isArray(captions) ||
    (captions as JsonObject)["enable"] !== true
  ) {
    return;
  }
  for (const field of ["file_path", "raw_file_path"]) {
    const value = (captions as JsonObject)[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new HttpError(
        422,
        "invalid_caption_config",
        `captions.${field} 必须是 log/ 或 out/ 下的字幕文本文件`,
      );
    }
    try {
      resolveCaptionDestination(rootDirectory, value, "output.file-captions");
    } catch (error) {
      throw new HttpError(
        422,
        "invalid_caption_config",
        error instanceof Error ? error.message : "字幕文件路径无效",
      );
    }
  }
}

function assertLegacyConfigPaths(
  command: string,
  data: Record<string, unknown>,
  configName: string,
): void {
  if (
    data.config_path !== undefined &&
    data.config_path !== configName
  ) {
    throw new HttpError(422, "path_not_allowed", `仅允许使用 ${configName}`);
  }
  if (command === "factory") {
    if (data.src_path !== undefined && data.src_path !== `${configName}.bak`) {
      throw new HttpError(422, "path_not_allowed", `仅允许从 ${configName}.bak 恢复`);
    }
    if (data.dst_path !== undefined && data.dst_path !== configName) {
      throw new HttpError(422, "path_not_allowed", `仅允许恢复到 ${configName}`);
    }
  }
}

function unsupportedRuntimeCommand(command: string): HttpError {
  return new HttpError(
    501,
    "runtime_control_unsupported",
    `当前运行时不支持 ${command} 命令`,
  );
}
