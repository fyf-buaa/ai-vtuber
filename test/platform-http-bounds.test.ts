import { describe, expect, it, vi } from "vitest";

import type { ReconnectOptions } from "../src/platforms/index.js";
import {
  PlatformConnectionError,
  YouTubeLiveChatSource,
} from "../src/platforms/index.js";
import { readJsonResponse } from "../src/platforms/utilities.js";

const JSON_RESPONSE_LIMIT = 1024 * 1024;
const RECONNECT: ReconnectOptions = {
  initialDelayMs: 1,
  maximumDelayMs: 2,
  maximumAttempts: 0,
  connectionTimeoutMs: 25,
  acknowledgementTimeoutMs: 100,
  stableConnectionMs: 1_000,
};

describe("bounded platform JSON responses", () => {
  it("reads a normal streamed JSON response", async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({ ok: true, message: "正常" }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 5));
        controller.enqueue(encoded.slice(5));
        controller.close();
      },
    });

    await expect(readJsonResponse(new Response(body))).resolves.toEqual({
      ok: true,
      message: "正常",
    });
  });

  it("cancels a never-ending chunked body after its actual bytes exceed the cap", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel,
    });
    const response = new Response(body);
    expect(response.headers.get("content-length")).toBeNull();

    await expect(readJsonResponse(response)).rejects.toThrow(
      `JSON response exceeds ${JSON_RESPONSE_LIMIT} bytes`,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThan(20);
  });

  it("does not trust a smaller Content-Length when the streamed body overflows", async () => {
    const chunk = new Uint8Array(512 * 1024);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel,
    });
    const response = new Response(body, {
      headers: { "content-length": "1" },
    });

    await expect(readJsonResponse(response)).rejects.toThrow(
      `JSON response exceeds ${JSON_RESPONSE_LIMIT} bytes`,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("YouTube request deadlines", () => {
  it("times out and cancels a body that stalls after headers", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: () => Promise.withResolvers<void>().promise,
      cancel,
    });
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        requestSignal = init?.signal ?? undefined;
        return new Response(body, { status: 200 });
      },
    );
    const source = new YouTubeLiveChatSource(
      {
        apiKey: "key",
        liveChatId: "chat-1",
        reconnect: RECONNECT,
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    const startFailure = source.start(() => undefined).catch((error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(RECONNECT.connectionTimeoutMs);
      const failure = await startFailure;
      expect(failure).toBeInstanceOf(PlatformConnectionError);
      expect((failure as Error).cause).toMatchObject({
        name: "TimeoutError",
        message: `YouTube request timed out after ${RECONNECT.connectionTimeoutMs} ms`,
      });
      expect(requestSignal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      await source.dispose();
      vi.useRealTimers();
    }
  });

  it("promptly cancels a stalled body when the lifecycle is aborted", async () => {
    const lifecycle = new AbortController();
    const requestStarted = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: () => Promise.withResolvers<void>().promise,
      cancel,
    });
    const fetchMock = vi.fn(async (): Promise<Response> => {
      requestStarted.resolve();
      return new Response(body, { status: 200 });
    });
    const source = new YouTubeLiveChatSource(
      {
        apiKey: "key",
        liveChatId: "chat-1",
        reconnect: { ...RECONNECT, connectionTimeoutMs: 60_000 },
      },
      {
        fetch: fetchMock as unknown as typeof fetch,
        signal: lifecycle.signal,
      },
    );
    const startFailure = source.start(() => undefined).catch((error: unknown) => error);

    try {
      await requestStarted.promise;
      await Promise.resolve();
      const reason = new DOMException("stop requested", "AbortError");
      lifecycle.abort(reason);
      const failure = await startFailure;
      expect(failure).toBeInstanceOf(PlatformConnectionError);
      expect((failure as Error).cause).toBe(reason);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      lifecycle.abort();
      await source.dispose();
    }
  });
});
