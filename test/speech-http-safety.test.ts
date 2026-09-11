import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_AUDIO_BYTES, fetchAudio } from "../src/speech/http.js";
import { readBoundedResponse } from "../src/speech/adapters/bounded-http.js";

async function collectAudio(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function audioResponse(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = { "content-type": "audio/wav" },
): Response {
  return new Response(body, { headers });
}

describe("speech HTTP transport bounds", () => {
  it("cancels on the first cumulative overflowing chunk despite a lying length", async () => {
    const chunks = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      new Uint8Array([9]),
    ];
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[pulls];
          pulls += 1;
          if (chunk === undefined) {
            controller.close();
          } else {
            controller.enqueue(chunk);
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const audio = await fetchAudio(
      async () =>
        audioResponse(body, {
          "content-type": "audio/wav",
          "content-length": "1",
        }),
      "Chunked TTS",
      new URL("https://speech.test/tts"),
      { method: "POST" },
      new AbortController().signal,
      "wav",
      7,
    );

    await expect(collectAudio(audio.stream)).rejects.toThrow(
      "7-byte download limit",
    );
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(body.locked).toBe(false);
  });

  it("fast-fails an oversized declared length without pulling the body", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([1]));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );

    await expect(
      fetchAudio(
        async () =>
          audioResponse(body, {
            "content-type": "audio/wav",
            "content-length": String(DEFAULT_MAX_AUDIO_BYTES + 1),
          }),
        "Declared TTS",
        new URL("https://speech.test/tts"),
        { method: "GET" },
        new AbortController().signal,
        "wav",
      ),
    ).rejects.toThrow(`${DEFAULT_MAX_AUDIO_BYTES}-byte download limit`);
    expect(pulls).toBe(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("aborts a stalled audio read and cancels and releases its reader", async () => {
    const started = Promise.withResolvers<void>();
    const never = Promise.withResolvers<void>().promise;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          started.resolve();
          return never;
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const audio = await fetchAudio(
      async () => audioResponse(body),
      "Stalled TTS",
      new URL("https://speech.test/tts"),
      { method: "GET" },
      controller.signal,
      "wav",
      32,
    );
    const pending = collectAudio(audio.stream);
    await started.promise;
    const reason = new Error("stop stalled speech");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(body.locked).toBe(false);
  });

  it("aborts a bounded JSON read stalled after response headers", async () => {
    const started = Promise.withResolvers<void>();
    const never = Promise.withResolvers<void>().promise;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          started.resolve();
          return never;
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const pending = readBoundedResponse(
      new Response(body, {
        headers: { "content-type": "application/json" },
      }),
      "Gradio upload",
      1024,
      controller.signal,
    );
    await started.promise;
    const reason = new Error("stop upload response");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(body.locked).toBe(false);
  });
});
