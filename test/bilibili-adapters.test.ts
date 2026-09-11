import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  BilibiliPlatformSource,
  BilibiliWebSource,
} from "../src/platforms/index.js";
import {
  encodeBilibiliPacket,
} from "../src/platforms/bilibili-protocol.js";
import type {
  ReconnectOptions,
  WebSocketConnection,
  WebSocketConnectOptions,
} from "../src/platforms/types.js";
import type { LiveEvent } from "../src/domain/types.js";

const NOW = 1_700_000_000_000;
const RECONNECT: ReconnectOptions = {
  initialDelayMs: 1,
  maximumDelayMs: 1,
  maximumAttempts: 1,
  connectionTimeoutMs: 1_000,
  acknowledgementTimeoutMs: 1_000,
  stableConnectionMs: 1_000,
};

class FakeBilibiliConnection extends EventEmitter {
  readyState = 0;
  readonly sent: Uint8Array[] = [];

  send(data: string | Uint8Array): void {
    const packet = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    this.sent.push(packet);
    if (packet.byteLength >= 16 && packet.readUInt32BE(8) === 7) {
      queueMicrotask(() => {
        this.receivePacket(encodeBilibiliPacket(8, JSON.stringify({ code: 0 })));
      });
    }
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  receiveCommand(command: unknown): void {
    this.receivePacket(
      encodeBilibiliPacket(5, JSON.stringify(command)),
    );
  }

  close(code = 1_000, reason = ""): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.close(1_006, "terminated");
  }

  private receivePacket(packet: Uint8Array): void {
    if (this.readyState === 3) {
      return;
    }
    this.emit("message", Buffer.from(packet), true);
  }
}

function packetOperation(packet: Uint8Array): number {
  return Buffer.from(packet).readUInt32BE(8);
}

function packetText(packet: Uint8Array): string {
  const bytes = Buffer.from(packet);
  const headerLength = bytes.readUInt16BE(4);
  const packetLength = bytes.readUInt32BE(0);
  return bytes.subarray(headerLength, packetLength).toString("utf8");
}

function packetJson(packet: Uint8Array): unknown {
  return JSON.parse(packetText(packet));
}

