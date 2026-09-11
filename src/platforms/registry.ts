import { HttpsProxyAgent } from "https-proxy-agent";

import type { EventSource } from "../core/contracts.js";
import {
  PLATFORM_CATALOG,
  isPlatformAvailable,
  platformAvailability,
} from "./availability.js";
import { BilibiliPlatformSource } from "./bilibili-platform.js";
import { BilibiliWebSource } from "./bilibili-web.js";
import { createRelayClientSource, createRelayServerSource } from "./relay.js";
import { StdinJsonLineSource } from "./stdin.js";
import { TwitchIrcSource } from "./twitch.js";
import type {
  PlatformConfig,
  PlatformConfigInput,
  PlatformDependencies,
} from "./types.js";
import {
  firstString,
  isPlaceholderSecret,
  isRecord,
  numberAt,
  PlatformConfigurationError,
  reconnectOptions,
  recordAt,
  snapshotConfig,
  stringArrayAt,
  stringAt,
} from "./utilities.js";
import type { WebSocketAcknowledgement } from "./websocket-client.js";
import { YouTubeLiveChatSource } from "./youtube.js";

type PlatformSourceFactory = (
  platform: string,
  config: PlatformConfig,
  dependencies: PlatformDependencies,
) => EventSource;

export const SUPPORTED_PLATFORM_IDS = Object.freeze([
  ...PLATFORM_CATALOG.filter(({ status }) => status === "available").map(({ id }) => id),
  "stdin",
  "manual",
] as const);

const REMOVED_PLATFORM_IDS: ReadonlySet<string> = new Set([
  "bilibili",
  "bilibili2",
  "dy",
  "dy2",
  "douyin",
  "ks",
  "ks2",
  "kuaishou",
  "tiktok",
  "pdd",
  "douyu",
  "1688",
  "taobao",
  "wxlive",
  "hntv",
  "hnyv",
]);

export class PlatformRegistry {
  readonly #dependencies: PlatformDependencies;
  readonly #factories = new Map<string, PlatformSourceFactory>();

  constructor(dependencies: PlatformDependencies = {}) {
    this.#dependencies = dependencies;
  }

  register(
    platformIds: string | readonly string[],
    factory: PlatformSourceFactory,
  ): this {
    const identifiers =
      typeof platformIds === "string" ? [platformIds] : platformIds;
    for (const identifier of identifiers) {
      const key = identifier.trim().toLowerCase();
      if (key.length === 0) {
        throw new TypeError("Platform identifiers cannot be empty");
      }
      assertPlatformAvailable(key);
      if (this.#factories.has(key)) {
        throw new Error(`Platform "${key}" is already registered`);
      }
      this.#factories.set(key, factory);
    }
    return this;
  }

