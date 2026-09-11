import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { LiveEvent } from "../src/domain/types.js";
import {
  BilibiliPlatformSource,
  BilibiliWebSource,
  PlatformConfigurationError,
  ReconnectingWebSocketSource,
  StdinJsonLineSource,
  YouTubeLiveChatSource,
  createPlatformEventSource,
  createRelayServerSource,
  normalizeLivePayload,
} from "../src/platforms/index.js";
import type {
  ReconnectOptions,
  WebSocketConnection,
  WebSocketServerHandle,
} from "../src/platforms/index.js";

const NOW = 1_700_000_000_123;
const RECONNECT: ReconnectOptions = {
  initialDelayMs: 1,
  maximumDelayMs: 2,
  maximumAttempts: 2,
  connectionTimeoutMs: 100,
  acknowledgementTimeoutMs: 100,
  stableConnectionMs: 1_000,
};

interface RelayCase {
  readonly name: string;
  readonly platform: string;
  readonly payload: unknown;
  readonly expected: {
    readonly type: LiveEvent["type"];
    readonly username: string;
    readonly content: string;
    readonly timestamp?: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

const relayCases: readonly RelayCase[] = [
  {
    name: "Ordinaryroad danmu",
    platform: "ordinaryroad_barrage_fly",
    payload: {
      type: "DANMU",
      platform: "YOUTUBE",
      roomId: "room-1",
      msg: {
        id: "or-1",
        uid: "u-2",
        username: "Dana",
        content: "hi",
      },
    },
    expected: {
      type: "comment",
      username: "Dana",
      content: "hi",
      metadata: {
        protocol: "ordinaryroad-json",
        relayPlatform: "YOUTUBE",
        roomId: "room-1",
        userId: "u-2",
      },
    },
  },
  {
    name: "Ordinaryroad gift",
    platform: "ordinaryroad_barrage_fly",
    payload: {
      type: "GIFT",
      platform: "BILIBILI",
      roomId: "room-2",
      msg: {
        id: "or-2",
        username: "Eve",
        giftName: "Rose",
        giftCount: 2,
        giftPrice: 5,
      },
    },
    expected: {
      type: "gift",
      username: "Eve",
      content: "Rose x2",
      metadata: {
        protocol: "ordinaryroad-json",
        giftName: "Rose",
        quantity: 2,
        unitPrice: 5,
        totalPrice: 10,
      },
    },
  },
  {
    name: "Bilibili platform danmu",
    platform: "bilibili-platform",
    payload: {
      cmd: "LIVE_OPEN_PLATFORM_DM",
      data: {
        msg_id: "bili-1",
        room_id: 42,
        uid: 7,
        uname: "Frank",
        msg: "弹幕",
        timestamp: 1_700_000_002,
      },
    },
    expected: {
      type: "comment",
      username: "Frank",
      content: "弹幕",
      timestamp: 1_700_000_002_000,
      metadata: {
        protocol: "bilibili-platform",
        command: "LIVE_OPEN_PLATFORM_DM",
        roomId: 42,
        userId: 7,
      },
    },
  },
  {
    name: "Bilibili web interact entrance",
    platform: "bilibili-web",
    payload: {
      cmd: "INTERACT_WORD",
      data: {
        msg_id: "bili-enter",
        uname: "Helen",
        msg_type: 1,
      },
    },
    expected: {
      type: "entrance",
      username: "Helen",
      content: "进入直播间",
      metadata: {
        protocol: "bilibili-web",
        command: "INTERACT_WORD",
        msgType: 1,
      },
    },
  },
  {
    name: "Bilibili web interact follow",
    platform: "bilibili-web",
    payload: {
      cmd: "INTERACT_WORD",
      data: {
        msg_id: "bili-follow",
        uname: "Ian",
        msg_type: 2,
      },
    },
    expected: {
      type: "follow",
      username: "Ian",
      content: "关注了直播间",
      metadata: {
        protocol: "bilibili-web",
        command: "INTERACT_WORD",
        msgType: 2,
      },
    },
  },
  {
    name: "Bilibili web gift",
    platform: "bilibili-web",
    payload: {
      cmd: "SEND_GIFT",
      data: {
        tid: "bili-2",
        uname: "Grace",
        giftName: "辣条",
        num: 4,
        total_coin: 8_000,
      },
    },
    expected: {
      type: "gift",
      username: "Grace",
      content: "辣条 x4",
      metadata: {
        protocol: "bilibili-web",
        giftName: "辣条",
        quantity: 4,
        unitPrice: 2,
        totalPrice: 8,
        currency: "CNY",
      },
    },
  },
];

describe("platform payload normalization", () => {
  it.each(relayCases)("normalizes $name", ({ platform, payload, expected }) => {
    const events = normalizeLivePayload(payload, { platform, now: () => NOW });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      type: expected.type,
      platform,
      username: expected.username,
      content: expected.content,
      timestamp: expected.timestamp ?? NOW,
      metadata: expected.metadata ?? {},
    });
    expect(event.id).toMatch(new RegExp(`^${platform}:`));
    expect(Object.keys(event).sort()).toEqual([
      "content",
      "id",
      "metadata",
      "platform",
      "timestamp",
      "type",
      "username",
    ]);
    expect(Object.isFrozen(event)).toBe(true);

    expect(Object.isFrozen(event.metadata)).toBe(true);
  });
  it("drops Bilibili interact messages with unknown semantics", () => {
    expect(normalizeLivePayload({
      cmd: "INTERACT_WORD",
      data: { msg_id: "bili-unknown", uname: "Viewer", msg_type: 99 },
    }, { platform: "bilibili-web", now: () => NOW })).toEqual([]);
  });

  it("uses a deterministic fallback id without trusting receive time", () => {
    const payload = { type: "comment", username: "same", content: "same" };
    const first = normalizeLivePayload(payload, {
      platform: "relay",
      now: () => 100,
    })[0]!;
    const second = normalizeLivePayload(payload, {
      platform: "relay",
      now: () => 200,
    })[0]!;
    expect(first.id).toBe(second.id);
    expect(first.timestamp).toBe(100);
    expect(second.timestamp).toBe(200);
  });
});

