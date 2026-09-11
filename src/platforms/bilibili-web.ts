import { createHash } from "node:crypto";

import type { EventSource, LiveEventHandler } from "../core/contracts.js";
import {
  createBilibiliAcknowledgement,
  decodeBilibiliFrames,
  encodeBilibiliPacket,
} from "./bilibili-protocol.js";
import { normalizeLivePayload } from "./normalization.js";
import type { PlatformDependencies, ReconnectOptions } from "./types.js";
import {
  isRecord,
  PlatformConfigurationError,
  PlatformConnectionError,
  readJsonResponse,
} from "./utilities.js";
import {
  ReconnectingWebSocketSource,
  type WebSocketSession,
} from "./websocket-client.js";

const DEFAULT_NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const DEFAULT_HOME_URL = "https://www.bilibili.com/";
const DEFAULT_ROOM_INFO_URL =
  "https://api.live.bilibili.com/room/v1/Room/get_info";
const DEFAULT_DANMAKU_INFO_URL =
  "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const WBI_KEY_TTL_MS = 11 * 60 * 60 * 1_000 + 59 * 60 * 1_000 + 30 * 1_000;
const WBI_KEY_INDEX_TABLE = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
]);

export interface BilibiliWebOptions {
  readonly platform?: string;
  readonly roomId: number;
  readonly uid?: number;
  readonly sessdata?: string;
  readonly cookie?: string;
  readonly userAgent?: string;
  readonly navUrl?: string;
  readonly homeUrl?: string;
  readonly roomInfoUrl?: string;
  readonly danmakuInfoUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly reconnect: ReconnectOptions;
}

interface WebHost {
  readonly host: string;
  readonly wssPort: number;
}

interface WebRuntimeState {
  readonly cookies: Map<string, string>;
  uid: number | undefined;
  wbiKey: string;
  wbiExpiresAt: number;
  nextHost: number;
}

interface WebSessionData {
  readonly roomId: number;
  readonly uid: number;
  readonly buvid: string;
  readonly token: string;
  readonly hosts: readonly WebHost[];
}

interface NavigationData {
  readonly uid: number;
  readonly wbiKey: string;
}

export class BilibiliWebSource implements EventSource {
  readonly name: string;
  readonly #source: ReconnectingWebSocketSource;

  constructor(
    options: BilibiliWebOptions,
    dependencies: PlatformDependencies = {},
  ) {
    this.name = options.platform ?? "bilibili-web";
    requirePositiveInteger(this.name, "roomId", options.roomId);
    if (
      options.uid !== undefined &&
      (!Number.isSafeInteger(options.uid) || options.uid < 0)
    ) {
      throw new PlatformConfigurationError(
        this.name,
        "uid must be a non-negative safe integer",
      );
    }
    const requestTimeoutMs = requirePositiveInteger(
      this.name,
      "requestTimeoutMs",
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const heartbeatIntervalMs = requirePositiveInteger(
      this.name,
      "heartbeatIntervalMs",
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    const userAgent = options.userAgent?.trim() || DEFAULT_USER_AGENT;
    const state: WebRuntimeState = {
      cookies: parseCookies(this.name, options.cookie, options.sessdata),
      uid: options.uid,
      wbiKey: "",
      wbiExpiresAt: 0,
      nextHost: 0,
    };
    const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    const now = dependencies.now ?? Date.now;
    const endpoints = {
      nav: options.navUrl ?? DEFAULT_NAV_URL,
      home: options.homeUrl ?? DEFAULT_HOME_URL,
      roomInfo: options.roomInfoUrl ?? DEFAULT_ROOM_INFO_URL,
      danmakuInfo: options.danmakuInfoUrl ?? DEFAULT_DANMAKU_INFO_URL,
    };

    this.#source = new ReconnectingWebSocketSource({
      name: this.name,
      session: async (signal): Promise<WebSocketSession> => {
        const session = await initializeWebSession(
          this.name,
          options.roomId,
          state,
          endpoints,
          userAgent,
          requestTimeoutMs,
          fetchImplementation,
          now,
          signal,
        );
        const host = session.hosts[state.nextHost % session.hosts.length]!;
        state.nextHost += 1;
        const cookie = serializeCookies(state.cookies);
        const authBody = JSON.stringify({
          uid: session.uid,
          roomid: session.roomId,
          protover: 3,
          platform: "web",
          type: 2,
          buvid: session.buvid,
          key: session.token,
        });
        return {
          url: `wss://${host.host}:${host.wssPort}/sub`,
          options: {
            headers: {
              "User-Agent": userAgent,
              ...(cookie.length === 0 ? {} : { Cookie: cookie }),
            },
          },
          initialMessages: [encodeBilibiliPacket(7, authBody)],
          decode: decodeBilibiliFrames,
          acknowledgement: createBilibiliAcknowledgement(this.name),
          heartbeat: {
            intervalMs: heartbeatIntervalMs,
            createPayload: () => encodeBilibiliPacket(2, "{}"),
            sendImmediately: true,
          },
        };
      },
      normalize: (payload) =>
        normalizeLivePayload(payload, { platform: this.name, now }),
      reconnect: options.reconnect,
      ...(dependencies.webSocketFactory === undefined
        ? {}
        : { webSocketFactory: dependencies.webSocketFactory }),
      ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      ...(dependencies.random === undefined ? {} : { random: dependencies.random }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.onError === undefined
        ? {}
        : { onError: dependencies.onError }),
    });
  }

