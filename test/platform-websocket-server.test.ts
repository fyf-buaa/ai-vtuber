import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import {
  afterEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import type { LiveEvent } from "../src/domain/types.js";
import {
  JsonWebSocketServerSource,
  type JsonWebSocketServerSourceOptions,
} from "../src/platforms/websocket-server.js";
import type {
  WebSocketConnection,
  WebSocketServerHandle,
  WebSocketServerOptions,
} from "../src/platforms/types.js";

const RELAY_TOKEN_ENVIRONMENT_VARIABLE = "AI_VTUBER_RELAY_TOKEN";
const TEST_CREDENTIAL = "0123456789abcdef0123456789abcdef";

interface CapturedServerOptions extends WebSocketServerOptions {
  readonly maxPayload: number;
  readonly verifyClient: (
    info: {
      readonly origin: string;
      readonly secure: boolean;
      readonly req: IncomingMessage;
    },
    callback: (
      accepted: boolean,
      statusCode?: number,
      message?: string,
    ) => void,
  ) => void;
}

interface VerificationResult {
  readonly accepted: boolean;
  readonly statusCode: number | undefined;
  readonly message: string | undefined;
}

class FakeServerConnection extends EventEmitter {
  readyState = 1;
  readonly sent: Array<string | Uint8Array> = [];
  readonly closeStatuses: Array<{
    readonly code: number;
    readonly reason: string;
  }> = [];
  terminateCalls = 0;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  receive(payload: unknown): void {
    this.receiveRaw(Buffer.from(JSON.stringify(payload)));
  }

  receiveRaw(data: unknown): void {
    this.emit("message", data, false);
  }

  close(code = 1_000, reason = ""): void {
    if (this.readyState === 3) {
      return;
    }
    this.closeStatuses.push({ code, reason });
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.close(1_006, "terminated");
  }
}

class FakeWebSocketServer extends EventEmitter {
  readonly clients = new Set<WebSocketConnection>();
  closeCalls = 0;

  connect(
    connection = new FakeServerConnection(),
    headers: IncomingHttpHeaders = { host: "127.0.0.1:5001" },
  ): FakeServerConnection {
    const typedConnection = connection as unknown as WebSocketConnection;
    this.clients.add(typedConnection);
    connection.once("close", () => this.clients.delete(typedConnection));
    this.emit("connection", typedConnection, requestWithHeaders(headers));
    return connection;
  }

  close(callback: (error?: Error) => void): void {
    this.closeCalls += 1;
    callback();
  }
}

interface ServerHarness {
  readonly source: JsonWebSocketServerSource;
  readonly server: FakeWebSocketServer;
  readonly onError: Mock<(error: Error) => void>;
  readonly serverOptions: () => CapturedServerOptions;
}

function liveEvent(payload: unknown): readonly LiveEvent[] {
  const record = payload as { readonly id?: unknown; readonly content?: unknown };
  return [
    {
      id: String(record.id ?? "event"),
      type: "comment",
      platform: "test",
      username: "viewer",
      content: String(record.content ?? record.id ?? "message"),
      timestamp: 0,
      metadata: {},
    },
  ];
}

function createHarness(
  overrides: Omit<
    Partial<JsonWebSocketServerSourceOptions>,
    "webSocketServerFactory"
  > = {},
): ServerHarness {
  const server = new FakeWebSocketServer();
  const onError = vi.fn<(error: Error) => void>();
  let capturedOptions: CapturedServerOptions | undefined;
  const source = new JsonWebSocketServerSource({
    name: "relay-listener-test",
    listen: { host: "127.0.0.1", port: 5_001 },
    normalize: liveEvent,
    onError,
    ...overrides,
    webSocketServerFactory: (options) => {
      capturedOptions = options as CapturedServerOptions;
      queueMicrotask(() => server.emit("listening"));
      return server as unknown as WebSocketServerHandle;
    },
  });
  return {
    source,
    server,
    onError,
    serverOptions: () => {
      if (capturedOptions === undefined) {
        throw new Error("WebSocket server has not been started");
      }
      return capturedOptions;
    },
  };
}

function requestWithHeaders(headers: IncomingHttpHeaders): IncomingMessage {
  return { headers } as IncomingMessage;
}

function verifyHandshake(
  options: CapturedServerOptions,
  headers: IncomingHttpHeaders,
): VerificationResult {
  let result: VerificationResult | undefined;
  options.verifyClient(
    {
      origin: typeof headers.origin === "string" ? headers.origin : "",
      secure: false,
      req: requestWithHeaders(headers),
    },
    (accepted, statusCode, message) => {
      result = { accepted, statusCode, message };
    },
  );
  if (result === undefined) {
    throw new Error("WebSocket verification callback was not invoked");
  }
  return result;
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("JsonWebSocketServerSource security and resource bounds", () => {
  it("refuses a non-loopback listener without an explicit relay credential", () => {
    vi.stubEnv(RELAY_TOKEN_ENVIRONMENT_VARIABLE, undefined);

    expect(() =>
      createHarness({ listen: { host: "0.0.0.0", port: 5_001 } }),
    ).toThrowError(
      /non-loopback WebSocket listeners require AI_VTUBER_RELAY_TOKEN/u,
    );
  });

  it("allows the remaining userscript origin and rejects other browser origins without authentication", async () => {
    vi.stubEnv(RELAY_TOKEN_ENVIRONMENT_VARIABLE, undefined);
    const harness = createHarness();
    await harness.source.start(() => undefined);

    try {
      const options = harness.serverOptions();
      expect(
        verifyHandshake(options, {
          host: "127.0.0.1:5001",
          origin: "https://redlive.xiaohongshu.com",
        }),
      ).toEqual({
        accepted: true,
        statusCode: undefined,
        message: undefined,
      });
      expect(
        verifyHandshake(options, {
          host: "127.0.0.1:5001",
          origin: "https://live.example",
        }),
      ).toMatchObject({ accepted: false, statusCode: 403 });
      expect(
        verifyHandshake(options, {
          host: "attacker.example:5001",
        }),
      ).toMatchObject({ accepted: false, statusCode: 403 });
      expect(
        verifyHandshake(options, { host: "127.0.0.1:5001" }),
      ).toEqual({ accepted: true, statusCode: undefined, message: undefined });
    } finally {
      await harness.source.dispose();
    }
  });

  it("authenticates every listener when a Bearer credential is configured", async () => {
    const harness = createHarness({ credential: TEST_CREDENTIAL });
    await harness.source.start(() => undefined);

    try {
      const options = harness.serverOptions();
      expect(
        verifyHandshake(options, { host: "127.0.0.1:5001" }),
      ).toMatchObject({ accepted: false, statusCode: 401 });
      const wrongCredential = verifyHandshake(options, {
        host: "127.0.0.1:5001",
        authorization: "Bearer incorrect",
      });
      expect(wrongCredential).toEqual({
        accepted: false,
        statusCode: 401,
        message: "WebSocket authentication required",
      });
      expect(JSON.stringify(wrongCredential)).not.toContain(TEST_CREDENTIAL);
      expect(JSON.stringify(wrongCredential)).not.toContain("incorrect");
      expect(
        verifyHandshake(options, {
          host: "127.0.0.1:5001",
          origin: "https://custom-relay.example",
          authorization: `Bearer ${TEST_CREDENTIAL}`,
        }),
      ).toEqual({ accepted: true, statusCode: undefined, message: undefined });

      const rejected = harness.server.connect(new FakeServerConnection(), {
        host: "127.0.0.1:5001",
      });
      expect(rejected.closeStatuses).toEqual([
        { code: 1_008, reason: "WebSocket authentication required" },
      ]);
    } finally {
      await harness.source.dispose();
    }
  });

  it("uses AI_VTUBER_RELAY_TOKEN to protect wildcard listeners", async () => {
    vi.stubEnv(RELAY_TOKEN_ENVIRONMENT_VARIABLE, TEST_CREDENTIAL);
    const harness = createHarness({
      listen: { host: "0.0.0.0", port: 5_001 },
    });
    await harness.source.start(() => undefined);

    try {
      const options = harness.serverOptions();
      expect(
        verifyHandshake(options, {
          host: "192.0.2.10:5001",
          authorization: `Bearer ${TEST_CREDENTIAL}`,
        }),
      ).toEqual({ accepted: true, statusCode: undefined, message: undefined });
      expect(
        verifyHandshake(options, { host: "192.0.2.10:5001" }),
      ).toMatchObject({ accepted: false, statusCode: 401 });
    } finally {
      await harness.source.dispose();
    }
  });

  it("passes maxPayload to ws and closes oversized frames with status 1009", async () => {
    vi.stubEnv(RELAY_TOKEN_ENVIRONMENT_VARIABLE, undefined);
    const handler = vi.fn();
    const harness = createHarness({
      maximumPayloadBytes: 32,
      maximumQueuedBytes: 128,
    });
    await harness.source.start(handler);

    try {
      expect(harness.serverOptions().maxPayload).toBe(32);
      const connection = harness.server.connect();
      connection.receiveRaw(Buffer.alloc(33));

      expect(connection.closeStatuses).toEqual([
        { code: 1_009, reason: "Inbound message limit exceeded" },
      ]);
      expect(handler).not.toHaveBeenCalled();
      expect(harness.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("inbound frame payload"),
        }),
      );
    } finally {
      await harness.source.dispose();
    }
  });

  it("bounds accepted connections and keeps a stalled closed connection counted", async () => {
    vi.stubEnv(RELAY_TOKEN_ENVIRONMENT_VARIABLE, undefined);
    const releaseHandler = Promise.withResolvers<void>();
    const handled: string[] = [];
    const harness = createHarness({
      maximumConnections: 1,
      maximumQueuedFrames: 2,
      maximumQueuedBytes: 1_024,
    });
    await harness.source.start(async (event) => {
      handled.push(event.id);
      await releaseHandler.promise;
    });

    try {
      const first = harness.server.connect();
      first.receive({ id: "one" });
      await vi.waitFor(() => expect(handled).toEqual(["one"]));

      first.receive({ id: "two" });
      first.receive({ id: "three" });
      expect(first.closeStatuses).toEqual([
        { code: 1_009, reason: "Inbound message limit exceeded" },
      ]);

      const whileStalled = harness.server.connect();
      expect(whileStalled.closeStatuses).toEqual([
        { code: 1_013, reason: "Connection limit exceeded" },
      ]);
      expect(handled).toEqual(["one"]);

      releaseHandler.resolve();
      await settleMicrotasks();
      const afterDrain = harness.server.connect();
      expect(afterDrain.closeStatuses).toHaveLength(0);
    } finally {
      releaseHandler.resolve();
      await harness.source.dispose();
    }
  });

  it("serializes normal frames in order and preserves relay info acknowledgement", async () => {
    vi.stubEnv(RELAY_TOKEN_ENVIRONMENT_VARIABLE, undefined);
    const releaseFirst = Promise.withResolvers<void>();
    const handled: string[] = [];
    const harness = createHarness({
      maximumQueuedFrames: 4,
      maximumQueuedBytes: 1_024,
    });
    await harness.source.start(async (event) => {
      handled.push(event.id);
      if (event.id === "one") {
        await releaseFirst.promise;
      }
    });

    try {
      const connection = harness.server.connect();
      connection.receive({ type: "info" });
      connection.receive({ id: "one" });
      connection.receive({ id: "two" });
      connection.receive({ id: "three" });
      await vi.waitFor(() => expect(handled).toEqual(["one"]));

      expect(connection.sent).toHaveLength(1);
      expect(JSON.parse(String(connection.sent[0]))).toEqual({
        type: "ack",
        status: "ok",
        received: "info",
      });

      releaseFirst.resolve();
      await vi.waitFor(() => expect(handled).toEqual(["one", "two", "three"]));
    } finally {
      releaseFirst.resolve();
      await harness.source.dispose();
    }
  });

  it("disposes without waiting forever for an application handler", async () => {
    vi.stubEnv(RELAY_TOKEN_ENVIRONMENT_VARIABLE, undefined);
    const releaseHandler = Promise.withResolvers<void>();
    const handlerStarted = Promise.withResolvers<void>();
    const harness = createHarness();
    await harness.source.start(async () => {
      handlerStarted.resolve();
      await releaseHandler.promise;
    });
    const connection = harness.server.connect();
    connection.receive({ id: "stalled" });
    await handlerStarted.promise;

    const outcome = await Promise.race([
      harness.source.dispose().then(() => "disposed" as const),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 100);
      }),
    ]);

    expect(outcome).toBe("disposed");
    expect(harness.server.closeCalls).toBe(1);
    expect(connection.closeStatuses).toEqual([
      { code: 1_001, reason: "Event source disposed" },
    ]);
    releaseHandler.resolve();
    await settleMicrotasks();
  });
});
