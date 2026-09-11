import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ReconnectingWebSocketSource } from "../src/platforms/websocket-client.js";
import type {
  ReconnectOptions,
  WebSocketConnection,
  WebSocketConnectOptions,
} from "../src/platforms/types.js";

const NativeAbortController = globalThis.AbortController;

const RECONNECT: ReconnectOptions = {
  initialDelayMs: 1,
  maximumDelayMs: 1,
  maximumAttempts: 8,
  connectionTimeoutMs: 1_000,
  acknowledgementTimeoutMs: 1_000,
  stableConnectionMs: 1_000,
};

type AbortListener = EventListenerOrEventListenerObject;

interface RegisteredAbortListener {
  readonly listener: AbortListener;
  readonly once: boolean;
}

class FakeAbortSignal {
  aborted = false;
  reason: unknown;
  readonly #listeners = new Map<AbortListener, RegisteredAbortListener>();

  get abortListenerCount(): number {
    return this.#listeners.size;
  }

  addEventListener(
    type: string,
    listener: AbortListener | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type !== "abort" || listener === null || this.#listeners.has(listener)) {
      return;
    }
    this.#listeners.set(listener, {
      listener,
      once: typeof options === "object" && options.once === true,
    });
  }

  removeEventListener(
    type: string,
    listener: AbortListener | null,
    _options?: boolean | EventListenerOptions,
  ): void {
    if (type === "abort" && listener !== null) {
      this.#listeners.delete(listener);
    }
  }

  abort(reason?: unknown): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    this.reason =
      reason ?? new DOMException("This operation was aborted", "AbortError");
    const event = new Event("abort");
    for (const registration of [...this.#listeners.values()]) {
      if (registration.once) {
        this.#listeners.delete(registration.listener);
      }
      if (typeof registration.listener === "function") {
        registration.listener.call(
          this as unknown as EventTarget,
          event,
        );
      } else {
        registration.listener.handleEvent(event);
      }
    }
  }
}

class FakeAbortController {
  static readonly instances: FakeAbortController[] = [];

  readonly trackedSignal = new FakeAbortSignal();
  readonly signal = this.trackedSignal as unknown as AbortSignal;

  constructor() {
    FakeAbortController.instances.push(this);
  }

  abort(reason?: unknown): void {
    this.trackedSignal.abort(reason);
  }
}

class FakeConnection extends EventEmitter {
  readyState = 0;
  terminateWithDeferredError = false;
  readonly closeStatuses: Array<{
    readonly code: number;
    readonly reason: string;
  }> = [];

  send(_data: string | Uint8Array): void {}

  open(): void {
    if (this.readyState !== 0) {
      return;
    }
    this.readyState = 1;
    this.emit("open");
  }

  receive(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)), false);
  }

  receiveAcknowledgement(): void {
    this.receive({ type: "ack" });
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
    if (!this.terminateWithDeferredError) {
      this.close(1_006, "terminated");
      return;
    }
    this.readyState = 3;
    queueMicrotask(() => {
      this.emit("error", new Error("connection terminated while connecting"));
      this.emit("close", 1_006, Buffer.from("terminated"));
    });
  }
}

function installFakeAbortController(): void {
  FakeAbortController.instances.length = 0;
  vi.stubGlobal("AbortController", FakeAbortController);
}

function isAcknowledgement(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "type" in payload &&
    payload.type === "ack"
  );
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeAbortController.instances.length = 0;
});

