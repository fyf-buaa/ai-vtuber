import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const originalReferenceRoots = vi.hoisted(() => {
  const value = process.env.AI_VTUBER_REFERENCE_AUDIO_ROOTS;
  delete process.env.AI_VTUBER_REFERENCE_AUDIO_ROOTS;
  return value;
});
import { GradioQueueClient } from "../src/speech/adapters/gradio.js";
import {
  MAX_REFERENCE_FILE_BYTES,
  loadReferenceFile,
} from "../src/speech/reference-files.js";
import type { SpeechFetch, SynthesizedAudio } from "../src/speech/types.js";

function wavBytes(payloadBytes = 0): Buffer {
  const bytes = Buffer.alloc(12 + payloadBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  return bytes;
}

async function collectAudio(audio: SynthesizedAudio): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of audio.stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

afterAll(() => {
  if (originalReferenceRoots === undefined) {
    delete process.env.AI_VTUBER_REFERENCE_AUDIO_ROOTS;
  } else {
    process.env.AI_VTUBER_REFERENCE_AUDIO_ROOTS = originalReferenceRoots;
  }
});

describe("speech reference-file confinement", () => {
  let fixtureRoot: string;
  let cwd: string;
  let outside: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "speech-reference-"));
    cwd = join(fixtureRoot, "app");
    outside = join(fixtureRoot, "outside");
    await Promise.all([
      mkdir(join(cwd, "data"), { recursive: true }),
      mkdir(join(cwd, "models"), { recursive: true }),
      mkdir(join(cwd, "out"), { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("loads valid audio from each canonical project media root", async () => {
    for (const root of ["data", "models", "out"] as const) {
      const path = join(cwd, root, `${root}.wav`);
      const expected = wavBytes(root.length);
      await writeFile(path, expected);
      const loaded = await loadReferenceFile({
        configuredPath: join(root, `${root}.wav`),
        cwd,
        label: `${root} reference`,
        signal: new AbortController().signal,
      });

      expect(loaded.path).toBe(await realpath(path));
      expect(loaded.contentType).toBe("audio/wav");
      expect(loaded.data).toEqual(expected);
    }
  });

  it("refuses an absolute file outside the approved roots", async () => {
    const path = join(outside, "secret.wav");
    await writeFile(path, wavBytes());

    await expect(
      loadReferenceFile({
        configuredPath: path,
        cwd,
        label: "outside reference",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("outside the approved media roots");
  });

  it("refuses a symlinked-directory escape before reading it", async () => {
    const target = join(outside, "secret.wav");
    const link = join(cwd, "data", "escape");
    await writeFile(target, wavBytes());
    await symlink(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      loadReferenceFile({
        configuredPath: join(link, "secret.wav"),
        cwd,
        label: "symlink reference",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("outside the approved media roots");
  });

  it("refuses oversized, non-regular, and non-audio inputs", async () => {
    const oversized = join(cwd, "data", "oversized.wav");
    const wrongExtension = join(cwd, "models", "voice.txt");
    const wrongSignature = join(cwd, "out", "fake.wav");
    await Promise.all([
      writeFile(oversized, wavBytes(1)),
      writeFile(wrongExtension, wavBytes()),
      writeFile(wrongSignature, "not audio"),
    ]);
    const signal = new AbortController().signal;

    await expect(
      loadReferenceFile({
        configuredPath: oversized,
        cwd,
        label: "oversized reference",
        signal,
        maximumBytes: 12,
      }),
    ).rejects.toThrow("12-byte reference-file size limit");
    await expect(
      loadReferenceFile({
        configuredPath: join(cwd, "data"),
        cwd,
        label: "special reference",
        signal,
      }),
    ).rejects.toThrow("not a safe regular file");
    await expect(
      loadReferenceFile({
        configuredPath: wrongExtension,
        cwd,
        label: "extension reference",
        signal,
      }),
    ).rejects.toThrow("supported audio file");
    await expect(
      loadReferenceFile({
        configuredPath: wrongSignature,
        cwd,
        label: "signature reference",
        signal,
      }),
    ).rejects.toThrow("supported audio file");
  });

  it("rejects reference limits above the immutable hard cap", async () => {
    const path = join(cwd, "data", "voice.wav");
    await writeFile(path, wavBytes());

    await expect(
      loadReferenceFile({
        configuredPath: path,
        cwd,
        label: "hard-cap reference",
        signal: new AbortController().signal,
        maximumBytes: MAX_REFERENCE_FILE_BYTES + 1,
      }),
    ).rejects.toThrow(`no greater than ${MAX_REFERENCE_FILE_BYTES} bytes`);
  });

  it("honors cancellation before opening a reference file", async () => {
    const path = join(cwd, "data", "voice.wav");
    await writeFile(path, wavBytes());
    const controller = new AbortController();
    const reason = new Error("stop reference read");
    controller.abort(reason);

    await expect(
      loadReferenceFile({
        configuredPath: path,
        cwd,
        label: "cancelled reference",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("uploads the validated canonical audio bytes through Gradio", async () => {
    const expected = wavBytes(4);
    await writeFile(join(cwd, "data", "prompt.wav"), expected);
    const bodies: FormData[] = [];
    const fetchImpl: SpeechFetch = async (_input, init) => {
      if (!(init?.body instanceof FormData)) {
        throw new Error("Expected Gradio multipart upload");
      }
      bodies.push(init.body);
      return new Response(JSON.stringify(["remote/prompt.wav"]), {
        headers: { "content-type": "application/json" },
      });
    };
    const client = new GradioQueueClient({
      apiBase: "https://gradio.test/",
      fetch: fetchImpl,
      timeoutMs: 5_000,
    });

    const result = await client.uploadFile(
      "data/prompt.wav",
      cwd,
      new AbortController().signal,
    );
    const uploaded = bodies.at(-1)?.get("files");
    expect(uploaded).toBeInstanceOf(Blob);
    if (!(uploaded instanceof Blob)) {
      throw new Error("Expected uploaded Blob");
    }
    expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(expected);
    expect(result).toMatchObject({
      orig_name: "prompt.wav",
      size: expected.byteLength,
      mime_type: "audio/wav",
    });
  });
});
