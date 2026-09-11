import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/config/config-store.js";
import {
  GradioQueueClient,
  createSpeechSynthesizer,
  type GradioSocket,
  type SpeechFetch,
  type SpeechSynthesizer,
  type SynthesizedAudio,
} from "../src/speech/index.js";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function playableConfig(
  engine: string,
  sectionName: string,
  section: JsonObject,
): JsonObject {
  return {
    audio_synthesis_type: engine,
    play_audio: { enable: true, player: "ffplay", out_path: "out" },
    [sectionName]: section,
  };
}

function gptSovitsConfig(overrides: JsonObject = {}): JsonObject {
  return playableConfig("gpt_sovits", "gpt_sovits", {
    type: "api",
    api_ip_port: "http://127.0.0.1:9880",
    ref_audio_path: "reference.wav",
    prompt_text: "prompt",
    prompt_language: "中文",
    language: "中文",
    ...overrides,
  });
}

function audioResponse(
  bytes = "audio",
  headers: Record<string, string> = { "content-type": "audio/wav" },
): Response {
  return new Response(new TextEncoder().encode(bytes), { status: 200, headers });
}

function openBodyResponse(
  initialBody: string,
  init: ResponseInit,
  onCancel: () => void,
): Response {
  const bytes = new TextEncoder().encode(initialBody);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        onCancel();
      },
    }),
    init,
  );
}

function jsonBody(call: FetchCall): Record<string, unknown> {
  if (typeof call.init?.body !== "string") {
    throw new Error("Expected a JSON string request body");
  }
  const parsed = JSON.parse(call.init.body) as unknown;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Expected a JSON object request body");
  }
  return parsed as Record<string, unknown>;
}

async function requiredAudio(
  synthesizer: SpeechSynthesizer,
  text = "兼容测试",
  signal = new AbortController().signal,
): Promise<SynthesizedAudio> {
  const audio = await synthesizer.synthesize({ text }, signal);
  if (audio === undefined) {
    throw new Error("Expected synthesized audio");
  }
  return audio;
}

async function collectAudio(audio: SynthesizedAudio): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of audio.stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

class FakeSocket {
  readonly sent: string[] = [];
  terminated = false;
  closed = false;
  readonly #handlers = new Map<string, (...args: unknown[]) => void>();

  once(event: string, listener: (...args: never[]) => void): this {
    this.#handlers.set(event, listener as (...args: unknown[]) => void);
    return this;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    this.#handlers.set(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off(event: string, listener: (...args: never[]) => void): this {
    if (this.#handlers.get(event) === listener) {
      this.#handlers.delete(event);
    }
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.#handlers.get("close")?.(1_000, Buffer.alloc(0));
  }

  terminate(): void {
    this.terminated = true;
    this.#handlers.get("close")?.(1_006, Buffer.from("terminated"));
  }

  removeAllListeners(): this {
    this.#handlers.clear();
    return this;
  }

  emitMessage(message: unknown): void {
    this.#handlers.get("message")?.(Buffer.from(JSON.stringify(message)), false);
  }
}