class FakeConnection extends EventEmitter {
  readyState = 0;
  readonly sent: (string | Uint8Array)[] = [];
  closed = false;
  terminated = false;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.terminated = true;
    this.close(1006, "terminated");
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  receive(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)), false);
  }
}

class FakeServer extends EventEmitter {
  readonly clients = new Set<WebSocketConnection>();
  closed = false;
  readonly #release: () => void;

  constructor(release: () => void) {
    super();
    this.#release = release;
    queueMicrotask(() => this.emit("listening"));
  }

  close(callback: (error?: Error) => void): void {
    this.closed = true;
    this.#release();
    callback();
  }

  connect(connection: FakeConnection): void {
    this.clients.add(connection as unknown as WebSocketConnection);
    this.emit("connection", connection);
  }
}

describe("WebSocket relay lifecycle", () => {
  it("accepts generic relay events, acknowledges info, and releases its port", async () => {
    let bound = false;
    let server: FakeServer | undefined;
    const factory = vi.fn(() => {
      if (bound) throw new Error("EADDRINUSE");
      bound = true;
      server = new FakeServer(() => {
        bound = false;
      });
      return server as unknown as WebSocketServerHandle;
    });
    const events: LiveEvent[] = [];
    const source = createRelayServerSource(
      { platform: "relay-a", listenUrl: "ws://127.0.0.1:5001" },
      { webSocketServerFactory: factory, now: () => NOW },
    );
    await source.start((event) => {
      events.push(event);
    });
    const connection = new FakeConnection();
    server!.connect(connection);
    connection.receive({ type: "info", content: "ws连接成功" });
    connection.receive({ type: "comment", username: "viewer", content: "hi" });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(JSON.parse(String(connection.sent[0]))).toEqual({
      type: "ack",
      status: "ok",
      received: "info",
    });

    const colliding = createRelayServerSource(
      { platform: "relay-b", listenUrl: "ws://127.0.0.1:5001" },
      { webSocketServerFactory: factory },
    );
    await expect(colliding.start(() => undefined)).rejects.toThrow("cannot bind");

    await source.dispose();
    expect(bound).toBe(false);
    expect(server!.closed).toBe(true);
    expect(connection.closed).toBe(true);

    const replacement = createRelayServerSource(
      { platform: "relay-c", listenUrl: "ws://127.0.0.1:5001" },
      { webSocketServerFactory: factory },
    );
    await replacement.start(() => undefined);
    await replacement.dispose();
  });

  it("does not reconnect after disposal aborts backoff", async () => {
    const sockets: FakeConnection[] = [];
    const sleepStarted = vi.fn();
    const source = new ReconnectingWebSocketSource({
      name: "relay",
      session: () => Promise.resolve({ url: "ws://127.0.0.1:9999" }),
      normalize: (payload) =>
        normalizeLivePayload(payload, { platform: "relay", now: () => NOW }),
      reconnect: RECONNECT,
      webSocketFactory: () => {
        const socket = new FakeConnection();
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocketConnection;
      },
      sleep: (_milliseconds, signal) =>
        new Promise<void>((resolve, reject) => {
          sleepStarted();
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
          void resolve;
        }),
      onError: vi.fn(),
      random: () => 0.5,
      now: () => NOW,
    });
    await source.start(() => undefined);
    sockets[0]!.close(1006, "relay stopped");
    await vi.waitFor(() => expect(sleepStarted).toHaveBeenCalledOnce());
    await source.dispose();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
  });
});

