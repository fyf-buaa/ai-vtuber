import { mkdir, mkdtemp, readFile as readDiskFile, rm, symlink, writeFile as writeDiskFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEvent, EventPublisher, SpeechRequest } from "../src/domain/types.js";
import type {
  AudioArtifact,
  AudioSink,
  SpeechAudioContext,
} from "../src/speech/types.js";
import {
  CaptionSubscriber,
  CoordinationCallbackBridge,
  CoordinationCallbackSubscriber,
  DdspSvcPostProcessor,
  EasyAiVtuberBridge,
  ExternalVisualAudioSink,
  FileCaptionBridge,
  MirroredAudioSink,
  Live2dStaticServer,
  OutputBridgeError,
  PlaybackStatusSubscriber,
  ReplyForwardingSubscriber,
  SoVitsSvcPostProcessor,
  VirtualMicrophoneAudioSink,
  createLegacyOutputAdapters,
  createSvcPostProcessorsFromConfig,
  createVisualBodyBridgeFromConfig,
  resolveVirtualMicrophoneAudioSinkSettings,
  parsePlaybackCallback,
  requestBytes,
  subscribeOutputSubscribers,
  type AudioOutputBridge,
  type CaptionBridge,
  type CaptionUpdate,
  type OutputFetch,
  type OutputFileInfo,
  type OutputFileSystem,
  type OutputTextMessage,
  type TextOutputBridge,
} from "../src/output/index.js";

class MemoryFileSystem implements OutputFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();
  readonly removed: string[] = [];

  constructor() {
    this.directories.add(resolve("."));
  }

  seed(path: string, data: Uint8Array): void {
    const absolute = resolve(path);
    this.files.set(absolute, data.slice());
    this.directories.add(dirname(absolute));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(resolve(path));
    if (value === undefined) throw new Error("ENOENT");
    return value.slice();
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    options?: Readonly<{ exclusive?: boolean }>,
  ): Promise<void> {
    const absolute = resolve(path);
    if (options?.exclusive === true && this.files.has(absolute)) throw new Error("EEXIST");
    this.files.set(absolute, data.slice());
    this.directories.add(dirname(absolute));
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(resolve(path));
  }

  async rename(from: string, to: string): Promise<void> {
    const source = resolve(from);
    const value = this.files.get(source);
    if (value === undefined) throw new Error("ENOENT");
    this.files.delete(source);
    this.files.set(resolve(to), value);
  }

  async remove(path: string): Promise<void> {
    const absolute = resolve(path);
    this.removed.push(absolute);
    this.files.delete(absolute);
  }

  async stat(path: string): Promise<OutputFileInfo> {
    const absolute = resolve(path);
    const file = this.files.get(absolute);
    if (file !== undefined) {
      return { isDirectory: () => false, isFile: () => true, size: file.byteLength };
    }
    if (this.directories.has(absolute)) {
      return { isDirectory: () => true, isFile: () => false, size: 0 };
    }
    throw new Error("ENOENT");
  }

  async realpath(path: string): Promise<string> {
    const absolute = resolve(path);
    if (!this.files.has(absolute) && !this.directories.has(absolute)) throw new Error("ENOENT");
    return absolute;
  }
}


const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