  async start(handler: LiveEventHandler): Promise<void> {
    await this.#source.start(handler);
  }

  async dispose(): Promise<void> {
    await this.#source.dispose();
  }
}

async function initializeWebSession(
  platform: string,
  configuredRoomId: number,
  state: WebRuntimeState,
  endpoints: {
    readonly nav: string;
    readonly home: string;
    readonly roomInfo: string;
    readonly danmakuInfo: string;
  },
  userAgent: string,
  requestTimeoutMs: number,
  fetchImplementation: typeof globalThis.fetch,
  now: () => number,
  signal: AbortSignal,
): Promise<WebSessionData> {
  const navigationNeeded =
    state.wbiKey.length === 0 ||
    now() >= state.wbiExpiresAt ||
    state.uid === undefined;
  const roomPromise = loadRoom(
    platform,
    configuredRoomId,
    endpoints.roomInfo,
    userAgent,
    state.cookies,
    requestTimeoutMs,
    fetchImplementation,
    signal,
  );
  const navigationPromise = navigationNeeded
    ? loadNavigation(
        platform,
        endpoints.nav,
        userAgent,
        state.cookies,
        requestTimeoutMs,
        fetchImplementation,
        signal,
      )
    : undefined;
  const buvidPromise = state.cookies.has("buvid3")
    ? undefined
    : initializeBuvid(
        platform,
        endpoints.home,
        userAgent,
        state.cookies,
        requestTimeoutMs,
        fetchImplementation,
        signal,
      );
  const [room, navigation] = await Promise.all([
    roomPromise,
    navigationPromise,
    buvidPromise,
  ]);
  if (navigation !== undefined) {
    state.wbiKey = navigation.wbiKey;
    state.wbiExpiresAt = now() + WBI_KEY_TTL_MS;
    state.uid ??= navigation.uid;
  }
  state.uid ??= 0;

  const danmakuUrl = new URL(endpoints.danmakuInfo);
  const signed = addWbiSignature(
    { id: String(room.roomId), type: "0" },
    state.wbiKey,
    now,
  );
  for (const [key, value] of Object.entries(signed)) {
    danmakuUrl.searchParams.set(key, value);
  }
  const danmaku = await requestBilibiliData(
    platform,
    danmakuUrl,
    userAgent,
    state.cookies,
    requestTimeoutMs,
    fetchImplementation,
    signal,
  );
  const token = scalarText(danmaku["token"]);
  if (token === undefined) {
    throw new PlatformConnectionError(
      platform,
      "Bilibili danmaku server response omitted token",
    );
  }
  const hosts = parseHosts(platform, danmaku["host_list"]);
  return {
    roomId: room.roomId,
    uid: state.uid,
    buvid: state.cookies.get("buvid3") ?? "",
    token,
    hosts,
  };
}