describe("legacy speech REST compatibility", () => {
  it("preserves the GPT-SoVITS v2 REST route and payload", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: SpeechFetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return audioResponse("gpt");
    };
    const synthesizer = createSpeechSynthesizer(
      playableConfig("gpt_sovits", "gpt_sovits", {
        type: "v2_api_0821",
        api_ip_port: "http://127.0.0.1:9880",
        v2_api_0821: {
          text_lang: "zh",
          ref_audio_path: "reference.wav",
          aux_ref_audio_paths: [],
          prompt_text: "参考文本",
          prompt_lang: "zh",
          top_k: 5,
          top_p: 1,
          temperature: 1,
          text_split_method: "cut0",
          batch_size: 1,
          split_bucket: true,
          speed_factor: 1,
          fragment_interval: 0.3,
          seed: -1,
          media_type: "wav",
          streaming_mode: false,
          parallel_infer: true,
          repetition_penalty: 1.35,
        },
      }),
      process.cwd(),
      fetchImpl,
    );

    await collectAudio(await requiredAudio(synthesizer, "新的台词"));
    expect(calls[0]?.url).toBe("http://127.0.0.1:9880/tts");
    expect(jsonBody(calls[0] as FetchCall)).toMatchObject({
      text: "新的台词",
      text_lang: "zh",
      ref_audio_path: "reference.wav",
      prompt_text: "参考文本",
      media_type: "wav",
      repetition_penalty: 1.35,
    });
  });

  it("propagates cancellation into the injected HTTP transport", async () => {
    let transportSignal: AbortSignal | undefined;
    const fetchImpl: SpeechFetch = async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("Missing transport abort signal");
      }
      transportSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      });
    };
    const synthesizer = createSpeechSynthesizer(
      gptSovitsConfig(),
      process.cwd(),
      fetchImpl,
    );
    const controller = new AbortController();
    const synthesis = requiredAudio(synthesizer, "cancel me", controller.signal);
    const reason = new Error("caller cancelled");
    controller.abort(reason);

    await expect(synthesis).rejects.toBe(reason);
    expect(transportSignal?.aborted).toBe(true);
  });

  it("rejects non-2xx synthesis responses with status context", async () => {
    const synthesizer = createSpeechSynthesizer(
      gptSovitsConfig(),
      process.cwd(),
      async () =>
        new Response('{"detail":"offline"}', {
          status: 503,
          statusText: "Unavailable",
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(requiredAudio(synthesizer)).rejects.toThrow(
      "HTTP 503 Unavailable",
    );
  });

  it("bounds a never-ending compatibility error body by its adapter timeout", async () => {
    let bodyCancelled = false;
    const synthesizer = createSpeechSynthesizer(
      gptSovitsConfig({ timeout_ms: 50 }),
      process.cwd(),
      async () =>
        openBodyResponse(
          '{"detail":"still streaming"}',
          {
            status: 503,
            statusText: "Unavailable",
            headers: { "content-type": "application/json" },
          },
          () => {
            bodyCancelled = true;
          },
        ),
    );

    const outcome: unknown = await requiredAudio(synthesizer).catch(
      (error: unknown) => error,
    );
    if (!(outcome instanceof Error)) {
      throw new Error("Expected the compatibility adapter to time out");
    }
    expect(outcome.name).toBe("TimeoutError");
    expect(bodyCancelled).toBe(true);
  });

  it("caps and cancels an oversized compatibility content-type error body", async () => {
    let bodyCancelled = false;
    const synthesizer = createSpeechSynthesizer(
      gptSovitsConfig({ timeout_ms: 1_000 }),
      process.cwd(),
      async () =>
        openBodyResponse(
          `diagnostic-start ${"x".repeat(700)} diagnostic-tail`,
          {
            status: 200,
            headers: { "content-type": "text/plain" },
          },
          () => {
            bodyCancelled = true;
          },
        ),
    );

    const outcome: unknown = await requiredAudio(synthesizer).catch(
      (error: unknown) => error,
    );
    if (!(outcome instanceof Error)) {
      throw new Error("Expected the compatibility adapter to reject");
    }
    expect(outcome.message).toContain("returned text/plain instead of audio");
    expect(outcome.message).toContain("diagnostic-start");
    expect(outcome.message).not.toContain("diagnostic-tail");
    expect(bodyCancelled).toBe(true);
  });

  it("stops a streamed download when it exceeds the configured cap", async () => {
    const synthesizer = createSpeechSynthesizer(
      gptSovitsConfig({ max_download_bytes: 4 }),
      process.cwd(),
      async () =>
        audioResponse("too large", {
          "content-type": "audio/wav",
        }),
    );

    const audio = await requiredAudio(synthesizer);
    await expect(collectAudio(audio)).rejects.toThrow("4-byte download limit");
  });
});

describe("Gradio compatibility transport", () => {
  it("handles legacy queue events, sends the session hash/data, and downloads only the returned URL", async () => {
    const socket = new FakeSocket();
    const downloads: string[] = [];
    const client = new GradioQueueClient({
      apiBase: "https://gradio.test/space/",
      fetch: async (input) => {
        downloads.push(String(input));
        return audioResponse("gradio");
      },
      webSocketFactory: (url) => {
        expect(url.href).toBe("wss://gradio.test/space/queue/join");
        return socket as unknown as GradioSocket;
      },
      sessionHashFactory: () => "session-fixed",
      timeoutMs: 5_000,
      maxDownloadBytes: 1024,
    });

    const prediction = client.predictAudio(
      { data: ["hello", "speaker"], fnIndex: 3 },
      new AbortController().signal,
    );
    socket.emitMessage({ msg: "send_hash" });
    socket.emitMessage({ msg: "send_data" });
    socket.emitMessage({
      msg: "process_completed",
      success: true,
      output: {
        data: [
          {
            url: "https://gradio.test/space/file=audio.wav",
            orig_name: "audio.wav",
          },
        ],
      },
    });

    const audio = await prediction;
    expect((await collectAudio(audio)).toString()).toBe("gradio");
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { session_hash: "session-fixed", fn_index: 3 },
      {
        data: ["hello", "speaker"],
        event_data: null,
        fn_index: 3,
        session_hash: "session-fixed",
      },
    ]);
    expect(downloads).toEqual([
      "https://gradio.test/space/file=audio.wav",
    ]);
    expect(socket.closed).toBe(true);
  });

  it("terminates an in-flight queue socket when aborted", async () => {
    const socket = new FakeSocket();
    const client = new GradioQueueClient({
      apiBase: "http://127.0.0.1:7860",
      fetch: async () => {
        throw new Error("download must not start");
      },
      webSocketFactory: () => socket as unknown as GradioSocket,
      timeoutMs: 5_000,
    });
    const controller = new AbortController();
    const prediction = client.predictAudio(
      { data: ["cancel"], fnIndex: 0 },
      controller.signal,
    );
    const reason = new Error("stop Gradio");
    controller.abort(reason);

    await expect(prediction).rejects.toBe(reason);
    expect(socket.terminated).toBe(true);
  });

  it("rejects a real HTTP 403 WebSocket handshake without leaving a later socket error unhandled", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { connection: "close" });
      response.end("forbidden");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }
    const client = new GradioQueueClient({
      apiBase: `http://127.0.0.1:${address.port}`,
      timeoutMs: 5_000,
    });

    try {
      await expect(
        client.predictAudio(
          { data: ["forbidden"], fnIndex: 0 },
          new AbortController().signal,
        ),
      ).rejects.toThrow("WebSocket handshake failed with HTTP 403");
      await new Promise<void>(setImmediate);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});

describe("legacy engine selection", () => {
  it("resolves the retained GPT-SoVITS alias", () => {
    const synthesizer = createSpeechSynthesizer(
      playableConfig("gpt-sovits", "gpt_sovits", {
        type: "api",
        api_ip_port: "http://127.0.0.1:9880",
        ref_audio_path: "reference.wav",
        prompt_text: "prompt",
        prompt_language: "中文",
        language: "中文",
      }),
      process.cwd(),
    );
    expect(synthesizer.name).toBe("gpt_sovits");
  });
});