function jsonResponse(body: Readonly<Record<string, unknown>>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function audioResponse(bytes: readonly number[], status = 200): Response {
  return new Response(new Uint8Array(bytes), {
    status,
    headers: { "content-type": "audio/wav" },
  });
}

function speechContext(id = "speech-1"): SpeechAudioContext {
  return {
    speechId: id,
    source: "synthesized",
    request: { text: "你好", sourceEventId: "event-1" },
  };
}

function artifact(path = resolve("out/source.wav")): AudioArtifact {
  return { path, format: "wav", temporary: true };
}

function inboundComment(content = "你好"): Extract<AppEvent, { type: "inbound" }> {
  return {
    type: "inbound",
    timestamp: 100,
    event: {
      id: "event-1",
      type: "comment",
      platform: "talk",
      username: "用户1!",
      content,
      timestamp: 100,
      metadata: {},
    },
  };
}

function inboundImage(
  id: string,
  metadata: Readonly<Record<string, unknown>> = {},
): Extract<AppEvent, { type: "inbound" }> {
  return {
    type: "inbound",
    timestamp: 100,
    event: {
      id,
      type: "image",
      platform: "image-generator",
      username: "system",
      content: `prompt for ${id}`,
      timestamp: 100,
      metadata,
    },
  };
}

function agentCompleted(content = "回答"): Extract<AppEvent, { type: "agent.completed" }> {
  return {
    type: "agent.completed",
    timestamp: 200,
    request: {
      sessionId: "talk:用户",
      username: "用户",
      content: "问题",
      metadata: { sourceEventType: "comment", sourceEventId: "event-1" },
    },
    response: { text: content, model: "test", provider: "test" },
  };
}

describe("visual output payload families", () => {
  it("sends the EasyAIVtuber audio payload", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch: OutputFetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ code: 200, status: "ok", message: "accepted" });
    };
    const audio = artifact();

    await new EasyAiVtuberBridge(
      { enabled: true, apiBaseUrl: "http://127.0.0.1:7888" },
      { fetch },
    ).sendAudio(audio, speechContext());

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/alive");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      type: "speak",
      speech_path: audio.path,
    });
  });

  it("sends redacted generic callback JSON payloads", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetch: OutputFetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return jsonResponse({ code: 200, status: "ok", message: "accepted" });
    };
    await new CoordinationCallbackBridge(
      { enabled: true, apiBaseUrl: "http://127.0.0.1:8082", endpointPath: "callback" },
      { fetch, clock: () => 500 },
    ).send({ type: "custom", data: { value: 1, token: "must-not-forward" }, timestamp: 500 });

    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual(["/callback"]);
    expect(calls[0]?.body).toEqual({
      type: "custom",
      data: { value: 1, token: "[REDACTED]" },
      timestamp: 500,
    });
  });

  it("keeps coordination callbacks on their configured external endpoint", async () => {
    const urls: string[] = [];
    const adapters = createLegacyOutputAdapters({
      coordination_callback: {
        enable: true,
        api_ip_port: "http://coordination.example.test:8090",
        endpoint_path: "events",
      },
    }, {
      fetch: async (input) => {
        urls.push(String(input));
        return jsonResponse({ code: 200, message: "ok" });
      },
    });
    await adapters.coordinationCallback.send({
      type: "speech.completed",
      data: {},
      timestamp: 500,
    });
    expect(urls).toEqual(["http://coordination.example.test:8090/events"]);
  });


  it("maps only the supported external visual body", () => {
    const selected = createVisualBodyBridgeFromConfig({
      visual_body: "EasyAIVtuber",
      EasyAIVtuber: { api_ip_port: "http://localhost:2" },
    });
    expect(selected?.mode).toBe("audio");
    expect(selected?.bridge.name).toBe("EasyAIVtuber");
    expect(createVisualBodyBridgeFromConfig({ visual_body: "live2d" })).toBeUndefined();
    expect(createVisualBodyBridgeFromConfig({ visual_body: "其他" })).toBeUndefined();
  });

  it("keeps disabled bridges completely inert", async () => {
    const fetch = vi.fn<OutputFetch>();
    await new EasyAiVtuberBridge(
      { enabled: false, apiBaseUrl: "not a URL" },
      { fetch },
    ).sendAudio(artifact(), speechContext());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on non-2xx and publishes one redacted failure", async () => {
    const events: AppEvent[] = [];
    const publisher: EventPublisher = { publish: (event) => events.push(event) };
    const bridge = new EasyAiVtuberBridge({
      enabled: true,
      apiBaseUrl: "http://127.0.0.1:7888?token=top-secret",
    }, {
      publisher,
      clock: () => 123,
      fetch: async () => new Response("password=echoed-secret", { status: 503 }),
    });

    await expect(bridge.sendAudio(artifact(), speechContext()))
      .rejects.toMatchObject({ code: "OUTPUT_RESPONSE_INVALID", status: 503 });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain("top-secret");
    expect(JSON.stringify(events[0])).not.toContain("echoed-secret");
  });
});