describe("ReconnectingWebSocketSource lifecycle bounds", () => {
  it("rejects a client payload limit above its queue byte limit", () => {
    expect(
      () =>
        new ReconnectingWebSocketSource({
          name: "payload-limit-test",
          session: () => Promise.resolve({ url: "ws://payload-limit.test" }),
          normalize: () => [],
          reconnect: RECONNECT,
          maximumQueuedBytes: 1_024,
          maximumPayloadBytes: 1_025,
        }),
    ).toThrowError(
      /maximumPayloadBytes must not exceed maximumQueuedBytes/u,
    );
  });

  it("passes the bounded payload limit to every client connection", async () => {
    let capturedOptions:
      | (WebSocketConnectOptions & { readonly maxPayload: number })
      | undefined;
    const connection = new FakeConnection();
    const source = new ReconnectingWebSocketSource({
      name: "payload-options-test",
      session: () =>
        Promise.resolve({
          url: "ws://payload-options.test",
          options: { headers: { Authorization: "Bearer relay-test" } },
        }),
      normalize: () => [],
      reconnect: RECONNECT,
      maximumQueuedBytes: 1_024,
      maximumPayloadBytes: 512,
      webSocketFactory: (_url, _protocols, options) => {
        capturedOptions = options as WebSocketConnectOptions & {
          readonly maxPayload: number;
        };
        queueMicrotask(() => connection.open());
        return connection as unknown as WebSocketConnection;
      },
      onError: vi.fn(),
    });

    try {
      await source.start(() => undefined);
      expect(capturedOptions).toEqual({
        headers: { Authorization: "Bearer relay-test" },
        maxPayload: 512,
      });
    } finally {
      await source.dispose();
    }
  });

  it("retains no timeout abort listeners across successful reconnects", async () => {
    installFakeAbortController();
    const sockets: FakeConnection[] = [];
    const backoffListenerCounts: number[] = [];
    const releaseBackoff: Array<() => void> = [];
    const source = new ReconnectingWebSocketSource({
      name: "listener-test",
      session: () =>
        Promise.resolve({
          url: "ws://listener.test",
          acknowledgement: isAcknowledgement,
        }),
      normalize: () => [],
      reconnect: RECONNECT,
      webSocketFactory: () => {
        const socket = new FakeConnection();
        sockets.push(socket);
        void Promise.resolve().then(() => {
          socket.open();
          socket.receiveAcknowledgement();
        });
        return socket as unknown as WebSocketConnection;
      },
      sleep: (_milliseconds, signal) => {
        if (signal.aborted) {
          return Promise.reject(signal.reason);
        }
        const trackedSignal = FakeAbortController.instances[0]!.trackedSignal;
        backoffListenerCounts.push(trackedSignal.abortListenerCount);
        return new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: unknown): void => {
            if (settled) {
              return;
            }
            settled = true;
            signal.removeEventListener("abort", onAbort);
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          };
          const onAbort = (): void => finish(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          releaseBackoff.push(() => finish());
        });
      },
      random: () => 0.5,
      now: () => 0,
      onError: vi.fn(),
    });
    const controller = FakeAbortController.instances[0]!;

    try {
      await source.start(() => undefined);
      expect(controller.trackedSignal.abortListenerCount).toBe(1);

      for (let cycle = 0; cycle < 5; cycle += 1) {
        sockets[cycle]!.close(1_006, `reconnect-${cycle}`);
        await vi.waitFor(() =>
          expect(releaseBackoff).toHaveLength(cycle + 1),
        );
        expect(backoffListenerCounts[cycle]).toBe(0);

        releaseBackoff[cycle]!();
        await vi.waitFor(() => expect(sockets).toHaveLength(cycle + 2));
        await vi.waitFor(() =>
          expect(controller.trackedSignal.abortListenerCount).toBe(1),
        );
      }
    } finally {
      await source.dispose();
    }

    expect(controller.trackedSignal.abortListenerCount).toBe(0);
  });

  it("preserves the abort reason and removes listeners", async () => {
    const externalController = new NativeAbortController();
    installFakeAbortController();
    const source = new ReconnectingWebSocketSource({
      name: "abort-test",
      session: () =>
        Promise.resolve({
          url: "ws://abort.test",
          acknowledgement: isAcknowledgement,
        }),
      normalize: () => [],
      reconnect: { ...RECONNECT, maximumAttempts: 0 },
      signal: externalController.signal,
      webSocketFactory: () => {
        const socket = new FakeConnection();
        void Promise.resolve().then(() => socket.open());
        return socket as unknown as WebSocketConnection;
      },
      onError: vi.fn(),
    });
    const controller = FakeAbortController.instances[0]!;
    const startFailure = source.start(() => undefined).catch((error: unknown) => error);

    try {
      await settleMicrotasks();
      expect(controller.trackedSignal.abortListenerCount).toBe(2);

      const reason = new DOMException("stop requested", "AbortError");
      externalController.abort(reason);
      expect(await startFailure).toBe(reason);
    } finally {
      await source.dispose();
    }

    expect(controller.trackedSignal.abortListenerCount).toBe(0);
  });

  it("rejects a timed-out acknowledgement and removes listeners", async () => {
    vi.useFakeTimers();
    installFakeAbortController();
    const sockets: FakeConnection[] = [];
    const source = new ReconnectingWebSocketSource({
      name: "timeout-test",
      session: () =>
        Promise.resolve({
          url: "ws://timeout.test",
          acknowledgement: () => false,
        }),
      normalize: () => [],
      reconnect: {
        ...RECONNECT,
        maximumAttempts: 0,
        acknowledgementTimeoutMs: 25,
      },
      webSocketFactory: () => {
        const socket = new FakeConnection();
        sockets.push(socket);
        void Promise.resolve().then(() => socket.open());
        return socket as unknown as WebSocketConnection;
      },
      onError: vi.fn(),
    });
    const controller = FakeAbortController.instances[0]!;
    const startFailure = source.start(() => undefined).catch((error: unknown) => error);

    try {
      await settleMicrotasks();
      expect(sockets).toHaveLength(1);
      expect(controller.trackedSignal.abortListenerCount).toBe(2);

      await vi.advanceTimersByTimeAsync(25);
      const failure = (await startFailure) as Error;
      expect(failure).toMatchObject({
        name: "PlatformConnectionError",
        message:
          'Platform "timeout-test" connection failed: reconnect limit (0) exhausted',
      });
      expect(failure.cause).toMatchObject({
        message: "timeout-test protocol acknowledgement timed out after 25ms",
      });
      expect(controller.trackedSignal.abortListenerCount).toBe(0);
    } finally {
      await source.dispose();
    }

    expect(controller.trackedSignal.abortListenerCount).toBe(0);
  });

  it("keeps a connecting socket error listener through timeout termination and reconnects", async () => {
    vi.useFakeTimers();
    const sockets: FakeConnection[] = [];
    const source = new ReconnectingWebSocketSource({
      name: "connecting-timeout-test",
      session: () => Promise.resolve({ url: "ws://connecting-timeout.test" }),
      normalize: () => [],
      reconnect: {
        ...RECONNECT,
        maximumAttempts: 1,
        connectionTimeoutMs: 25,
      },
      webSocketFactory: () => {
        const socket = new FakeConnection();
        if (sockets.length === 0) {
          socket.terminateWithDeferredError = true;
        } else {
          queueMicrotask(() => socket.open());
        }
        sockets.push(socket);
        return socket as unknown as WebSocketConnection;
      },
      sleep: () => Promise.resolve(),
      onError: vi.fn(),
    });

    try {
      const started = source.start(() => undefined);
      await settleMicrotasks();
      expect(sockets).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(25);
      await expect(started).resolves.toBeUndefined();
      expect(sockets).toHaveLength(2);
      expect(sockets[0]!.listenerCount("error")).toBe(0);
      expect(sockets[0]!.listenerCount("close")).toBe(0);
    } finally {
      await source.dispose();
    }
  });

  it("closes with status 1009 when pre-acknowledgement payload bytes overflow", async () => {
    installFakeAbortController();
    const sockets: FakeConnection[] = [];
    const onError = vi.fn();
    const acknowledgement = vi.fn(() => false);
    const payload = { type: "pending", content: "x".repeat(32) };
    const frameBytes = Buffer.byteLength(JSON.stringify(payload));
    const source = new ReconnectingWebSocketSource({
      name: "pre-ack-overflow-test",
      session: () =>
        Promise.resolve({
          url: "ws://pre-ack-overflow.test",
          acknowledgement,
        }),
      normalize: () => [],
      reconnect: { ...RECONNECT, maximumAttempts: 0 },
      maximumQueuedFrames: 10,
      maximumQueuedBytes: frameBytes * 2 - 1,
      webSocketFactory: () => {
        const socket = new FakeConnection();
        sockets.push(socket);
        void Promise.resolve().then(() => socket.open());
        return socket as unknown as WebSocketConnection;
      },
      onError,
    });
    const startFailure = source.start(() => undefined).catch((error: unknown) => error);

    try {
      await settleMicrotasks();
      const socket = sockets[0]!;
      socket.receive(payload);
      await vi.waitFor(() => expect(acknowledgement).toHaveBeenCalledOnce());
      await settleMicrotasks();
      expect(socket.closeStatuses).toHaveLength(0);

      socket.receive(payload);
      await vi.waitFor(() =>
        expect(acknowledgement).toHaveBeenCalledTimes(2),
      );
      await vi.waitFor(() => expect(socket.closeStatuses).toHaveLength(1));

      const failure = (await startFailure) as Error;
      expect(failure.cause).toMatchObject({
        name: "PlatformConnectionError",
        message: expect.stringContaining(
          "pre-acknowledgement payload queue overflow",
        ),
      });
      expect(socket.closeStatuses[0]).toEqual({
        code: 1_009,
        reason: "Inbound message queue overflow",
      });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "PlatformConnectionError",
          message: expect.stringContaining("WebSocket status 1009"),
        }),
      );
    } finally {
      await source.dispose();
    }
  });

  it("closes, clears queued frames, and reconnects after a slow-handler flood", async () => {
    installFakeAbortController();
    const sockets: FakeConnection[] = [];
    const onError = vi.fn();
    const releaseHandler = Promise.withResolvers<void>();
    const event = {
      id: "slow-event",
      type: "comment",
      platform: "test",
      username: "viewer",
      content: "queued",
      timestamp: 0,
      metadata: {},
    } as const;
    let handled = 0;
    const source = new ReconnectingWebSocketSource({
      name: "handler-overflow-test",
      session: () =>
        Promise.resolve({
          url: "ws://handler-overflow.test",
          acknowledgement: isAcknowledgement,
        }),
      normalize: () => [event],
      reconnect: { ...RECONNECT, maximumAttempts: 1 },
      maximumQueuedFrames: 2,
      maximumQueuedBytes: 1_024,
      webSocketFactory: () => {
        const socket = new FakeConnection();
        sockets.push(socket);
        void Promise.resolve().then(() => {
          socket.open();
          socket.receiveAcknowledgement();
        });
        return socket as unknown as WebSocketConnection;
      },
      sleep: (_milliseconds, signal) =>
        signal.aborted
          ? Promise.reject(signal.reason)
          : Promise.resolve(),
      onError,
      random: () => 0.5,
      now: () => 0,
    });

    try {
      await source.start(async () => {
        handled += 1;
        await releaseHandler.promise;
      });
      const firstSocket = sockets[0]!;
      firstSocket.receive({ type: "event", id: 1 });
      await vi.waitFor(() => expect(handled).toBe(1));

      firstSocket.receive({ type: "event", id: 2 });
      firstSocket.receive({ type: "event", id: 3 });
      expect(firstSocket.closeStatuses).toEqual([
        { code: 1_009, reason: "Inbound message queue overflow" },
      ]);

      releaseHandler.resolve();
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "PlatformConnectionError",
            message: expect.stringContaining("inbound frame queue overflow"),
          }),
        ),
      );
      expect(handled).toBe(1);
    } finally {
      releaseHandler.resolve();
      await source.dispose();
    }
  });
});