async function loadRoom(
  platform: string,
  roomId: number,
  endpoint: string,
  userAgent: string,
  cookies: ReadonlyMap<string, string>,
  requestTimeoutMs: number,
  fetchImplementation: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<{ readonly roomId: number }> {
  const url = new URL(endpoint);
  url.searchParams.set("room_id", String(roomId));
  const data = await requestBilibiliData(
    platform,
    url,
    userAgent,
    cookies,
    requestTimeoutMs,
    fetchImplementation,
    signal,
  );
  const canonicalRoomId = finiteInteger(data["room_id"]);
  if (canonicalRoomId === undefined || canonicalRoomId <= 0) {
    throw new PlatformConnectionError(
      platform,
      "Bilibili room response omitted a valid room_id",
    );
  }
  return { roomId: canonicalRoomId };
}

async function loadNavigation(
  platform: string,
  endpoint: string,
  userAgent: string,
  cookies: ReadonlyMap<string, string>,
  requestTimeoutMs: number,
  fetchImplementation: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<NavigationData> {
  const data = await requestBilibiliData(
    platform,
    new URL(endpoint),
    userAgent,
    cookies,
    requestTimeoutMs,
    fetchImplementation,
    signal,
    [-101],
  );
  const wbi = isRecord(data["wbi_img"]) ? data["wbi_img"] : undefined;
  const imageKey = wbi === undefined ? undefined : fileStem(wbi["img_url"]);
  const subKey = wbi === undefined ? undefined : fileStem(wbi["sub_url"]);
  if (imageKey === undefined || subKey === undefined) {
    throw new PlatformConnectionError(
      platform,
      "Bilibili navigation response omitted WBI image keys",
    );
  }
  const shuffled = imageKey + subKey;
  const wbiKey = WBI_KEY_INDEX_TABLE.flatMap((index) =>
    index < shuffled.length ? [shuffled[index]!] : [],
  ).join("");
  if (wbiKey.length === 0) {
    throw new PlatformConnectionError(platform, "Bilibili WBI key is empty");
  }
  const uid = data["isLogin"] === true ? finiteInteger(data["mid"]) ?? 0 : 0;
  return { uid, wbiKey };
}

async function initializeBuvid(
  platform: string,
  endpoint: string,
  userAgent: string,
  cookies: Map<string, string>,
  requestTimeoutMs: number,
  fetchImplementation: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<void> {
  await withRequestTimeout(requestTimeoutMs, signal, async (requestSignal) => {
    let response: Response;
    try {
      response = await fetchImplementation(endpoint, {
        headers: requestHeaders(userAgent, cookies),
        signal: requestSignal,
      });
    } catch (cause) {
      throw new PlatformConnectionError(
        platform,
        "Bilibili homepage request failed",
        { cause },
      );
    }
    if (!response.ok) {
      throw new PlatformConnectionError(
        platform,
        `Bilibili homepage returned HTTP ${response.status}`,
      );
    }
    captureBuvidCookie(response.headers, cookies);
    await response.body?.cancel();
  });
}

async function requestBilibiliData(
  platform: string,
  url: URL,
  userAgent: string,
  cookies: ReadonlyMap<string, string>,
  requestTimeoutMs: number,
  fetchImplementation: typeof globalThis.fetch,
  signal: AbortSignal,
  additionallyAcceptedCodes: readonly number[] = [],
): Promise<Readonly<Record<string, unknown>>> {
  return withRequestTimeout(requestTimeoutMs, signal, async (requestSignal) => {
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        headers: requestHeaders(userAgent, cookies),
        signal: requestSignal,
      });
    } catch (cause) {
      throw new PlatformConnectionError(
        platform,
        `Bilibili request to ${url.origin} failed`,
        { cause },
      );
    }
    const body = await readJsonResponse(response, requestSignal);
    if (!response.ok) {
      throw new PlatformConnectionError(
        platform,
        `Bilibili API returned HTTP ${response.status}`,
      );
    }
    if (!isRecord(body)) {
      throw new PlatformConnectionError(
        platform,
        "Bilibili API returned a non-object response",
      );
    }
    const code = Number(body["code"]);
    if (
      !Number.isFinite(code) ||
      (code !== 0 && !additionallyAcceptedCodes.includes(code))
    ) {
      throw new PlatformConnectionError(
        platform,
        `Bilibili API error ${Number.isFinite(code) ? code : "unknown"}: ${scalarText(body["message"] ?? body["msg"]) ?? "unknown error"}`,
      );
    }
    if (!isRecord(body["data"])) {
      throw new PlatformConnectionError(
        platform,
        "Bilibili API response omitted data",
      );
    }
    return body["data"];
  });
}