function inputUrl(input: string | URL | Request): URL {
  if (input instanceof URL) {
    return input;
  }
  return new URL(typeof input === "string" ? input : input.url);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Bilibili adapters", () => {
  it("initializes anonymous web protocol, authenticates, and emits room danmaku", async () => {
    const navUrl = "https://api.test/nav";
    const roomInfoUrl = "https://api.test/room";
    const danmakuInfoUrl = "https://api.test/danmaku";
    const imageKey = "abcdefghijklmnopqrstuvwxyz012345";
    const subKey = "ABCDEFGHIJKLMNOPQRSTUVWXYZ678901";
    const requestedUrls: URL[] = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request): Promise<Response> => {
        const url = inputUrl(input);
        requestedUrls.push(url);
        if (url.href.startsWith(roomInfoUrl)) {
          return jsonResponse({ code: 0, data: { room_id: 42, uid: 9001 } });
        }
        if (url.href.startsWith(navUrl)) {
          return jsonResponse({
            code: -101,
            message: "账号未登录",
            data: {
              isLogin: false,
              wbi_img: {
                img_url: `https://i.test/${imageKey}.png`,
                sub_url: `https://i.test/${subKey}.png`,
              },
            },
          });
        }
        if (url.href.startsWith(danmakuInfoUrl)) {
          return jsonResponse({
            code: 0,
            data: {
              token: "danmaku-token",
              host_list: [
                { host: "broadcast.test", wss_port: 443 },
              ],
            },
          });
        }
        throw new Error(`Unexpected request: ${url.href}`);
      },
    );
    const connection = new FakeBilibiliConnection();
    let connectedUrl: string | undefined;
    let connectedOptions: WebSocketConnectOptions | undefined;
    const events: LiveEvent[] = [];
    const onError = vi.fn();
    const source = new BilibiliWebSource(
      {
        roomId: 7,
        sessdata: "session-value",
        cookie: "buvid3=device-value",
        navUrl,
        roomInfoUrl,
        danmakuInfoUrl,
        reconnect: RECONNECT,
      },
      {
        fetch: fetchMock as unknown as typeof fetch,
        now: () => NOW,
        webSocketFactory: (url, _protocols, options) => {
          connectedUrl = url;
          connectedOptions = options;
          queueMicrotask(() => connection.open());
          return connection as unknown as WebSocketConnection;
        },
        onError,
      },
    );

    try {
      await source.start((event) => {
        events.push(event);
      });

      expect(connectedUrl).toBe("wss://broadcast.test:443/sub");
      expect(connectedOptions?.headers).toMatchObject({
        Cookie: "buvid3=device-value; SESSDATA=session-value",
      });
      const authPacket = connection.sent.find(
        (packet) => packetOperation(packet) === 7,
      );
      expect(authPacket).toBeDefined();
      expect(packetJson(authPacket!)).toEqual({
        uid: 0,
        roomid: 42,
        protover: 3,
        platform: "web",
        type: 2,
        buvid: "device-value",
        key: "danmaku-token",
      });
      expect(connection.sent.map(packetOperation)).toContain(2);

      const danmakuRequest = requestedUrls.find((url) =>
        url.href.startsWith(danmakuInfoUrl),
      );
      expect(danmakuRequest?.searchParams.get("id")).toBe("42");
      expect(danmakuRequest?.searchParams.get("type")).toBe("0");
      expect(danmakuRequest?.searchParams.get("wts")).toBe("1700000000");
      expect(danmakuRequest?.searchParams.get("w_rid")).toMatch(/^[a-f\d]{32}$/u);

      connection.receiveCommand({
        cmd: "DANMU_MSG",
        info: [
          [0, 1, 25, 16_777_215, 1_700_000_001, 99],
          "web 弹幕",
          [456, "Web用户"],
        ],
      });
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toMatchObject({
        type: "comment",
        platform: "bilibili-web",
        username: "Web用户",
        content: "web 弹幕",
        timestamp: 1_700_000_001_000,
        metadata: {
          protocol: "bilibili-web",
          command: "DANMU_MSG",
          userId: 456,
        },
      });
    } finally {
      await source.dispose();
    }
    expect(onError).not.toHaveBeenCalled();
  });

  it("maintains an Open Live game while receiving platform danmaku", async () => {
    const startUrl = "https://open.test/start";
    const heartbeatUrl = "https://open.test/heartbeat";
    const endUrl = "https://open.test/end";
    const requests: Array<{
      readonly url: string;
      readonly init: RequestInit | undefined;
    }> = [];
    const fetchMock = vi.fn(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = inputUrl(input).href;
        requests.push({ url, init });
        if (url === startUrl) {
          return jsonResponse({
            code: 0,
            data: {
              game_info: { game_id: "game-1" },
              websocket_info: {
                auth_body: "platform-auth-body",
                wss_link: ["wss://platform.test/sub"],
              },
              anchor_info: { room_id: 88 },
            },
          });
        }
        if (url === heartbeatUrl) {
          return jsonResponse({ code: 0, data: {} });
        }
        if (url === endUrl) {
          return jsonResponse({ code: 7003, message: "already closed" });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    const connection = new FakeBilibiliConnection();
    const events: LiveEvent[] = [];
    const onError = vi.fn();
    const source = new BilibiliPlatformSource(
      {
        accessKeyId: "access-id",
        accessKeySecret: "access-secret",
        appId: 100,
        roomOwnerAuthCode: "owner-code",
        startUrl,
        heartbeatUrl,
        endUrl,
        gameHeartbeatIntervalMs: 5,
        reconnect: RECONNECT,
      },
      {
        fetch: fetchMock as unknown as typeof fetch,
        now: () => NOW,
        webSocketFactory: () => {
          queueMicrotask(() => connection.open());
          return connection as unknown as WebSocketConnection;
        },
        onError,
      },
    );

    try {
      await source.start((event) => {
        events.push(event);
      });
      const startRequest = requests.find(({ url }) => url === startUrl);
      const startBody = String(startRequest?.init?.body);
      const startHeaders = new Headers(startRequest?.init?.headers);
      expect(JSON.parse(startBody)).toEqual({ code: "owner-code", app_id: 100 });
      expect(startHeaders.get("x-bili-content-md5")).toBe(
        createHash("md5").update(startBody).digest("hex"),
      );
      expect(startHeaders.get("x-bili-accesskeyid")).toBe("access-id");
      expect(startHeaders.get("authorization")).toMatch(/^[a-f\d]{64}$/u);
      const authPacket = connection.sent.find(
        (packet) => packetOperation(packet) === 7,
      );
      expect(authPacket).toBeDefined();
      expect(packetText(authPacket!)).toBe("platform-auth-body");
      expect(connection.sent.map(packetOperation)).toContain(2);

      connection.receiveCommand({
        cmd: "LIVE_OPEN_PLATFORM_DM",
        data: {
          msg_id: "platform-message-1",
          room_id: 88,
          open_id: "open-user-1",
          uname: "开放平台用户",
          msg: "平台弹幕",
          timestamp: 1_700_000_002,
        },
      });
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toMatchObject({
        id: "bilibili-platform:comment:platform-message-1",
        type: "comment",
        platform: "bilibili-platform",
        username: "开放平台用户",
        content: "平台弹幕",
        metadata: {
          protocol: "bilibili-platform",
          command: "LIVE_OPEN_PLATFORM_DM",
          roomId: 88,
          userId: "open-user-1",
        },
      });
      await vi.waitFor(() =>
        expect(requests.some(({ url }) => url === heartbeatUrl)).toBe(true),
      );
      const heartbeatRequest = requests.find(({ url }) => url === heartbeatUrl);
      expect(JSON.parse(String(heartbeatRequest?.init?.body))).toEqual({
        game_id: "game-1",
      });
    } finally {
      await source.dispose();
    }
    expect(onError).not.toHaveBeenCalled();

    expect(requests.some(({ url }) => url === endUrl)).toBe(true);
  });
});