describe("bounded output HTTP and visual audio cancellation", () => {
  it("rejects declared and chunked actual oversized response bodies without draining them", async () => {
    let declaredReads = 0;
    let declaredCancelled = false;
    const declaredBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        declaredReads += 1;
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        declaredCancelled = true;
      },
    }, { highWaterMark: 0 });

    await expect(requestBytes({
      component: "output.test",
      url: new URL("http://127.0.0.1/declared"),
      maxBodyBytes: 4,
      fetch: async () => new Response(declaredBody, {
        headers: {
          "content-length": "5",
          "content-type": "audio/wav",
        },
      }),
    })).rejects.toMatchObject({ code: "OUTPUT_RESPONSE_INVALID" });
    expect(declaredReads).toBe(0);
    expect(declaredCancelled).toBe(true);

    const chunks = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      new Uint8Array(1_024),
    ];
    let nextChunk = 0;
    let streamedCancelled = false;
    const chunkedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[nextChunk];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        nextChunk += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        streamedCancelled = true;
      },
    }, { highWaterMark: 0 });

    await expect(requestBytes({
      component: "output.test",
      url: new URL("http://127.0.0.1/chunked"),
      maxBodyBytes: 6,
      fetch: async () => new Response(chunkedBody, {
        headers: {
          "content-length": "2",
          "content-type": "audio/wav",
        },
      }),
    })).rejects.toMatchObject({ code: "OUTPUT_RESPONSE_INVALID" });
    expect(nextChunk).toBe(2);
    expect(streamedCancelled).toBe(true);
  });

  it("keeps the request timeout active through a headers-then-hanging response body", async () => {
    const readStarted = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        readStarted.resolve();
        return Promise.withResolvers<void>().promise;
      },
      cancel,
    }, { highWaterMark: 0 });
    const request = requestBytes({
      component: "output.test",
      url: new URL("http://127.0.0.1/body-timeout"),
      timeoutMs: 20,
      fetch: async () => new Response(body, {
        headers: { "content-type": "audio/wav" },
      }),
    }).catch((error: unknown) => error);

    await readStarted.promise;
    const failure = await request;
    expect(failure).toMatchObject({
      code: "OUTPUT_TIMEOUT",
      cause: { name: "TimeoutError" },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("promptly cancels a blocked response body when the caller aborts", async () => {
    const readStarted = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        readStarted.resolve();
        return Promise.withResolvers<void>().promise;
      },
      cancel,
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const request = requestBytes({
      component: "output.test",
      url: new URL("http://127.0.0.1/blocked"),
      signal: controller.signal,
      timeoutMs: 1_000,
      fetch: async () => new Response(body, {
        headers: { "content-type": "audio/wav" },
      }),
    }).catch((error: unknown) => error);

    await readStarted.promise;
    const reason = new Error("output request stopped");
    controller.abort(reason);
    const failure = await request;
    expect(failure).toMatchObject({ code: "OUTPUT_ABORTED" });
    expect((failure as Error).cause).toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  });

  for (const lifecycleMethod of ["stop", "dispose"] as const) {
    it(`${lifecycleMethod} aborts and awaits a blocked bridge before another play`, async () => {
      let bridgeCalls = 0;
      let firstSignal!: AbortSignal;
      let rejectFirst!: () => void;
      const bridge: AudioOutputBridge = {
        name: "blocking-bridge",
        enabled: true,
        async sendAudio(_artifact, _context, signal) {
          bridgeCalls += 1;
          if (bridgeCalls !== 1) {
            return;
          }
          if (signal === undefined) {
            throw new Error("expected bridge request signal");
          }
          firstSignal = signal;
          await new Promise<void>((_resolve, reject) => {
            rejectFirst = () => reject(new Error("bridge request settled after abort"));
          });
        },
      };
      const sink = new ExternalVisualAudioSink(bridge);
      const firstPlay = sink.play(
        artifact(),
        speechContext(),
        new AbortController().signal,
      );
      const firstOutcome = firstPlay.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

      const stopping = sink[lifecycleMethod]();
      let stoppingSettled = false;
      void stopping.then(
        () => { stoppingSettled = true; },
        () => { stoppingSettled = true; },
      );
      expect(firstSignal.aborted).toBe(true);
      await Promise.resolve();
      expect(stoppingSettled).toBe(false);
      await expect(sink.play(
        artifact(),
        speechContext("speech-overlap"),
        new AbortController().signal,
      )).rejects.toThrow("already has an active output request");
      expect(bridgeCalls).toBe(1);

      rejectFirst();
      await expect(stopping).resolves.toBeUndefined();
      expect(await firstOutcome).toMatchObject({ status: "rejected" });
      await sink.play(
        artifact(),
        speechContext("speech-next"),
        new AbortController().signal,
      );
      expect(bridgeCalls).toBe(2);
    });
  }
});

