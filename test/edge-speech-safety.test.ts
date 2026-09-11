import { describe, expect, it } from "vitest";
import {
  EdgeSpeechSynthesizer,
  listEdgeVoices,
  type EdgeSocket,
  type EdgeWebSocketFactory,
} from "../src/speech/adapters/edge.js";
import { DEFAULT_MAX_AUDIO_BYTES } from "../src/speech/http.js";
import type { SynthesizedAudio } from "../src/speech/types.js";

type SocketListener = (...args: unknown[]) => void;

class FakeEdgeSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, SocketListener[]>();
  terminated = false;

  once(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener as SocketListener);
    this.#listeners.set(event, listeners);
    return this;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener as SocketListener);
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      return this;
    }
    const index = listeners.indexOf(listener as SocketListener);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  terminate(): void {
    this.terminated = true;
    queueMicrotask(() => {
      this.emit("error", new Error("socket terminated while connecting"));
      this.emit("close", 1_006, Buffer.from("terminated"));
    });
  }

  removeAllListeners(): this {
    this.#listeners.clear();
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    const listeners = [...(this.#listeners.get(event) ?? [])];
    if (event === "error" && listeners.length === 0) {
      throw args[0];
    }
    for (const listener of listeners) {
      listener(...args);
    }
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.#listeners.values()) {
      count += listeners.length;
    }
    return count;
  }
}

interface SocketRecord {
  readonly socket: FakeEdgeSocket;
  readonly url: URL;
  readonly options: Parameters<EdgeWebSocketFactory>[1];
}

function edgeFixture(): {
  readonly synthesizer: EdgeSpeechSynthesizer;
  readonly sockets: SocketRecord[];
} {
  const sockets: SocketRecord[] = [];
  const factory: EdgeWebSocketFactory = (url, options) => {
    const socket = new FakeEdgeSocket();
    sockets.push({ socket, url, options });
    return socket as unknown as EdgeSocket;
  };
  return {
    synthesizer: new EdgeSpeechSynthesizer(
      {
        voice: "zh-CN-XiaoyiNeural",
        rate: "+0%",
        volume: "+0%",
        endpoint: "wss://edge.test/synthesize",
      },
      factory,
    ),
    sockets,
  };
}

async function requiredAudio(
  synthesizer: EdgeSpeechSynthesizer,
  text: string,
  signal: AbortSignal,
): Promise<SynthesizedAudio> {
  const audio = await synthesizer.synthesize({ text }, signal);
  if (audio === undefined) {
    throw new Error("Expected Edge audio");
  }
  return audio;
}

function emitAudio(socket: FakeEdgeSocket, bodyBytes: number, fill: number): void {
  const headers = Buffer.from("Path:audio\r\n", "ascii");
  const bodyOffset = headers.byteLength + 2;
  const frame = Buffer.allocUnsafe(bodyOffset + bodyBytes);
  frame.writeUInt16BE(headers.byteLength, 0);
  headers.copy(frame, 2);
  frame.fill(fill, bodyOffset);
  socket.emit("message", frame, true);
}

function emitTurnEnd(socket: FakeEdgeSocket): void {
  socket.emit("message", Buffer.from("Path:turn.end\r\n\r\n"), false);
}