function addWbiSignature(
  params: Readonly<Record<string, string>>,
  wbiKey: string,
  now: () => number,
): Readonly<Record<string, string>> {
  const signed: Record<string, string> = {
    ...params,
    wts: String(Math.floor(now() / 1_000)),
  };
  const query = new URLSearchParams();
  for (const key of Object.keys(signed).sort()) {
    query.set(key, signed[key]!.replace(/[!'()*]/gu, ""));
  }
  signed["w_rid"] = createHash("md5")
    .update(query.toString() + wbiKey)
    .digest("hex");
  return signed;
}

function parseHosts(platform: string, value: unknown): readonly WebHost[] {
  if (!Array.isArray(value)) {
    throw new PlatformConnectionError(
      platform,
      "Bilibili danmaku server response omitted host_list",
    );
  }
  const hosts = value.flatMap((candidate): WebHost[] => {
    if (!isRecord(candidate)) {
      return [];
    }
    const host = scalarText(candidate["host"]);
    const wssPort = finiteInteger(candidate["wss_port"]);
    if (
      host === undefined ||
      !/^[a-z\d.-]+$/iu.test(host) ||
      wssPort === undefined ||
      wssPort < 1 ||
      wssPort > 65_535
    ) {
      return [];
    }
    return [{ host, wssPort }];
  });
  if (hosts.length === 0) {
    throw new PlatformConnectionError(
      platform,
      "Bilibili danmaku server response contained no valid WSS host",
    );
  }
  return hosts;
}


function requestHeaders(
  userAgent: string,
  cookies: ReadonlyMap<string, string>,
): Record<string, string> {
  const cookie = serializeCookies(cookies);
  return {
    "User-Agent": userAgent,
    ...(cookie.length === 0 ? {} : { Cookie: cookie }),
  };
}

function parseCookies(
  platform: string,
  rawCookie: string | undefined,
  sessdata: string | undefined,
): Map<string, string> {
  const cookies = new Map<string, string>();
  if (rawCookie !== undefined) {
    if (/\r|\n/u.test(rawCookie)) {
      throw new PlatformConfigurationError(
        platform,
        "cookie must not contain line breaks",
      );
    }
    for (const part of rawCookie.split(";")) {
      const separator = part.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (name.length > 0) {
        cookies.set(name, value);
      }
    }
  }
  if (sessdata !== undefined && sessdata.trim().length > 0) {
    const value = sessdata.trim();
    if (/[;\r\n]/u.test(value)) {
      throw new PlatformConfigurationError(
        platform,
        "sessdata must contain only the SESSDATA cookie value",
      );
    }
    cookies.set("SESSDATA", value);
  }
  return cookies;
}

function captureBuvidCookie(headers: Headers, cookies: Map<string, string>): void {
  const getSetCookie = (headers as Headers & {
    getSetCookie?: () => readonly string[];
  }).getSetCookie;
  const values =
    typeof getSetCookie === "function"
      ? getSetCookie.call(headers)
      : [headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const match = /(?:^|,\s*)buvid3=([^;,\s]+)/iu.exec(value);
    if (match?.[1] !== undefined) {
      cookies.set("buvid3", match[1]);
      return;
    }
  }
}

function serializeCookies(cookies: ReadonlyMap<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function fileStem(value: unknown): string | undefined {
  const text = scalarText(value);
  if (text === undefined) {
    return undefined;
  }
  try {
    const pathname = new URL(text).pathname;
    const file = pathname.slice(pathname.lastIndexOf("/") + 1);
    const dot = file.indexOf(".");
    const stem = dot < 0 ? file : file.slice(0, dot);
    return stem.length > 0 ? stem : undefined;
  } catch {
    return undefined;
  }
}

function scalarText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
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
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () =>
      timeoutController.abort(
        new DOMException("Bilibili request timed out", "TimeoutError"),
      ),
    timeoutMs,
  );
  timeout.unref?.();
  try {
    return await operation(AbortSignal.any([signal, timeoutController.signal]));
  } finally {
    clearTimeout(timeout);
  }
}