describe("virtual microphone audio output", () => {
  it("resolves an enabled mpv device and keeps disabled configuration inert", () => {
    expect(resolveVirtualMicrophoneAudioSinkSettings({
      virtual_microphone: {
        enable: false,
        device: "",
      },
    })).toBeUndefined();

    expect(resolveVirtualMicrophoneAudioSinkSettings({
      play_audio: { enable: true },
      virtual_microphone: {
        enable: true,
        device: "wasapi/CABLE Input",
      },
    })).toEqual({
      device: "wasapi/CABLE Input",
      executable: "mpv",
      args: [
        "--no-config",
        "--no-video",
        "--really-quiet",
        "--audio-device=wasapi/CABLE Input",
        "--",
        "{audio}",
      ],
    });

    const adapters = createLegacyOutputAdapters({
      virtual_microphone: {
        enable: true,
        device: "wasapi/CABLE Input",
      },
    });
    expect(adapters.virtualMicrophone).toBeInstanceOf(
      VirtualMicrophoneAudioSink,
    );
  });

  it("rejects enabled configuration that cannot target a virtual device", () => {
    expect(() => resolveVirtualMicrophoneAudioSinkSettings({
      virtual_microphone: { enable: true, device: "" },
    })).toThrow("virtual_microphone.device must be a non-empty string");
    expect(() => resolveVirtualMicrophoneAudioSinkSettings({
      play_audio: { enable: false },
      virtual_microphone: { enable: true, device: "cable" },
    })).toThrow("virtual_microphone.enable requires play_audio.enable");
    expect(() => resolveVirtualMicrophoneAudioSinkSettings({
      virtual_microphone: {
        enable: true,
        device: "cable",
        args: ["--audio-device={device}", "speech.wav"],
      },
    })).toThrow("virtual_microphone.args must contain an {audio} placeholder");
  });

  it("mirrors synthesized TTS but excludes prerecorded local audio", async () => {
    const delegate: AudioSink = {
      play: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const sink = new VirtualMicrophoneAudioSink(delegate);
    const signal = new AbortController().signal;

    await sink.play(artifact(), speechContext(), signal);
    await sink.play(
      artifact(),
      {
        speechId: "local-audio",
        source: "local-audio",
        request: {
          text: "song",
          audioPath: resolve("song/example.wav"),
        },
      },
      signal,
    );
    expect(delegate.play).toHaveBeenCalledOnce();

    await sink.stop();
    await sink.dispose();
    expect(delegate.stop).toHaveBeenCalledOnce();
    expect(delegate.dispose).toHaveBeenCalledOnce();
  });

  it("starts both outputs together and waits for every output before failing", async () => {
    let releaseMirror!: () => void;
    const mirrorGate = new Promise<void>((resolveGate) => {
      releaseMirror = resolveGate;
    });
    const primary: AudioSink = {
      async play() {
        throw new Error("primary failed");
      },
      async stop() {},
    };
    const virtualMicrophone: AudioSink = {
      async play() {
        await mirrorGate;
      },
      async stop() {},
    };
    const sink = new MirroredAudioSink(primary, virtualMicrophone);
    let settled = false;
    const playback = sink.play(
      artifact(),
      speechContext(),
      new AbortController().signal,
    );
    void playback.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    releaseMirror();
    await expect(playback).rejects.toThrow("primary failed");
    expect(settled).toBe(true);
  });
});

describe("SVC postprocessor ownership", () => {
  it("uses legacy DDSP and so-vits payloads and commits new temporary artifacts", async () => {
    const fileSystem = new MemoryFileSystem();
    const original = artifact(resolve("out/original.wav"));
    fileSystem.seed(original.path, new Uint8Array([1, 2, 3]));
    const calls: Array<{ url: string; body: BodyInit | null | undefined }> = [];
    const fetch: OutputFetch = async (input, init) => {
      calls.push({ url: String(input), body: init?.body });
      return audioResponse(calls.length === 1 ? [4, 5] : [6, 7, 8]);
    };

    const ddsp = new DdspSvcPostProcessor({
      enabled: true,
      apiBaseUrl: "http://127.0.0.1:6844",
      outputDirectory: resolve("out"),
      safePrefixPadLength: 0.1,
      pitchChange: -2,
      speakerId: 3,
      sampleRate: 44_100,
    }, { fetch, fileSystem, makeId: () => "ddsp" });
    const first = await ddsp.process(original, speechContext(), new AbortController().signal);
    const soVits = new SoVitsSvcPostProcessor({
      enabled: true,
      apiBaseUrl: "http://127.0.0.1:1145",
      outputDirectory: resolve("out"),
      speaker: "ikaros",
      transpose: 1,
      format: "wav",
    }, { fetch, fileSystem, makeId: () => "sovits" });
    const second = await soVits.process(first, speechContext(), new AbortController().signal);

    expect(fileSystem.files.get(original.path)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fileSystem.files.get(first.path)).toEqual(new Uint8Array([4, 5]));
    expect(fileSystem.files.get(second.path)).toEqual(new Uint8Array([6, 7, 8]));
    expect(first).toMatchObject({ temporary: true, format: "wav" });
    expect(second).toMatchObject({ temporary: true, format: "wav" });
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      "/voiceChangeModel",
      "/wav2wav",
    ]);
    const ddspForm = calls[0]?.body as FormData;
    expect(ddspForm.get("fSafePrefixPadLength")).toBe("0.1");
    expect(ddspForm.get("fPitchChange")).toBe("-2");
    expect(ddspForm.get("sSpeakId")).toBe("3");
    expect(ddspForm.get("sampleRate")).toBe("44100");
    const soVitsForm = calls[1]?.body as URLSearchParams;
    expect(Object.fromEntries(soVitsForm.entries())).toEqual({
      audio_path: first.path,
      tran: "1",
      spk: "ikaros",
      wav_format: "wav",
    });
  });

  it("preserves the input and removes only owned partial output on failure", async () => {
    const fileSystem = new MemoryFileSystem();
    const original = artifact(resolve("out/original.wav"));
    fileSystem.seed(original.path, new Uint8Array([1]));
    const processor = new SoVitsSvcPostProcessor({
      enabled: true,
      apiBaseUrl: "http://127.0.0.1:1145",
      outputDirectory: resolve("out"),
      speaker: "ikaros",
      format: "wav",
    }, {
      fileSystem,
      makeId: () => "failed",
      fetch: async () => new Response("service unavailable", { status: 502 }),
    });

    await expect(processor.process(original, speechContext(), new AbortController().signal))
      .rejects.toMatchObject({ code: "OUTPUT_RESPONSE_INVALID", status: 502 });
    expect(fileSystem.files.get(original.path)).toEqual(new Uint8Array([1]));
    expect([...fileSystem.files.keys()]).toEqual([original.path]);
  });

  it("anchors relative SVC outputs to the injected project root and preserves absolute paths", async () => {
    const projectRoot = resolve("test-application-root");
    expect(projectRoot).not.toBe(process.cwd());
    const fileSystem = new MemoryFileSystem();
    const original = artifact(resolve("input/rooted-source.wav"));
    fileSystem.seed(original.path, new Uint8Array([1]));
    const fetch: OutputFetch = async () => audioResponse([9, 8, 7]);

    const adapters = createLegacyOutputAdapters({
      play_audio: { out_path: join("generated", "svc") },
      so_vits_svc: {
        enable: true,
        api_ip_port: "http://127.0.0.1:1145",
        spk: "voice",
        wav_format: "wav",
      },
    }, {
      projectRoot,
      fileSystem,
      fetch,
      makeId: () => "rooted",
    });
    const relativeProcessor = adapters.svcPostProcessors[0];
    if (relativeProcessor === undefined) {
      throw new Error("expected configured SVC postprocessor");
    }
    const relativeResult = await relativeProcessor.process(
      original,
      speechContext(),
      new AbortController().signal,
    );
    expect(relativeResult.path).toBe(resolve(
      projectRoot,
      "generated",
      "svc",
      "so-vits-svc-speech-1-rooted.wav",
    ));

    const absoluteDirectory = resolve("absolute-svc-output");
    const absoluteProcessors = createSvcPostProcessorsFromConfig({
      play_audio: { out_path: absoluteDirectory },
      so_vits_svc: {
        enable: true,
        api_ip_port: "http://127.0.0.1:1145",
        spk: "voice",
        wav_format: "wav",
      },
    }, {
      projectRoot,
      fileSystem,
      fetch,
      makeId: () => "absolute",
    });
    const absoluteProcessor = absoluteProcessors[0];
    if (absoluteProcessor === undefined) {
      throw new Error("expected configured SVC postprocessor");
    }
    const absoluteResult = await absoluteProcessor.process(
      original,
      speechContext(),
      new AbortController().signal,
    );
    expect(absoluteResult.path).toBe(resolve(
      absoluteDirectory,
      "so-vits-svc-speech-1-absolute.wav",
    ));
  });

  it("maps enabled SVC config in legacy execution order", () => {
    const processors = createSvcPostProcessorsFromConfig({
      play_audio: { out_path: "out" },
      ddsp_svc: { enable: true, api_ip_port: "http://localhost:1" },
      so_vits_svc: { enable: true, api_ip_port: "http://localhost:2", spk: "voice" },
    });
    expect(processors[0]).toBeInstanceOf(DdspSvcPostProcessor);
    expect(processors[1]).toBeInstanceOf(SoVitsSvcPostProcessor);
    expect(createSvcPostProcessorsFromConfig({
      ddsp_svc: { enable: false },
      so_vits_svc: { enable: false },
    })).toEqual([]);
  });
});