describe("Edge voice catalog", () => {
  it("fetches, validates, deduplicates, and sorts the current Edge voice list", async () => {
    const voices = await listEdgeVoices({
      now: () => 1_750_000_000_000,
      fetch: async (input, init) => {
        const url = new URL(input);
        expect(url.protocol).toBe("https:");
        expect(url.searchParams.get("trustedclienttoken")).toMatch(/^[A-F0-9]+$/u);
        expect(url.searchParams.get("Sec-MS-GEC")).toMatch(/^[A-F0-9]{64}$/u);
        expect(url.searchParams.get("Sec-MS-GEC-Version")).toMatch(/^1-/u);
        expect(new Headers(init?.headers).get("cookie")).toMatch(/^muid=[A-F0-9]{32};$/u);
        return new Response(JSON.stringify([
          {
            Name: "Microsoft Voice B",
            ShortName: "zh-CN-XiaoyiNeural",
            Gender: "Female",
            Locale: "zh-CN",
            LocaleName: "Chinese (Mainland)",
            FriendlyName: "Microsoft Xiaoyi Online (Natural) - Chinese (Mainland)",
          },
          {
            Name: "Microsoft Voice A",
            ShortName: "en-US-AvaNeural",
            Gender: "Female",
            Locale: "en-US",
            LocaleName: "English (United States)",
            FriendlyName: "Microsoft Ava Online (Natural) - English (United States)",
          },
          {
            Name: "Duplicate",
            ShortName: "zh-CN-XiaoyiNeural",
            Gender: "Female",
            Locale: "zh-CN",
            LocaleName: "Chinese (Mainland)",
            FriendlyName: "Duplicate Xiaoyi",
          },
          { ShortName: "invalid" },
        ]), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(voices).toEqual([
      {
        name: "Microsoft Voice A",
        shortName: "en-US-AvaNeural",
        gender: "Female",
        locale: "en-US",
        localeName: "English (United States)",
        friendlyName: "Microsoft Ava Online (Natural) - English (United States)",
      },
      {
        name: "Microsoft Voice B",
        shortName: "zh-CN-XiaoyiNeural",
        gender: "Female",
        locale: "zh-CN",
        localeName: "Chinese (Mainland)",
        friendlyName: "Microsoft Xiaoyi Online (Natural) - Chinese (Mainland)",
      },
    ]);
    expect(Object.isFrozen(voices)).toBe(true);
    expect(voices.every(Object.isFrozen)).toBe(true);
  });
});

describe("Edge speech transport bounds", () => {
  it("sets a finite WebSocket payload cap and releases a completed socket", async () => {
    const fixture = edgeFixture();
    const audio = await requiredAudio(
      fixture.synthesizer,
      "hello & goodbye",
      new AbortController().signal,
    );
    const iterator = audio.stream[Symbol.asyncIterator]();
    const first = iterator.next();
    await Promise.resolve();

    expect(fixture.sockets).toHaveLength(1);
    const record = fixture.sockets[0];
    if (record === undefined) {
      throw new Error("Expected Edge socket");
    }
    expect(record.options.maxPayload).toBe(DEFAULT_MAX_AUDIO_BYTES);
    expect(Number.isFinite(record.options.maxPayload ?? Number.NaN)).toBe(true);
    expect(record.url.searchParams.get("TrustedClientToken")).not.toBeNull();
    expect(record.url.searchParams.get("ConnectionId")).toMatch(/^[a-f0-9]{32}$/u);

    record.socket.emit("open");
    expect(record.socket.sent).toHaveLength(2);
    expect(record.socket.sent[0]).toContain("Path:speech.config");
    expect(record.socket.sent[1]).toContain("hello &amp; goodbye");
    emitAudio(record.socket, 2, 0x11);
    emitAudio(record.socket, 3, 0x22);
    emitTurnEnd(record.socket);

    await expect(first).resolves.toMatchObject({
      done: false,
      value: Buffer.from([0x11, 0x11]),
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: Buffer.from([0x22, 0x22, 0x22]),
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(record.socket.terminated).toBe(true);
    expect(record.socket.listenerCount()).toBe(0);
  });

  it("carries one aggregate budget across frames and split text parts", async () => {
    const fixture = edgeFixture();
    const audio = await requiredAudio(
      fixture.synthesizer,
      "x".repeat(12_001),
      new AbortController().signal,
    );
    const iterator = audio.stream[Symbol.asyncIterator]();
    const first = iterator.next();
    await Promise.resolve();
    const firstRecord = fixture.sockets[0];
    if (firstRecord === undefined) {
      throw new Error("Expected first Edge socket");
    }

    firstRecord.socket.emit("open");
    const firstFrameBytes = 64 * 1024;
    emitAudio(firstRecord.socket, firstFrameBytes, 0x31);
    emitAudio(firstRecord.socket, firstFrameBytes, 0x32);
    emitTurnEnd(firstRecord.socket);
    await expect(first).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).resolves.toMatchObject({ done: false });

    const overflow = iterator.next();
    await Promise.resolve();
    expect(fixture.sockets).toHaveLength(2);
    const secondRecord = fixture.sockets[1];
    if (secondRecord === undefined) {
      throw new Error("Expected second Edge socket");
    }
    secondRecord.socket.emit("open");
    emitAudio(
      secondRecord.socket,
      DEFAULT_MAX_AUDIO_BYTES - firstFrameBytes * 2 + 1,
      0x41,
    );

    await expect(overflow).rejects.toThrow(
      `${DEFAULT_MAX_AUDIO_BYTES}-byte download limit`,
    );
    expect(firstRecord.socket.terminated).toBe(true);
    expect(firstRecord.socket.listenerCount()).toBe(0);
    expect(secondRecord.socket.terminated).toBe(true);
    expect(secondRecord.socket.listenerCount()).toBe(0);
  });

  it("keeps the error listener through handshake abort and releases it after termination", async () => {
    const fixture = edgeFixture();
    const controller = new AbortController();
    const audio = await requiredAudio(
      fixture.synthesizer,
      "cancel me",
      controller.signal,
    );
    const pending = audio.stream[Symbol.asyncIterator]().next();
    await Promise.resolve();
    const record = fixture.sockets[0];
    if (record === undefined) {
      throw new Error("Expected Edge socket");
    }
    const reason = new Error("stop Edge speech");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(record.socket.terminated).toBe(true);
    expect(record.socket.listenerCount()).toBe(0);
  });
});