describe("polling and manual sources", () => {
  it("stops YouTube polling when disposed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ liveStreamingDetails: { activeLiveChatId: "chat-1" } }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            pollingIntervalMillis: 1_000,
            nextPageToken: "page-2",
            items: [
              {
                id: "yt-1",
                snippet: {
                  type: "textMessageEvent",
                  publishedAt: "2023-11-14T22:13:20.000Z",
                  displayMessage: "hello",
                  textMessageDetails: { messageText: "hello" },
                },
                authorDetails: { channelId: "u", displayName: "Viewer" },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const sleeping = vi.fn();
    const source = new YouTubeLiveChatSource(
      {
        apiKey: "key",
        videoId: "video-1",
        reconnect: RECONNECT,
      },
      {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: (_milliseconds, signal) =>
          new Promise<void>((_resolve, reject) => {
            sleeping();
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      },
    );
    const events: LiveEvent[] = [];
    await source.start((event) => {
      events.push(event);
    });
    await vi.waitFor(() => expect(sleeping).toHaveBeenCalledOnce());
    await source.dispose();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "youtube:comment:yt-1",
      type: "comment",
      username: "Viewer",
      content: "hello",
    });
  });

  it("treats an untyped talk JSON line as a manual talk event", async () => {
    const input = new PassThrough();
    const events: LiveEvent[] = [];
    const source = new StdinJsonLineSource("talk", {
      stdin: input,
      now: () => NOW,
    });
    await source.start((event) => {
      events.push(event);
    });
    input.write(`${JSON.stringify({ username: "operator", content: "say this" })}\n`);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      type: "talk",
      platform: "talk",
      username: "operator",
      content: "say this",
    });
    await source.dispose();
  });

  it("selects supported manual adapters", async () => {
    const stdin = new PassThrough();
    const talk = createPlatformEventSource({ platform: "talk" }, { stdin });
    expect(talk).toBeInstanceOf(StdinJsonLineSource);
    await talk.dispose();

    const web = createPlatformEventSource({
      platform: "bilibili-web",
      room_display_id: 278_333,
    });
    expect(web).toBeInstanceOf(BilibiliWebSource);
    await web.dispose();

    const openPlatform = createPlatformEventSource({
      platform: "bilibili-platform",
      "bilibili-platform": {
        ACCESS_KEY_ID: "access-key-id",
        ACCESS_KEY_SECRET: "access-key-secret",
        APP_ID: 100,
        ROOM_OWNER_AUTH_CODE: "room-owner-auth-code",
      },
    });
    expect(openPlatform).toBeInstanceOf(BilibiliPlatformSource);
    await openPlatform.dispose();

    expect(() => createPlatformEventSource({ platform: "youtube" })).toThrow(
      /youtube.*待完善.*bilibili-web/u,
    );
  });

  it.each(["youtube", "twitch", "ordinaryroad_barrage_fly"])(
    "rejects pending platform activation %s before adapter configuration",
    (platform) => {
      expect(() =>
        createPlatformEventSource({
          platform,
          [platform]: { relay_ws_url: "ws://relay.test/socket" },
        }),
      ).toThrow(/待完善.*bilibili-platform/u);
    },
  );

  it.each([
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
  ])("rejects removed platform adapter %s", (platform) => {
    expect(() =>
      createPlatformEventSource({
        platform,
        [platform]: { relay_ws_url: "ws://relay.test/socket" },
      }),
    ).toThrow(PlatformConfigurationError);
    expect(() =>
      createPlatformEventSource({
        platform,
        [platform]: { relay_ws_url: "ws://relay.test/socket" },
      }),
    ).toThrow(/platform adapter was removed/u);
  });
});