describe("captions and AppEvent subscribers", () => {
  it("does not resend coordination callback failures to their own callback", async () => {
    let listener!: (event: AppEvent) => void;
    const source = {
      subscribe(next: (event: AppEvent) => void) {
        listener = next;
        return () => undefined;
      },
    };
    const published: AppEvent[] = [];
    const outputFailurePublished = Promise.withResolvers<void>();
    const publisher: EventPublisher = {
      publish(event) {
        published.push(event);
        if (
          event.type === "system.status"
          && event.component === "output.coordination-callback"
        ) {
          outputFailurePublished.resolve();
        }
        listener(event);
      },
    };
    const payloads: unknown[] = [];
    const fetch: OutputFetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return jsonResponse({ message: "temporarily unavailable" }, 503);
    };
    const callback = new CoordinationCallbackBridge({
      enabled: true,
      apiBaseUrl: "http://127.0.0.1:8082",
    }, { fetch, publisher, clock: () => 500 });
    const subscription = subscribeOutputSubscribers(source, [
      new CoordinationCallbackSubscriber({ enabled: true }, callback),
    ], { publisher, clock: () => 500 });

    listener({
      type: "system.status",
      component: "runtime",
      status: "ready",
      timestamp: 100,
    });
    await outputFailurePublished.promise;
    await subscription.dispose();

    expect(payloads).toEqual([
      expect.objectContaining({
        type: "system.status",
        data: expect.objectContaining({ component: "runtime" }),
      }),
    ]);
    expect(published).toEqual([
      expect.objectContaining({
        type: "system.status",
        component: "output.coordination-callback",
        status: "degraded",
      }),
    ]);
  });

  it("bounds interleaved image lifecycles without retaining binary payloads", async () => {
    let listener!: (event: AppEvent) => void;
    const unsubscribe = vi.fn();
    const source = {
      subscribe(next: (event: AppEvent) => void) {
        listener = next;
        return unsubscribe;
      },
    };
    const published: AppEvent[] = [];
    const publisher: EventPublisher = {
      publish(event) {
        published.push(event);
        listener(event);
      },
    };
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const drainReachedTail = Promise.withResolvers<void>();
    const handled: AppEvent[] = [];
    const subscriber = {
      name: "blocked-output",
      async handle(event: AppEvent) {
        handled.push(event);
        if (
          event.type === "agent.completed"
          && event.response.text === "blocked"
        ) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        if (
          event.type === "system.status"
          && event.component === "image-lifecycle-tail"
        ) {
          drainReachedTail.resolve();
        }
      },
    };
    const subscription = subscribeOutputSubscribers(
      source,
      [subscriber],
      {
        publisher,
        clock: () => 777,
        maximumQueuedEvents: 5,
      },
    );
    const sessionId = "visual-session";
    const firstDataUrl = "data:image/png;base64,QUJD";
    const secondDataUrl = "data:image/png;base64,REVG";
    const firstImagePath = resolve("generated/first.png");
    const secondImagePath = resolve("generated/second.png");
    const firstMetadata = {
      sessionId,
      eventType: "image",
      eventId: "source-image-1",
      imagePath: firstImagePath,
      path: firstImagePath,
      images: [firstDataUrl],
      imageBase64: "QUJD",
      imageMimeType: "image/png",
      imageBytes: 3,
      captureTarget: "window",
      nestedPayload: { dataUrl: firstDataUrl },
    };
    const secondMetadata = {
      ...firstMetadata,
      eventId: "source-image-2",
      imagePath: secondImagePath,
      path: secondImagePath,
      images: [secondDataUrl],
      imageBase64: "REVG",
      nestedPayload: { dataUrl: secondDataUrl },
    };
    const firstRequest = {
      sessionId,
      username: "camera",
      content: "describe the capture",
      images: [firstDataUrl],
      metadata: firstMetadata,
    };
    const secondRequest = {
      ...firstRequest,
      images: [secondDataUrl],
      metadata: secondMetadata,
    };

    listener(agentCompleted("blocked"));
    await firstStarted.promise;
    listener(inboundImage("image-1", firstMetadata));
    listener({
      type: "agent.delta",
      request: firstRequest,
      text: "old delta",
      timestamp: 101,
    });
    listener({
      type: "agent.completed",
      request: firstRequest,
      response: {
        text: "old response",
        model: "test",
        provider: "test",
      },
      timestamp: 102,
    });
    listener({
      type: "system.status",
      component: "image-lifecycle-tail",
      status: "ready",
      timestamp: 103,
    });
    listener(inboundImage("image-2", secondMetadata));
    listener({
      type: "agent.delta",
      request: secondRequest,
      text: "latest delta",
      timestamp: 104,
    });
    listener({
      type: "agent.completed",
      request: secondRequest,
      response: {
        text: "latest response",
        model: "test",
        provider: "test",
      },
      timestamp: 105,
    });
    listener(agentCompleted("dropped-1"));
    listener(agentCompleted("dropped-2"));

    expect(handled).toHaveLength(1);
    expect(published).toEqual([
      expect.objectContaining({
        type: "system.status",
        component: "output.subscriber.blocked-output",
        status: "degraded",
        metadata: expect.objectContaining({
          code: "OUTPUT_REQUEST_FAILED",
          outputSubscriberQueueOverflow: true,
          maximumQueuedEvents: 5,
          droppedEventType: "agent.completed",
        }),
        timestamp: 777,
      }),
    ]);

    releaseFirst.resolve();
    await drainReachedTail.promise;
    await subscription.dispose();
    expect(handled).toHaveLength(5);
    expect(handled.map((event) => event.type)).toEqual([
      "agent.completed",
      "inbound",
      "agent.delta",
      "agent.completed",
      "system.status",
    ]);
    expect(JSON.stringify(handled)).not.toContain("data:image");
    expect(JSON.stringify(handled)).not.toContain("imageBase64");
    expect(JSON.stringify(handled)).not.toContain("nestedPayload");

    const retainedInbound = handled[1];
    if (retainedInbound?.type !== "inbound") {
      throw new Error("expected retained inbound image event");
    }
    expect(retainedInbound.event).toMatchObject({
      id: "image-2",
      content: "prompt for image-2",
      metadata: {
        sessionId,
        eventType: "image",
        eventId: "source-image-2",
        imagePath: secondImagePath,
        path: secondImagePath,
        imageMimeType: "image/png",
        imageBytes: 3,
        captureTarget: "window",
      },
    });
    expect(retainedInbound.event.metadata).not.toHaveProperty("images");

    const retainedDelta = handled[2];
    if (retainedDelta?.type !== "agent.delta") {
      throw new Error("expected retained agent delta event");
    }
    expect(retainedDelta).toMatchObject({
      text: "latest delta",
      request: {
        sessionId,
        content: "describe the capture",
        metadata: {
          eventId: "source-image-2",
          imagePath: secondImagePath,
          path: secondImagePath,
          imageMimeType: "image/png",
          imageBytes: 3,
        },
      },
    });
    expect(retainedDelta.request).not.toHaveProperty("images");

    const retainedCompleted = handled[3];
    if (retainedCompleted?.type !== "agent.completed") {
      throw new Error("expected retained completed image event");
    }
    expect(retainedCompleted.response.text).toBe("latest response");
    expect(retainedCompleted.request).not.toHaveProperty("images");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(published).toHaveLength(1);
  });

  it("discards queued events on dispose while awaiting the active handler", async () => {
    let listener!: (event: AppEvent) => void;
    const unsubscribe = vi.fn();
    const source = {
      subscribe(next: (event: AppEvent) => void) {
        listener = next;
        return unsubscribe;
      },
    };
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const handled: string[] = [];
    const disposeSubscriber = vi.fn(async () => undefined);
    const subscriber = {
      name: "disposing-output",
      async handle(event: AppEvent) {
        const label = event.type === "agent.completed"
          ? event.response.text
          : event.type;
        handled.push(label);
        if (label === "blocked") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      },
      dispose: disposeSubscriber,
    };
    const subscription = subscribeOutputSubscribers(
      source,
      [subscriber],
      { maximumQueuedEvents: 3 },
    );

    listener(agentCompleted("blocked"));
    await firstStarted.promise;
    listener(agentCompleted("queued-1"));
    listener(inboundImage("queued-image", {
      sessionId: "queued-session",
      images: ["data:image/png;base64,QUJD"],
    }));

    const firstDisposal = subscription.dispose();
    const secondDisposal = subscription.dispose();
    expect(secondDisposal).toBe(firstDisposal);
    let disposalSettled = false;
    void firstDisposal.then(() => {
      disposalSettled = true;
    });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(disposeSubscriber).not.toHaveBeenCalled();

    releaseFirst.resolve();
    await firstDisposal;
    expect(handled).toEqual(["blocked"]);
    expect(disposeSubscriber).toHaveBeenCalledOnce();
  });
  it("atomically writes file captions", async () => {
    const fileSystem = new MemoryFileSystem();
    const root = resolve("workspace");
    fileSystem.directories.add(root);
    const file = new FileCaptionBridge({
      enabled: true,
      rootDirectory: root,
      filePath: "log/字幕.txt",
    }, { fileSystem, makeId: () => "caption" });

    await file.update({ content: "A&B 你好" });
    expect(new TextDecoder().decode(fileSystem.files.get(join(root, "log/字幕.txt"))))
      .toBe("A&B 你好");
    await expect(new FileCaptionBridge({
      enabled: true,
      rootDirectory: root,
      filePath: "../secret.txt",
    }, { fileSystem }).update({ content: "secret" })).rejects.toMatchObject({
      code: "OUTPUT_PATH_INVALID",
    });
  });

  it("does not overwrite project files through a caption output directory junction", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-vtuber-caption-boundary-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"));
    const protectedFile = join(root, "src", "protected.txt");
    await writeDiskFile(protectedFile, "keep project content");
    await symlink(join(root, "src"), join(root, "out"), "junction");
    const captions = new FileCaptionBridge({
      enabled: true,
      rootDirectory: root,
      filePath: "out/protected.txt",
    });

    await expect(captions.update({ content: "caption overwrite" })).rejects.toMatchObject({
      code: "OUTPUT_PATH_INVALID",
    });
    expect(await readDiskFile(protectedFile, "utf8")).toBe("keep project content");
  });

  it("updates raw captions on inbound and rendered captions on speech start", async () => {
    const rawUpdates: CaptionUpdate[] = [];
    const renderedUpdates: CaptionUpdate[] = [];
    const raw: CaptionBridge = {
      name: "raw",
      enabled: true,
      update: async (caption) => { rawUpdates.push(caption); },
    };
    const rendered: CaptionBridge = {
      name: "rendered",
      enabled: true,
      update: async (caption) => { renderedUpdates.push(caption); },
    };
    const subscriber = new CaptionSubscriber(rendered, raw);
    await subscriber.handle(inboundComment("原文"));
    await subscriber.handle({
      type: "speech.started",
      speechId: "speech-1",
      request: { text: "回复", sourceEventId: "event-1", metadata: { eventType: "comment" } },
      timestamp: 200,
    });
    expect(rawUpdates).toEqual([expect.objectContaining({ content: "原文" })]);
    expect(renderedUpdates).toEqual([expect.objectContaining({ content: "回复" })]);
  });

  it("forwards completed replies with their source event", async () => {
    const forwarded: OutputTextMessage[] = [];
    const bridge: TextOutputBridge = {
      name: "capture",
      enabled: true,
      sendText: async (message) => { forwarded.push(message); },
    };
    await new ReplyForwardingSubscriber([bridge]).handle(agentCompleted("最终回复"));
    expect(forwarded[0]).toMatchObject({ content: "最终回复", sourceEventId: "event-1" });
  });

  it("tracks playback callback state and rejects malformed callback bodies", async () => {
    const callbackBodies: unknown[] = [];
    const callback = new CoordinationCallbackBridge({
      enabled: true,
      apiBaseUrl: "http://127.0.0.1:8082",
      endpointPath: "callback",
    }, {
      clock: () => 500,
      fetch: async (_input, init) => {
        callbackBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ code: 200, message: "ok" });
      },
    });
    const subscriber = new PlaybackStatusSubscriber({ callback, clock: () => 500 });
    const request: SpeechRequest = { text: "text" };
    await subscriber.handle({ type: "speech.queued", speechId: "a", request, timestamp: 1 });
    await subscriber.handle({ type: "speech.queued", speechId: "b", request, timestamp: 2 });
    await subscriber.handle({ type: "speech.started", speechId: "a", request, timestamp: 3 });
    await subscriber.handle({ type: "speech.completed", speechId: "a", request, timestamp: 4 });

    expect(subscriber.status).toEqual({
      waitPlayAudio: 1,
      waitSynthesisMessages: 1,
      activeSpeechIds: [],
    });
    expect(callbackBodies).toEqual([{
      type: "audio_playback_completed",
      data: { wait_play_audio_num: 1, wait_synthesis_msg_num: 1 },
      timestamp: 500,
    }]);
    expect(parsePlaybackCallback({
      type: "audio_playback_completed",
      data: { wait_play_audio_num: 2, wait_synthesis_msg_num: 3 },
    }).data.wait_play_audio_num).toBe(2);
    expect(() => parsePlaybackCallback({
      type: "audio_playback_completed",
      data: { wait_play_audio_num: -1, wait_synthesis_msg_num: 0 },
    })).toThrow(OutputBridgeError);
  });
});

describe("local Live2D output", () => {
  it("serves Live2D only from the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-vtuber-live2d-"));
    temporaryDirectories.push(root);
    await writeDiskFile(join(root, "index.html"), "<html><body>Live2D</body></html>", "utf8");
    await mkdir(join(root, "live2d-model", "Hiyori"), { recursive: true });
    await writeDiskFile(join(root, "live2d-model", "Hiyori", "Hiyori.model3.json"), "{}", "utf8");
    const server = new Live2dStaticServer({
      enabled: true,
      rootDirectory: root,
      host: "127.0.0.1",
      port: 0,
    });
    const origin = await server.start();
    expect(origin).toBeTypeOf("string");
    const page = await fetch(`${origin}/Live2D/`);
    expect(page.status).toBe(200);
    const traversal = await fetch(`${origin}/Live2D/%2e%2e/config.json`);
    expect([403, 404]).toContain(traversal.status);
    server.publishMessage("你好", 2_000);
    await server.dispose();
  });
});