  create(platform: string, config: PlatformConfig): EventSource {
    const key = platform.trim().toLowerCase();
    if (REMOVED_PLATFORM_IDS.has(key)) {
      throw new PlatformConfigurationError(key, "platform adapter was removed");
    }
    assertPlatformAvailable(key);
    const factory = this.#factories.get(key);
    if (factory !== undefined) {
      return factory(key, config, this.#dependencies);
    }
    throw new PlatformConfigurationError(
      key || "unknown",
      `unsupported platform; supported values are ${SUPPORTED_PLATFORM_IDS.join(", ")}`,
    );
  }
}

export function createDefaultPlatformRegistry(
  dependencies: PlatformDependencies = {},
): PlatformRegistry {
  const registry = new PlatformRegistry(dependencies);
  registry.register(["talk", "stdin", "manual"], (platform, _config, deps) =>
    new StdinJsonLineSource(platform, deps),
  );
  registry.register("bilibili-web", createBilibiliWebSource);
  registry.register("bilibili-platform", createBilibiliPlatformSource);
  if (isPlatformAvailable("youtube")) {
    registry.register("youtube", createYouTubeSource);
  }
  if (isPlatformAvailable("twitch")) {
    registry.register("twitch", createTwitchSource);
  }
  if (isPlatformAvailable("ordinaryroad_barrage_fly")) {
    registry.register("ordinaryroad_barrage_fly", createOrdinaryRoadSource);
  }
  return registry;
}

export function createPlatformEventSource(
  input: PlatformConfigInput,
  dependencies: PlatformDependencies = {},
): EventSource {
  const config = snapshotConfig(input);
  const platform = stringAt(config, "platform");
  if (platform === undefined) {
    throw new PlatformConfigurationError("unknown", "top-level platform is required");
  }
  return createDefaultPlatformRegistry(dependencies).create(platform, config);
}

export function assertPlatformAvailable(platform: string): void {
  if (isPlatformAvailable(platform)) {
    return;
  }
  const pending = platformAvailability(platform);
  if (pending?.status === "pending") {
    throw new PlatformConfigurationError(
      pending.id,
      `待完善，当前可用平台为 ${SUPPORTED_PLATFORM_IDS.join(", ")}`,
    );
  }
  throw new PlatformConfigurationError(
    platform || "unknown",
    `unsupported platform; supported values are ${SUPPORTED_PLATFORM_IDS.join(", ")}`,
  );
}

function createBilibiliWebSource(
  platform: string,
  config: PlatformConfig,
  dependencies: PlatformDependencies,
): EventSource {
  const section = recordAt(config, platform) ?? {};
  const roomId =
    numberAt(section, "room_id") ?? numberAt(config, "room_display_id");
  if (
    roomId === undefined ||
    !Number.isSafeInteger(roomId) ||
    roomId <= 0
  ) {
    throw new PlatformConfigurationError(
      platform,
      "bilibili-web.room_id or top-level room_display_id must be a positive integer",
    );
  }
  const uid = numberAt(section, "uid");
  const header = recordAt(config, "header") ?? {};
  const userAgent =
    stringAt(section, "user_agent") ?? stringAt(header, "userAgent");
  return new BilibiliWebSource(
    {
      platform,
      roomId,
      reconnect: reconnectFor(section, config),
      ...(uid === undefined ? {} : { uid }),
      ...(stringAt(section, "sessdata") === undefined
        ? {}
        : { sessdata: stringAt(section, "sessdata")! }),
      ...(stringAt(section, "cookie") === undefined
        ? {}
        : { cookie: stringAt(section, "cookie")! }),
      ...(userAgent === undefined ? {} : { userAgent }),
      ...(numberAt(section, "request_timeout_ms") === undefined
        ? {}
        : { requestTimeoutMs: numberAt(section, "request_timeout_ms")! }),
      ...(numberAt(section, "heartbeat_interval_ms") === undefined
        ? {}
        : {
            heartbeatIntervalMs: numberAt(
              section,
              "heartbeat_interval_ms",
            )!,
          }),
    },
    dependencies,
  );
}

function createBilibiliPlatformSource(
  platform: string,
  config: PlatformConfig,
  dependencies: PlatformDependencies,
): EventSource {
  const section = recordAt(config, platform) ?? {};
  const accessKeyId = firstString(section, [
    ["ACCESS_KEY_ID"],
    ["access_key_id"],
  ]);
  const accessKeySecret = firstString(section, [
    ["ACCESS_KEY_SECRET"],
    ["access_key_secret"],
  ]);
  const appId =
    numberAt(section, "APP_ID") ?? numberAt(section, "app_id");
  const roomOwnerAuthCode = firstString(section, [
    ["ROOM_OWNER_AUTH_CODE"],
    ["room_owner_auth_code"],
  ]);
  if (
    isPlaceholderSecret(accessKeyId) ||
    isPlaceholderSecret(accessKeySecret) ||
    appId === undefined ||
    !Number.isSafeInteger(appId) ||
    appId <= 0 ||
    isPlaceholderSecret(roomOwnerAuthCode)
  ) {
    throw new PlatformConfigurationError(
      platform,
      "configure bilibili-platform ACCESS_KEY_ID, ACCESS_KEY_SECRET, APP_ID, and ROOM_OWNER_AUTH_CODE",
    );
  }
  return new BilibiliPlatformSource(
    {
      platform,
      accessKeyId: accessKeyId!,
      accessKeySecret: accessKeySecret!,
      appId,
      roomOwnerAuthCode: roomOwnerAuthCode!,
      reconnect: reconnectFor(section, config),
      ...(stringAt(section, "start_url") === undefined
        ? {}
        : { startUrl: stringAt(section, "start_url")! }),
      ...(stringAt(section, "heartbeat_url") === undefined
        ? {}
        : { heartbeatUrl: stringAt(section, "heartbeat_url")! }),
      ...(stringAt(section, "end_url") === undefined
        ? {}
        : { endUrl: stringAt(section, "end_url")! }),
      ...(numberAt(section, "request_timeout_ms") === undefined
        ? {}
        : { requestTimeoutMs: numberAt(section, "request_timeout_ms")! }),
      ...(numberAt(section, "socket_heartbeat_interval_ms") === undefined
        ? {}
        : {
            socketHeartbeatIntervalMs: numberAt(
              section,
              "socket_heartbeat_interval_ms",
            )!,
          }),
      ...(numberAt(section, "game_heartbeat_interval_ms") === undefined
        ? {}
        : {
            gameHeartbeatIntervalMs: numberAt(
              section,
              "game_heartbeat_interval_ms",
            )!,
          }),
    },
    dependencies,
  );
}

function createYouTubeSource(
  platform: string,
  config: PlatformConfig,
  dependencies: PlatformDependencies,
): EventSource {
  const section = recordAt(config, "youtube") ?? {};
  const apiKey = firstString(section, [["api_key"], ["API_KEY"]]);
  if (isPlaceholderSecret(apiKey)) {
    throw new PlatformConfigurationError(
      platform,
      "youtube.api_key is required for YouTube Data API live chat polling",
    );
  }
  const liveChatId = firstString(section, [["live_chat_id"], ["liveChatId"]]);
  const videoId =
    firstString(section, [["video_id"], ["videoId"]]) ??
    stringAt(config, "room_display_id");
  if (liveChatId === undefined && videoId === undefined) {
    throw new PlatformConfigurationError(
      platform,
      "youtube.live_chat_id or room_display_id is required",
    );
  }
  const apiBaseUrl = firstString(section, [["api_base_url"], ["apiBaseUrl"]]);
  return new YouTubeLiveChatSource(
    {
      platform,
      apiKey: apiKey!,
      reconnect: reconnectFor(section, config),
      ...(liveChatId === undefined ? {} : { liveChatId }),
      ...(videoId === undefined ? {} : { videoId }),
      ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    },
    dependencies,
  );
}

function createTwitchSource(
  platform: string,
  config: PlatformConfig,
  dependencies: PlatformDependencies,
): EventSource {
  const section = recordAt(config, "twitch") ?? {};
  const token = stringAt(section, "token");
  const user = stringAt(section, "user");
  const channel =
    firstString(section, [["channel"], ["room_id"]]) ??
    stringAt(config, "room_display_id");
  if (isPlaceholderSecret(token) || user === undefined || channel === undefined) {
    throw new PlatformConfigurationError(
      platform,
      "twitch.token, twitch.user, and room_display_id (or twitch.channel) are required",
    );
  }
  const websocketUrl = firstString(section, [
    ["websocket_url"],
    ["ws_url"],
  ]);
  const proxyUrl = stringAt(section, "proxy_url");
  const proxyHost = stringAt(section, "proxy_server");
  const proxyPort = numberAt(section, "proxy_port");
  const agent =
    proxyUrl !== undefined
      ? new HttpsProxyAgent(proxyUrl)
      : proxyHost !== undefined && proxyPort !== undefined
        ? new HttpsProxyAgent(`http://${proxyHost}:${proxyPort}`)
        : undefined;
  return new TwitchIrcSource(
    {
      platform,
      token: token!,
      user,
      channel,
      reconnect: reconnectFor(section, config),
      ...(websocketUrl === undefined ? {} : { url: websocketUrl }),
      ...(agent === undefined ? {} : { agent }),
    },
    dependencies,
  );
}

function createOrdinaryRoadSource(
  platform: string,
  config: PlatformConfig,
  dependencies: PlatformDependencies,
): EventSource {
  const section = recordAt(config, platform) ?? {};
  const endpoint = stringAt(section, "ws_ip_port");
  const taskIds = stringArrayAt(section, "taskIds");
  if (endpoint === undefined || taskIds === undefined) {
    throw new PlatformConfigurationError(
      platform,
      "ordinaryroad_barrage_fly.ws_ip_port and at least one taskIds entry are required",
    );
  }
  return createRelayClientSource(
    {
      platform,
      url: endpoint,
      reconnect: reconnectFor(section, config),
      initialMessages: [JSON.stringify({ cmd: "SUBSCRIBE", taskIds })],
      acknowledgement: standardJsonAcknowledgement(platform),
    },
    dependencies,
  );
}


function createConfiguredRelay(
  platform: string,
  section: Readonly<Record<string, unknown>>,
  endpoint: string,
  dependencies: PlatformDependencies,
  rootConfig?: PlatformConfig,
  defaultMode: "client" | "server" = "client",
): EventSource {
  if (relayMode(section, defaultMode) === "server") {
    return createRelayServerSource(
      { platform, listenUrl: endpoint },
      dependencies,
    );
  }
  return createRelayClientSource(
    {
      platform,
      url: endpoint,
      reconnect: reconnectFor(section, rootConfig ?? section),
      ...configuredHeaders(section),
    },
    dependencies,
  );
}

function relayEndpoint(
  section: Readonly<Record<string, unknown>>,
): string | undefined {
  return firstString(section, [
    ["relay_ws_url"],
    ["websocket_url"],
    ["ws_url"],
    ["endpoint"],
    ["listen_url"],
  ]);
}

function relayMode(
  section: Readonly<Record<string, unknown>>,
  fallback: "client" | "server",
): "client" | "server" {
  const configured = firstString(section, [
    ["relay_mode"],
    ["websocket_mode"],
    ["mode"],
  ])?.toLowerCase();
  if (configured === "server" || configured === "listen") {
    return "server";
  }
  if (configured === "client" || configured === "connect") {
    return "client";
  }
  return fallback;
}

function reconnectFor(
  section: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>>,
) {
  return reconnectOptions(
    recordAt(section, "reconnect") ?? recordAt(root, "platform_reconnect"),
  );
}


function configuredHeaders(
  section: Readonly<Record<string, unknown>>,
): { readonly headers?: Readonly<Record<string, string>> } {
  const value = section["headers"];
  if (!isRecord(value)) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      headers[key] = item;
    }
  }
  return Object.keys(headers).length === 0 ? {} : { headers };
}

function standardJsonAcknowledgement(
  platform: string,
): WebSocketAcknowledgement {
  return (payload) => {
    if (!isRecord(payload)) {
      return false;
    }
    const status = payload["status"];
    const type = String(payload["type"] ?? payload["event"] ?? "").toLowerCase();
    const code = Number(payload["code"]);
    const explicitFailure =
      status === false ||
      status === "error" ||
      status === "failed" ||
      (Number.isFinite(code) && code !== 0 && code !== 200);
    if (explicitFailure) {
      const message =
        typeof payload["message"] === "string"
          ? payload["message"]
          : "relay rejected subscription";
      return new Error(`Platform "${platform}" relay acknowledgement failed: ${message}`);
    }
    const explicitSuccess =
      status === true ||
      status === 0 ||
      status === 200 ||
      status === "ok" ||
      status === "success" ||
      type === "ack" ||
      type === "ready" ||
      type === "authenticated" ||
      (Number.isFinite(code) && (code === 0 || code === 200));
    return explicitSuccess;
  };
}
