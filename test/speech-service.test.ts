import { getEventListeners } from "node:events";
import { writeFileSync } from "node:fs";
import {
  copyFile,
  mkdtemp,
  readFile,
  rename,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualMicrophoneAudioSink } from "../src/output/index.js";
import {
  nodeOutputFileSystem,
  SoVitsSvcPostProcessor,
  type OutputFileSystem,
} from "../src/output/index.js";
import type { JsonObject } from "../src/config/config-store.js";
import type {
  AppEvent,
  EventPublisher,
  SpeechRequest,
} from "../src/domain/types.js";
import {
  DisabledSpeechSynthesizer,
  QueuedSpeechService,
  SpeechCapacityError,
  SpeechServiceStoppedError,
  createSpeechSynthesizer,
  createSpeechService,
  resolveSpeechRuntimeSettings,
  type AudioArtifact,
  type AudioPostProcessor,
  type AudioSink,
  type SpeechAudioContext,
  type SpeechSynthesizer,
  type SpeechPriorityMapping,
  type SpeechTextSplitOptions,
  type SynthesizedAudio,
} from "../src/speech/index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

type SpeechEventType = Extract<AppEvent, { speechId: string }>["type"];
type SpeechEvent<T extends SpeechEventType> = Extract<AppEvent, { type: T }>;

class RecordingPublisher implements EventPublisher {
  readonly events: AppEvent[] = [];
  readonly #waiters: Array<{
    readonly type: SpeechEventType;
    readonly speechId: string;
    readonly resolve: (event: AppEvent) => void;
  }> = [];
  readonly #onPublish: ((event: AppEvent) => void) | undefined;

  constructor(onPublish?: (event: AppEvent) => void) {
    this.#onPublish = onPublish;
  }

  publish(event: AppEvent): void {
    this.events.push(event);
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      if (
        waiter !== undefined &&
        "speechId" in event &&
        waiter.type === event.type &&
        waiter.speechId === event.speechId
      ) {
        this.#waiters.splice(index, 1);
        waiter.resolve(event);
      }
    }
    this.#onPublish?.(event);
  }

  waitFor<T extends SpeechEventType>(
    type: T,
    speechId: string,
  ): Promise<SpeechEvent<T>> {
    const existing = this.events.find(
      (event): event is SpeechEvent<T> =>
        event.type === type &&
        "speechId" in event &&
        event.speechId === speechId,
    );
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise<SpeechEvent<T>>((resolveEvent) => {
      this.#waiters.push({
        type,
        speechId,
        resolve: (event) => resolveEvent(event as SpeechEvent<T>),
      });
    });
  }
}

function byteStream(text: string): AsyncIterable<Uint8Array> {
  return (async function* audioBytes() {
    yield Buffer.from(text, "utf8");
  })();
}

function validWav(payload: string): Buffer {
  const audio = Buffer.from(payload, "utf8");
  const wav = Buffer.alloc(44 + audio.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + audio.byteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24);
  wav.writeUInt32LE(8_000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(audio.byteLength, 40);
  audio.copy(wav, 44);
  return wav;
}

async function tryCreateFileSymlink(
  target: string,
  linkPath: string,
): Promise<boolean> {
  try {
    await symlink(target, linkPath, "file");
    return true;
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      return false;
    }
    throw error;
  }
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

class ImmediateSynthesizer implements SpeechSynthesizer {
  readonly name = "fake";
  readonly calls: string[] = [];

  async synthesize(
    request: SpeechRequest,
    signal: AbortSignal,
  ): Promise<SynthesizedAudio> {
    signal.throwIfAborted();
    this.calls.push(request.text);
    return { extension: "wav", stream: byteStream(request.text) };
  }
}

class ControlledSynthesizer implements SpeechSynthesizer {
  readonly name = "controlled";
  readonly calls: string[] = [];
  readonly #gates = new Map<string, Deferred<void>>();

  async synthesize(
    request: SpeechRequest,
    signal: AbortSignal,
  ): Promise<SynthesizedAudio> {
    this.calls.push(request.text);
    const gate = deferred<void>();
    this.#gates.set(request.text, gate);
    await new Promise<void>((resolveGate, rejectGate) => {
      const onAbort = (): void => {
        rejectGate(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void gate.promise.then(resolveGate, rejectGate).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
    signal.throwIfAborted();
    return { extension: "wav", stream: byteStream(request.text) };
  }

  release(text: string): void {
    const gate = this.#gates.get(text);
    if (gate === undefined) {
      throw new Error(`No active synthesis gate for ${text}`);
    }
    gate.resolve();
  }
}

class RecordingSink implements AudioSink {
  readonly played: Array<{
    text: string;
    path: string;
    bytes: string;
    rawBytes: Buffer;
  }> = [];
  stopCalls = 0;

  async play(
    artifact: AudioArtifact,
    context: SpeechAudioContext,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const rawBytes = await readFile(artifact.path);
    this.played.push({
      text: context.request.text,
      path: artifact.path,
      bytes: rawBytes.toString("utf8"),
      rawBytes,
    });
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class DelayedReleaseSink implements AudioSink {
  readonly started = deferred<void>();
  readonly aborted = deferred<void>();
  readonly release = deferred<void>();
  stopCalls = 0;
  readonly played: string[] = [];
  #active = false;

  async play(
    _artifact: AudioArtifact,
    context: SpeechAudioContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#active) {
      throw new Error("Audio sink received overlapping playback requests");
    }
    this.#active = true;
    this.played.push(context.request.text);
    this.started.resolve();
    const onAbort = (): void => {
      this.aborted.resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (context.request.text === "first") {
        await this.release.promise;
      }
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#active = false;
    }
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.release.resolve();
  }
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function serviceFixture(options?: {
  readonly synthesizer?: SpeechSynthesizer;
  readonly sink?: AudioSink;
  readonly publisher?: RecordingPublisher;
  readonly queueCapacity?: number;
  readonly admissionWaiterCapacity?: number;
  readonly queueStartThreshold?: number;
  readonly priorityMapping?: SpeechPriorityMapping;
  readonly preserveOutput?: boolean;
  readonly postProcessors?: readonly AudioPostProcessor[];
  readonly requestTimeoutMs?: number;
  readonly maxAudioBytes?: number;
  readonly textSplit?: SpeechTextSplitOptions;
  readonly waitForGap?: (
    durationMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
}): Promise<{
  readonly service: QueuedSpeechService;
  readonly publisher: RecordingPublisher;
  readonly sink: AudioSink;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "ai-vtuber-speech-test-"));
  temporaryRoots.push(root);
  const publisher = options?.publisher ?? new RecordingPublisher();
  const sink = options?.sink ?? new RecordingSink();
  let nextId = 1;
  let timestamp = 1_000;
  const service = new QueuedSpeechService({
    synthesizer: options?.synthesizer ?? new ImmediateSynthesizer(),
    sink,
    publisher,
    queueCapacity: options?.queueCapacity ?? 2,
    admissionWaiterCapacity:
      options?.admissionWaiterCapacity ?? options?.queueCapacity ?? 2,
    ...(options?.queueStartThreshold === undefined
      ? {}
      : { queueStartThreshold: options.queueStartThreshold }),
    ...(options?.priorityMapping === undefined
      ? {}
      : { priorityMapping: options.priorityMapping }),
    requestTimeoutMs: options?.requestTimeoutMs ?? 10_000,
    ...(options?.maxAudioBytes === undefined
      ? {}
      : { maxAudioBytes: options.maxAudioBytes }),
    localAudioRoot: root,
    ...(options?.textSplit === undefined ? {} : { textSplit: options.textSplit }),
    ...(options?.waitForGap === undefined
      ? {}
      : { waitForGap: options.waitForGap }),
    outputDirectory: join(root, "output"),
    temporaryDirectory: join(root, "temporary"),
    preserveOutput: options?.preserveOutput ?? false,
    postProcessors: options?.postProcessors ?? [],
    idFactory: () => `speech-${nextId++}`,
    clock: () => timestamp++,
  });
  return { service, publisher, sink, root };
}

describe("QueuedSpeechService", () => {
  it("processes admitted requests FIFO and publishes ordered lifecycle events", async () => {
    const synthesizer = new ControlledSynthesizer();
    const sink = new RecordingSink();
    const { service, publisher } = await serviceFixture({ synthesizer, sink });

    const firstId = await service.enqueue({ text: "first" });
    await publisher.waitFor("speech.started", firstId);
    const secondId = await service.enqueue({ text: "second" });
    const thirdId = await service.enqueue({ text: "third" });

    synthesizer.release("first");
    await publisher.waitFor("speech.started", secondId);
    synthesizer.release("second");
    await publisher.waitFor("speech.started", thirdId);
    synthesizer.release("third");
    await publisher.waitFor("speech.completed", thirdId);

    expect(synthesizer.calls).toEqual(["first", "second", "third"]);
    expect(sink.played.map(({ text }) => text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    for (const speechId of [firstId, secondId, thirdId]) {
      expect(
        publisher.events
          .filter((event) => "speechId" in event && event.speechId === speechId)
          .map(({ type }) => type),
      ).toEqual(["speech.queued", "speech.started", "speech.completed"]);
    }
    expect(service.status()).toEqual({ state: "idle", queued: 0 });
    await service.stop();
  });

  it("applies bounded FIFO backpressure without dropping a request", async () => {
    const synthesizer = new ControlledSynthesizer();
    const { service, publisher } = await serviceFixture({
      synthesizer,
      queueCapacity: 1,
    });

    const firstId = await service.enqueue({ text: "one" });
    await publisher.waitFor("speech.started", firstId);
    const secondId = await service.enqueue({ text: "two" });
    let thirdAdmitted = false;
    const thirdAdmission = service.enqueue({ text: "three" }).then((id) => {
      thirdAdmitted = true;
      return id;
    });
    await Promise.resolve();

    expect(thirdAdmitted).toBe(false);
    expect(service.status()).toEqual({
      state: "running",
      queued: 1,
      activeId: firstId,
    });

    synthesizer.release("one");
    await publisher.waitFor("speech.started", secondId);
    const thirdId = await thirdAdmission;
    synthesizer.release("two");
    await publisher.waitFor("speech.started", thirdId);
    synthesizer.release("three");
    await publisher.waitFor("speech.completed", thirdId);

    expect(synthesizer.calls).toEqual(["one", "two", "three"]);
    await service.stop();
  });

  it("removes an aborted admission waiter and never speaks it later", async () => {
    const synthesizer = new ControlledSynthesizer();
    const { service, publisher } = await serviceFixture({
      synthesizer,
      queueCapacity: 1,
    });
    const firstId = await service.enqueue({ text: "active" });
    await publisher.waitFor("speech.started", firstId);
    const queuedId = await service.enqueue({ text: "queued" });
    const controller = new AbortController();
    const cancellation = new Error("caller disconnected while waiting");
    const cancelledAdmission = service.enqueue(
      { text: "cancelled waiter" },
      { signal: controller.signal },
    );
    const cancelledRejection = expect(cancelledAdmission).rejects.toBe(
      cancellation,
    );
    controller.abort(cancellation);
    await cancelledRejection;

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const replacementAdmission = service.enqueue({ text: "replacement" });
    synthesizer.release("active");
    await publisher.waitFor("speech.started", queuedId);
    const replacementId = await replacementAdmission;
    synthesizer.release("queued");
    await publisher.waitFor("speech.started", replacementId);
    synthesizer.release("replacement");
    await publisher.waitFor("speech.completed", replacementId);

    expect(synthesizer.calls).toEqual(["active", "queued", "replacement"]);
    expect(
      publisher.events.some(
        (event) =>
          "speechId" in event && event.request.text === "cancelled waiter",
      ),
    ).toBe(false);
    await service.stop();
  });

  it("cancels queued and active requests without retaining signal listeners", async () => {
    const synthesizer = new ControlledSynthesizer();
    const sink = new RecordingSink();
    const { service, publisher } = await serviceFixture({
      synthesizer,
      sink,
      queueCapacity: 1,
    });
    const blockerId = await service.enqueue({ text: "blocker" });
    await publisher.waitFor("speech.started", blockerId);

    const queuedController = new AbortController();
    const queuedId = await service.enqueue(
      { text: "queued cancellation" },
      { signal: queuedController.signal },
    );
    queuedController.abort(new Error("queued caller left"));
    await publisher.waitFor("speech.error", queuedId);
    expect(getEventListeners(queuedController.signal, "abort")).toHaveLength(0);

    synthesizer.release("blocker");
    await publisher.waitFor("speech.completed", blockerId);
    const activeController = new AbortController();
    const activeId = await service.enqueue(
      { text: "active cancellation" },
      { signal: activeController.signal },
    );
    await publisher.waitFor("speech.started", activeId);
    activeController.abort(new Error("active caller left"));
    await publisher.waitFor("speech.error", activeId);

    expect(getEventListeners(activeController.signal, "abort")).toHaveLength(0);
    expect(synthesizer.calls).toEqual(["blocker", "active cancellation"]);
    expect(sink.played.map(({ text }) => text)).toEqual(["blocker"]);
    await service.stop();
  });

  it("does not wait for or later play an uncooperative cancelled synthesizer", async () => {
    const synthesis = deferred<SynthesizedAudio>();
    const synthesizer: SpeechSynthesizer = {
      name: "uncooperative",
      async synthesize() {
        return synthesis.promise;
      },
    };
    const sink = new RecordingSink();
    const { service, publisher } = await serviceFixture({ synthesizer, sink });
    const controller = new AbortController();
    const id = await service.enqueue(
      { text: "cancel me" },
      { signal: controller.signal },
    );
    await publisher.waitFor("speech.started", id);
    controller.abort(new Error("caller left"));
    await publisher.waitFor("speech.error", id);

    synthesis.resolve({ extension: "wav", stream: byteStream("too late") });
    await synthesis.promise;
    expect(sink.played).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await service.stop();
  });

  it("rejects producers beyond the finite admission waiter capacity", async () => {
    const synthesizer = new ControlledSynthesizer();
    const { service, publisher } = await serviceFixture({
      synthesizer,
      queueCapacity: 1,
      admissionWaiterCapacity: 1,
    });
    const activeId = await service.enqueue({ text: "active" });
    await publisher.waitFor("speech.started", activeId);
    await service.enqueue({ text: "queued" });
    const waitingAdmission = service.enqueue({ text: "one waiter" });
    const waitingRejection = expect(waitingAdmission).rejects.toBeInstanceOf(
      Error,
    );

    await expect(
      service.enqueue({ text: "over capacity" }),
    ).rejects.toBeInstanceOf(SpeechCapacityError);
    await service.stop();
    await waitingRejection;
  });

  it("waits for the configured startup depth before beginning playback", async () => {
    const synthesizer = new ControlledSynthesizer();
    const { service, publisher } = await serviceFixture({
      synthesizer,
      queueCapacity: 2,
      queueStartThreshold: 2,
    });
    const firstId = await service.enqueue({ text: "buffered first" });
    expect(synthesizer.calls).toEqual([]);
    expect(service.status()).toEqual({ state: "idle", queued: 1 });

    const secondId = await service.enqueue({ text: "buffered second" });
    await publisher.waitFor("speech.started", firstId);
    synthesizer.release("buffered first");
    await publisher.waitFor("speech.started", secondId);
    synthesizer.release("buffered second");
    await publisher.waitFor("speech.completed", secondId);
    await service.stop();
  });

  it("orders queued speech by stable descending legacy priority", async () => {
    const synthesizer = new ControlledSynthesizer();
    const { service, publisher } = await serviceFixture({
      synthesizer,
      queueCapacity: 4,
      priorityMapping: {
        schedule: 10,
        talk: 30,
        reread_top_priority: 999,
      },
    });
    const blockerId = await service.enqueue({ text: "blocker" });
    await publisher.waitFor("speech.started", blockerId);
    const scheduleId = await service.enqueue({
      text: "schedule",
      metadata: { eventType: "schedule", source: "reread" },
    });
    const talkId = await service.enqueue({
      text: "talk",
      metadata: { eventType: "talk" },
    });
    const topId = await service.enqueue({
      text: "top reread",
      metadata: {
        eventType: "comment",
        chatType: "reread_top_priority",
      },
    });

    synthesizer.release("blocker");
    await publisher.waitFor("speech.started", topId);
    synthesizer.release("top reread");
    await publisher.waitFor("speech.started", talkId);
    synthesizer.release("talk");
    await publisher.waitFor("speech.started", scheduleId);
    synthesizer.release("schedule");
    await publisher.waitFor("speech.completed", scheduleId);

    expect(synthesizer.calls).toEqual([
      "blocker",
      "top reread",
      "talk",
      "schedule",
    ]);
    await service.stop();
  });

  it("rejects lower priority at capacity and evicts the newest lowest priority", async () => {
    const synthesizer = new ControlledSynthesizer();
    const { service, publisher } = await serviceFixture({
      synthesizer,
      queueCapacity: 1,
      priorityMapping: {
        schedule: 10,
        talk: 30,
        reread_top_priority: 999,
      },
    });
    const blockerId = await service.enqueue({ text: "blocker" });
    await publisher.waitFor("speech.started", blockerId);
    const talkId = await service.enqueue({
      text: "queued talk",
      metadata: { eventType: "talk" },
    });

    await expect(
      service.enqueue({
        text: "low schedule",
        metadata: { eventType: "schedule" },
      }),
    ).rejects.toBeInstanceOf(SpeechCapacityError);
    const topId = await service.enqueue({
      text: "urgent reread",
      metadata: { chatType: "reread_top_priority" },
    });
    const evicted = await publisher.waitFor("speech.error", talkId);
    expect(evicted.error).toContain("higher-priority");

    synthesizer.release("blocker");
    await publisher.waitFor("speech.started", topId);
    synthesizer.release("urgent reread");
    await publisher.waitFor("speech.completed", topId);
    expect(synthesizer.calls).toEqual(["blocker", "urgent reread"]);
    await service.stop();
  });

  it("aborts active work, cancels queued work, and rejects blocked producers on stop", async () => {
    const synthesizer = new ControlledSynthesizer();
    const sink = new RecordingSink();
    const { service, publisher } = await serviceFixture({
      synthesizer,
      sink,
      queueCapacity: 1,
    });

    const firstId = await service.enqueue({ text: "active" });
    await publisher.waitFor("speech.started", firstId);
    const secondId = await service.enqueue({ text: "queued" });
    const blockedAdmission = service.enqueue({ text: "blocked" });
    const blockedRejection = expect(blockedAdmission).rejects.toBeInstanceOf(
      Error,
    );

    await service.stop();
    await blockedRejection;

    const speechErrors = publisher.events.filter(
      (event): event is Extract<AppEvent, { type: "speech.error" }> =>
        event.type === "speech.error",
    );
    expect(speechErrors.map(({ speechId }) => speechId)).toEqual([
      secondId,
      firstId,
    ]);
    expect(speechErrors.every(({ error }) => error.includes("stopping"))).toBe(
      true,
    );
    expect(sink.stopCalls).toBe(1);
    expect(service.status()).toEqual({ state: "stopped", queued: 0 });
    await expect(service.enqueue({ text: "late" })).rejects.toBeInstanceOf(
      SpeechServiceStoppedError,
    );
  });

  it("removes temporary output only after the sink consumes it", async () => {
    const sink = new RecordingSink();
    const { service, publisher } = await serviceFixture({ sink });
    const id = await service.enqueue({ text: "temporary audio" });
    const completed = await publisher.waitFor("speech.completed", id);

    expect(completed).not.toHaveProperty("outputPath");
    expect(sink.played).toHaveLength(1);
    const playedPath = sink.played[0]?.path;
    expect(playedPath).toBeDefined();
    await expect(stat(playedPath ?? "")).rejects.toMatchObject({ code: "ENOENT" });
    await service.stop();
  });

  it("preserves an explicit hygienic output path and rejects traversal", async () => {
    const { service, publisher, root } = await serviceFixture();
    const savedId = await service.enqueue({
      text: "saved",
      outputPath: "nested/result",
    });
    const saved = await publisher.waitFor("speech.completed", savedId);
    const expectedPath = join(root, "output", "nested", "result.wav");
    expect(saved.outputPath).toBe(expectedPath);
    expect(await readFile(expectedPath, "utf8")).toBe("saved");

    const rejectedId = await service.enqueue({
      text: "escape",
      outputPath: "../outside",
    });
    const rejected = await publisher.waitFor("speech.error", rejectedId);
    expect(rejected.error).toContain("escapes configured output directory");
    await service.stop();
  });

  it("runs post-processors in order and owns cleanup of temporary artifacts", async () => {
    const observed: string[] = [];
    const processor: AudioPostProcessor = {
      async process(artifact, context) {
        observed.push(`process:${context.request.text}`);
        const processedPath = `${artifact.path}.processed.wav`;
        await copyFile(artifact.path, processedPath);
        return { path: processedPath, format: "wav", temporary: true };
      },
    };
    const sink = new RecordingSink();
    const { service, publisher } = await serviceFixture({
      sink,
      postProcessors: [processor],
    });


    const id = await service.enqueue({ text: "hooked" });
    await publisher.waitFor("speech.completed", id);
    expect(observed).toEqual(["process:hooked"]);
    expect(sink.played[0]?.path).toContain(".processed.wav");
    for (const path of sink.played.map(({ path }) => path)) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await service.stop();
  });
  it("waits for cancelled playback to release the sink before starting its successor", async () => {
    const sink = new DelayedReleaseSink();
    const { service, publisher } = await serviceFixture({ sink });
    const controller = new AbortController();

    const firstId = await service.enqueue({ text: "first" }, { signal: controller.signal });
    await sink.started.promise;
    const secondId = await service.enqueue({ text: "second" });
    controller.abort(new Error("first caller left"));
    await sink.aborted.promise;

    await publisher.waitFor("speech.error", firstId);
    await publisher.waitFor("speech.completed", secondId);

    expect(sink.played).toEqual(["first", "second"]);
    expect(sink.stopCalls).toBe(1);
    await service.stop();
  });

  it("reclaims a late temporary SoVits artifact after cancellation", async () => {
    const renameStarted = deferred<void>();
    const releaseRename = deferred<void>();
    const committed = deferred<string>();
    const delayedFileSystem: OutputFileSystem = {
      ...nodeOutputFileSystem,
      async rename(from, to) {
        renameStarted.resolve();
        await releaseRename.promise;
        await nodeOutputFileSystem.rename(from, to);
        committed.resolve(to);
      },
    };
    let root = "";
    const processor: AudioPostProcessor = {
      async process(artifact, context, signal) {
        return new SoVitsSvcPostProcessor(
          {
            enabled: true,
            apiBaseUrl: "http://127.0.0.1:1145",
            outputDirectory: join(root, "svc-output"),
            speaker: "test",
          },
          {
            projectRoot: root,
            fileSystem: delayedFileSystem,
            makeId: () => "late",
            fetch: async () =>
              new Response(new Uint8Array(validWav("converted")), {
                headers: { "content-type": "audio/wav" },
              }),
          },
        ).process(artifact, context, signal);
      },
    };
    const fixture = await serviceFixture({ postProcessors: [processor] });
    const { service, publisher } = fixture;
    root = fixture.root;

    const controller = new AbortController();
    const id = await service.enqueue({ text: "cancel converted" }, { signal: controller.signal });
    await renameStarted.promise;
    controller.abort(new Error("caller left during SVC commit"));
    const failed = await publisher.waitFor("speech.error", id);
    releaseRename.resolve();

    expect(failed.error).toBe("caller left during SVC commit");
    const committedPath = await committed.promise;
    await vi.waitFor(async () => {
      await expect(stat(committedPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
    expect(await readdir(join(root, "temporary"))).toEqual([]);
    await service.stop();
  });

  it("does not reclaim a local source returned as a temporary processor artifact", async () => {
    const sourceProcessor: AudioPostProcessor = {
      async process(_artifact, context) {
        if (context.source !== "local-audio") {
          throw new Error("Expected local audio context");
        }
        return {
          path: context.request.audioPath,
          format: "wav",
          temporary: true,
        };
      },
    };
    const { service, publisher, root } = await serviceFixture({
      postProcessors: [sourceProcessor],
    });
    const sourcePath = join(root, "source.wav");
    const sourceBytes = validWav("local source");
    await writeFile(sourcePath, sourceBytes);

    const id = await service.enqueueAudio({ text: "protected source", audioPath: sourcePath });
    const failed = await publisher.waitFor("speech.error", id);

    expect(failed.error).toContain("mutable local audio source");
    await expect(readFile(sourcePath)).resolves.toEqual(sourceBytes);
    await service.stop();
  });

  it("completes disabled speech without writing or playing fake audio", async () => {
    const sink = new RecordingSink();
    const { service, publisher } = await serviceFixture({
      synthesizer: new DisabledSpeechSynthesizer("disabled in test"),
      sink,
    });
    const id = await service.enqueue({ text: "silent" });
    const completed = await publisher.waitFor("speech.completed", id);

    expect(completed).not.toHaveProperty("outputPath");
    expect(sink.played).toEqual([]);
    await service.stop();
  });

  it("splits sentence groups serially with deterministic bounded gaps", async () => {
    const synthesizer = new ImmediateSynthesizer();
    const sink = new RecordingSink();
    const gaps: number[] = [];
    const { service, publisher } = await serviceFixture({
      synthesizer,
      sink,
      textSplit: {
        enabled: true,
        intervalNumMin: 1,
        intervalNumMax: 1,
        normalIntervalMinMs: 15,
        normalIntervalMaxMs: 15,
      },
      waitForGap: async (durationMs, signal) => {
        signal.throwIfAborted();
        gaps.push(durationMs);
      },
    });
    const id = await service.enqueue({
      text: "版本是1.25。访问https://example.com/path?q=1. 下一句！最后一句？",
    });
    await publisher.waitFor("speech.completed", id);

    const expectedChunks = [
      "版本是1.25。",
      "访问https://example.com/path?q=1.",
      "下一句！",
      "最后一句？",
    ];
    expect(synthesizer.calls).toEqual(expectedChunks);
    expect(sink.played.map(({ text }) => text)).toEqual(expectedChunks);
    expect(sink.played.map(({ bytes }) => bytes)).toEqual(expectedChunks);
    expect(gaps).toEqual([15, 15, 15]);
    expect(
      publisher.events
        .filter((event) => "speechId" in event && event.speechId === id)
        .map(({ type }) => type),
    ).toEqual(["speech.queued", "speech.started", "speech.completed"]);
    await service.stop();
  });

  it("aborts a bounded inter-chunk gap without synthesizing the next chunk", async () => {
    const controller = new AbortController();
    const synthesizer = new ImmediateSynthesizer();
    const sink = new RecordingSink();
    const gapStarted = deferred<void>();
    let observedGapMs: number | undefined;
    const { service, publisher } = await serviceFixture({
      synthesizer,
      sink,
      textSplit: {
        enabled: true,
        intervalNumMin: 1,
        intervalNumMax: 1,
        normalIntervalMinMs: 1_000,
        normalIntervalMaxMs: 1_000,
      },
      waitForGap: async (durationMs, signal) => {
        observedGapMs = durationMs;
        await new Promise<void>((_resolveGap, rejectGap) => {
          const onAbort = (): void => {
            signal.removeEventListener("abort", onAbort);
            rejectGap(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          gapStarted.resolve();
          if (signal.aborted) {
            onAbort();
          }
        });
      },
    });
    const id = await service.enqueue(
      { text: "第一句。第二句。" },
      { signal: controller.signal },
    );
    await gapStarted.promise;
    controller.abort(new Error("cancelled during gap"));
    const failed = await publisher.waitFor("speech.error", id);

    expect(failed.error).toBe("cancelled during gap");
    expect(observedGapMs).toBe(1_000);
    expect(synthesizer.calls).toEqual(["第一句。"]);
    expect(sink.played).toHaveLength(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await service.stop();
  });

  it("bounds custom synthesizer bytes and removes partial audio on overflow", async () => {
    let sourceClosed = false;
    const synthesizer: SpeechSynthesizer = {
      name: "oversized",
      async synthesize() {
        const stream = (async function* oversizedStream() {
          try {
            yield Buffer.alloc(4, 1);
            yield Buffer.alloc(4, 2);
          } finally {
            sourceClosed = true;
          }
        })();
        return { extension: "wav", stream };
      },
    };
    const sink = new RecordingSink();
    const { service, publisher, root } = await serviceFixture({
      synthesizer,
      sink,
      maxAudioBytes: 5,
    });
    const id = await service.enqueue({ text: "too large" });
    const failed = await publisher.waitFor("speech.error", id);

    expect(failed.error).toContain("configured 5 byte limit");
    expect(sourceClosed).toBe(true);
    expect(sink.played).toEqual([]);
    expect(await readdir(join(root, "temporary"))).toEqual([]);
    await service.stop();
  });

  it("plays validated local audio from an owned artifact through normal hooks", async () => {
    let sourcePath = "";
    const synthesizer = new ImmediateSynthesizer();
    const sink = new RecordingSink();
    const processor: AudioPostProcessor = {
      process: vi.fn<AudioPostProcessor["process"]>(
        async (artifact, context, signal) => {
          signal.throwIfAborted();
          expect(context).toMatchObject({
            source: "local-audio",
            request: {
              text: "idle greeting",
              audioPath: sourcePath,
              sourceEventId: "idle-1",
              metadata: {
                eventType: "idle",
                source: "idle_time_task",
              },
            },
          });
          return artifact;
        },
      ),
    };
    const { service, publisher, root } = await serviceFixture({
      synthesizer,
      sink,
      postProcessors: [processor],
    });
    sourcePath = join(root, "greeting.wav");
    const sourceBytes = validWav("owned local audio");
    await writeFile(sourcePath, sourceBytes);
    const synthesisSpy = vi.spyOn(synthesizer, "synthesize");
    const sinkSpy = vi.spyOn(sink, "play");

    const id = await service.enqueueAudio({
      text: "idle greeting",
      audioPath: sourcePath,
      sourceEventId: "idle-1",
      metadata: {
        eventType: "idle",
        source: "idle_time_task",
        copy: "preserved",
      },
    });
    const completed = await publisher.waitFor("speech.completed", id);

    expect(synthesisSpy).not.toHaveBeenCalled();
    expect(processor.process).toHaveBeenCalledOnce();
    expect(sinkSpy).toHaveBeenCalledOnce();
    expect(sinkSpy.mock.calls[0]?.[1].source).toBe("local-audio");
    expect(sink.played).toHaveLength(1);
    expect(sink.played[0]?.path).not.toBe(sourcePath);
    expect(sink.played[0]?.rawBytes).toEqual(sourceBytes);
    expect(completed).not.toHaveProperty("outputPath");
    expect(completed.request).toEqual({
      text: "idle greeting",
      audioPath: sourcePath,
      sourceEventId: "idle-1",
      metadata: {
        eventType: "idle",
        source: "idle_time_task",
        copy: "preserved",
      },
    });
    expect(
      publisher.events
        .filter((event) => "speechId" in event && event.speechId === id)
        .map(({ type }) => type),
    ).toEqual(["speech.queued", "speech.started", "speech.completed"]);
    await expect(stat(sink.played[0]?.path ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(sourcePath)).isFile()).toBe(true);
    await service.stop();
  });

  it("preserves local-audio source through queued playback so the virtual microphone only receives TTS", async () => {
    const mirroredSources: string[] = [];
    const delegate: AudioSink = {
      async play(_artifact, context) {
        mirroredSources.push(context.source);
      },
      async stop() {},
    };
    const { service, publisher, root } = await serviceFixture({
      sink: new VirtualMicrophoneAudioSink(delegate),
    });
    const localPath = join(root, "clip.wav");
    await writeFile(localPath, validWav("local clip"));

    const ttsId = await service.enqueue({ text: "synthesized TTS" });
    await publisher.waitFor("speech.completed", ttsId);
    const localId = await service.enqueueAudio({
      text: "local clip",
      audioPath: localPath,
    });
    await publisher.waitFor("speech.completed", localId);

    expect(mirroredSources).toEqual(["synthesized"]);
    await service.stop();
  });

  it("orders local and synthesized requests in one metadata-priority queue", async () => {
    const synthesizer = new ImmediateSynthesizer();
    const sink = new RecordingSink();
    const { service, publisher, root } = await serviceFixture({
      synthesizer,
      sink,
      queueCapacity: 3,
      queueStartThreshold: 3,
      priorityMapping: {
        schedule: 10,
        talk: 30,
        reread_top_priority: 999,
      },
    });
    const sourcePath = join(root, "priority.wav");
    await writeFile(sourcePath, validWav("priority source"));

    const scheduleId = await service.enqueueAudio({
      text: "scheduled audio",
      audioPath: sourcePath,
      metadata: { eventType: "schedule", marker: "schedule" },
    });
    const talkId = await service.enqueue({
      text: "synthesized talk",
      metadata: { eventType: "talk" },
    });
    const topId = await service.enqueueAudio({
      text: "urgent local audio",
      audioPath: sourcePath,
      metadata: {
        eventType: "comment",
        chatType: "reread_top_priority",
        marker: "top",
      },
    });
    await publisher.waitFor("speech.completed", scheduleId);

    expect(sink.played.map(({ text }) => text)).toEqual([
      "urgent local audio",
      "synthesized talk",
      "scheduled audio",
    ]);
    expect(synthesizer.calls).toEqual(["synthesized talk"]);
    for (const speechId of [scheduleId, talkId, topId]) {
      expect(
        publisher.events
          .filter(
            (event) => "speechId" in event && event.speechId === speechId,
          )
          .map(({ type }) => type),
      ).toEqual(["speech.queued", "speech.started", "speech.completed"]);
    }
    const topQueued = publisher.events.find(
      (event): event is Extract<AppEvent, { type: "speech.queued" }> =>
        event.type === "speech.queued" && event.speechId === topId,
    );
    expect(topQueued?.request).toMatchObject({
      audioPath: sourcePath,
      metadata: { marker: "top", chatType: "reread_top_priority" },
    });
    await service.stop();
  });

  it("rejects malformed and outside-root local paths before admission", async () => {
    const { service, publisher, root } = await serviceFixture();
    const invalidPaths = [
      "",
      "relative.wav",
      join(root, "nul\0.wav"),
      join(root, "..", "outside.wav"),
    ];

    for (const audioPath of invalidPaths) {
      await expect(
        service.enqueueAudio({ text: "invalid local path", audioPath }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(publisher.events).toEqual([]);
    await service.stop();
  });

  it("publishes terminal errors for corrupt and oversized local audio", async () => {
    const synthesizer = new ImmediateSynthesizer();
    const sink = new RecordingSink();
    const { service, publisher, root } = await serviceFixture({
      synthesizer,
      sink,
      maxAudioBytes: 64,
    });
    const corruptPath = join(root, "corrupt.wav");
    const oversizedPath = join(root, "oversized.wav");
    await writeFile(corruptPath, Buffer.from("not a wave", "utf8"));
    await writeFile(oversizedPath, validWav("x".repeat(40)));

    const corruptId = await service.enqueueAudio({
      text: "corrupt",
      audioPath: corruptPath,
    });
    const corrupt = await publisher.waitFor("speech.error", corruptId);
    const oversizedId = await service.enqueueAudio({
      text: "oversized",
      audioPath: oversizedPath,
    });
    const oversized = await publisher.waitFor("speech.error", oversizedId);

    expect(corrupt.error).toContain("header does not match");
    expect(oversized.error).toContain("exceeds 64 bytes");
    expect(synthesizer.calls).toEqual([]);
    expect(sink.played).toEqual([]);
    for (const speechId of [corruptId, oversizedId]) {
      expect(
        publisher.events
          .filter(
            (event) => "speechId" in event && event.speechId === speechId,
          )
          .map(({ type }) => type),
      ).toEqual(["speech.queued", "speech.started", "speech.error"]);
    }
    await service.stop();
  });

  it("rejects a local audio source that mutates after admission", async () => {
    let sourcePath = "";
    const publisher = new RecordingPublisher((event) => {
      if (
        event.type === "speech.started" &&
        event.request.text === "mutating source"
      ) {
        writeFileSync(sourcePath, Buffer.from("mutated after admission", "utf8"));
      }
    });
    const sink = new RecordingSink();
    const { service, root } = await serviceFixture({ publisher, sink });
    sourcePath = join(root, "mutable.wav");
    await writeFile(sourcePath, validWav("original source"));

    const id = await service.enqueueAudio({
      text: "mutating source",
      audioPath: sourcePath,
    });
    const failed = await publisher.waitFor("speech.error", id);

    expect(failed.error).toContain("header does not match");
    expect(sink.played).toEqual([]);
    expect(
      publisher.events
        .filter((event) => "speechId" in event && event.speechId === id)
        .map(({ type }) => type),
    ).toEqual(["speech.queued", "speech.started", "speech.error"]);
    await service.stop();
  });

  it("rejects symbolic-link local audio without invoking playback", async () => {
    const synthesizer = new ImmediateSynthesizer();
    const sink = new RecordingSink();
    const { service, publisher, root } = await serviceFixture({
      synthesizer,
      sink,
    });
    const sourcePath = join(root, "real.wav");
    const linkedPath = join(root, "linked.wav");
    await writeFile(sourcePath, validWav("linked source"));
    if (!(await tryCreateFileSymlink(sourcePath, linkedPath))) {
      await service.stop();
      return;
    }

    const id = await service.enqueueAudio({
      text: "linked source",
      audioPath: linkedPath,
    });
    const failed = await publisher.waitFor("speech.error", id);

    expect(failed.error).toMatch(/symbolic|link/iu);
    expect(synthesizer.calls).toEqual([]);
    expect(sink.played).toEqual([]);
    await service.stop();
  });

  it("aborts local processing after closing the source and removing artifacts", async () => {
    const entered = deferred<AudioArtifact>();
    const release = deferred<AudioArtifact>();
    const processor: AudioPostProcessor = {
      async process(artifact) {
        entered.resolve(artifact);
        return await release.promise;
      },
    };
    const controller = new AbortController();
    const sink = new RecordingSink();
    const { service, publisher, root } = await serviceFixture({
      sink,
      postProcessors: [processor],
    });
    const sourcePath = join(root, "cancel.wav");
    const movedPath = join(root, "cancel-moved.wav");
    await writeFile(sourcePath, validWav("cancel source"));

    const id = await service.enqueueAudio(
      { text: "cancel local", audioPath: sourcePath },
      { signal: controller.signal },
    );
    const artifact = await entered.promise;
    const cancellation = new Error("local playback caller left");
    controller.abort(cancellation);
    const failed = await publisher.waitFor("speech.error", id);
    release.resolve(artifact);

    expect(failed.error).toBe(cancellation.message);
    expect(sink.played).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(root, "temporary"))).toEqual([]);
    await rename(sourcePath, movedPath);
    expect((await stat(movedPath)).isFile()).toBe(true);
    await service.stop();
  });

  it("preserves local audio output under the configured preservation policy", async () => {
    const sink = new RecordingSink();
    const { service, publisher, root } = await serviceFixture({
      sink,
      preserveOutput: true,
    });
    const sourcePath = join(root, "preserve.wav");
    const sourceBytes = validWav("preserved source");
    await writeFile(sourcePath, sourceBytes);

    const id = await service.enqueueAudio({
      text: "preserve local",
      audioPath: sourcePath,
    });
    const completed = await publisher.waitFor("speech.completed", id);

    expect(completed.outputPath).toBe(
      join(root, "output", `local-audio-${id}.wav`),
    );
    expect(completed.outputPath).not.toBe(sourcePath);
    expect(await readFile(completed.outputPath ?? "")).toEqual(sourceBytes);
    expect(sink.played[0]?.path).toBe(completed.outputPath);
    await service.stop();
  });

});

describe("speech runtime settings", () => {
  it("parses bounded speech split, priority, and playback queue settings", () => {
    const settings = resolveSpeechRuntimeSettings(
      {
        audio_synthesis_type: "none",
        speech: {
          queue_capacity: 9,
          queue_start_threshold: 2,
          priority_mapping: {
            schedule: 10,
            talk: 30,
            reread_top_priority: 999,
          },
          admission_waiter_capacity: 3,
          max_audio_bytes: 1_234,
        },
        play_audio: {
          text_split_enable: true,
          interval_num_min: 2,
          interval_num_max: 3,
          normal_interval_min: 0.25,
          normal_interval_max: 0.75,
        },
      },
      process.cwd(),
    );

    expect(settings).toMatchObject({
      playbackEnabled: true,
      queueCapacity: 9,
      admissionWaiterCapacity: 3,
      queueStartThreshold: 2,
      maxAudioBytes: 1_234,
      priorityMapping: {
        schedule: 10,
        talk: 30,
        reread_top_priority: 999,
      },
      textSplit: {
        enabled: true,
        intervalNumMin: 2,
        intervalNumMax: 3,
        normalIntervalMinMs: 250,
        normalIntervalMaxMs: 750,
      },
    });
  });

  it("accepts the speech queue capacity upper bound", () => {
    const settings = resolveSpeechRuntimeSettings(
      {
        audio_synthesis_type: "none",
        speech: {
          queue_capacity: 100_000,
          queue_start_threshold: 100_000,
        },
      },
      process.cwd(),
    );

    expect(settings.queueCapacity).toBe(100_000);
    expect(settings.queueStartThreshold).toBe(100_000);
  });

  it("preserves the playback toggle separately from synthesis availability", () => {
    const settings = resolveSpeechRuntimeSettings(
      {
        audio_synthesis_type: "edge-tts",
        play_audio: { enable: false },
      },
      process.cwd(),
    );

    expect(settings.enabled).toBe(false);
    expect(settings.playbackEnabled).toBe(false);
  });

  it("uses a no-op sink for local audio when playback is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-vtuber-playback-disabled-"));
    temporaryRoots.push(root);
    const sourcePath = join(root, "local.wav");
    await writeFile(sourcePath, validWav("disabled playback"));
    const publisher = new RecordingPublisher();
    const service = createSpeechService({
      config: {
        snapshot: () => ({
          audio_synthesis_type: "none",
          play_audio: {
            enable: false,
            executable: "__ai_vtuber_missing_player__",
          },
        }),
      },
      publisher,
      cwd: root,
    });

    const id = await service.enqueueAudio({
      text: "local audio",
      audioPath: sourcePath,
    });
    await publisher.waitFor("speech.completed", id);
    expect(
      publisher.events.some(
        (event) => event.type === "speech.error" && event.speechId === id,
      ),
    ).toBe(false);
    await service.stop();
  });

  it("rejects invalid speech queue, priority, and split settings", () => {
    expect(() =>
      resolveSpeechRuntimeSettings(
        {
          audio_synthesis_type: "none",
          speech: {
            queue_capacity: 1,
            queue_start_threshold: 2,
          },
        },
        process.cwd(),
      ),
    ).toThrow("speech.queue_start_threshold");
    expect(() =>
      resolveSpeechRuntimeSettings(
        {
          audio_synthesis_type: "none",
          speech: { queue_capacity: 0 },
        },
        process.cwd(),
      ),
    ).toThrow("speech.queue_capacity");
    expect(() =>
      resolveSpeechRuntimeSettings(
        {
          audio_synthesis_type: "none",
          speech: { queue_capacity: 100_001 },
        },
        process.cwd(),
      ),
    ).toThrow("speech.queue_capacity");
    expect(() =>
      resolveSpeechRuntimeSettings(
        {
          audio_synthesis_type: "none",
          speech: { priority_mapping: { talk: "urgent" } },
        },
        process.cwd(),
      ),
    ).toThrow("speech.priority_mapping");
    expect(() =>
      resolveSpeechRuntimeSettings(
        {
          audio_synthesis_type: "none",
          play_audio: {
            interval_num_min: 3,
            interval_num_max: 2,
          },
        },
        process.cwd(),
      ),
    ).toThrow("interval_num_min/max");
  });
});

describe("speech adapter selection", () => {
  const cwd = process.cwd();
  const playableConfig = (engine: string, section: JsonObject): JsonObject => ({
    audio_synthesis_type: engine,
    play_audio: { enable: true, out_path: "out", player: "ffplay" },
    [engine]: section,
  });
  const basicHttpConfig = playableConfig("openai_tts", {
    type: "api",
    api_ip_port: "https://api.openai.test/v1",
    api_key: "key",
    model: "tts-1",
    voice: "nova",
  });

  it.each([
    [
      "edge-tts",
      { voice: "zh-CN-XiaoyiNeural", rate: "+0%", volume: "+0%" },
      "edge-tts",
    ],
    [
      "azure_tts",
      { subscription_key: "key", region: "eastus", voice_name: "en-US-JennyNeural" },
      "azure_tts",
    ],
    [
      "openai_tts",
      {
        type: "api",
        api_ip_port: "https://api.openai.com/v1",
        api_key: "key",
        model: "tts-1",
        voice: "nova",
      },
      "openai_tts",
    ],
  ])("selects the %s adapter", (engine, section, expectedName) => {
    const synthesizer = createSpeechSynthesizer(
      playableConfig(engine, section),
      cwd,
    );
    expect(synthesizer.name).toBe(expectedName);
  });

  it("bounds a never-ending basic HTTP error body by the service deadline", async () => {
    let bodyCancelled = false;
    const synthesizer = createSpeechSynthesizer(
      basicHttpConfig,
      cwd,
      async () =>
        openBodyResponse(
          '{"detail":"offline"}',
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
    const { service, publisher } = await serviceFixture({
      synthesizer,
      requestTimeoutMs: 50,
    });
    const id = await service.enqueue({ text: "deadline" });
    const failure = await publisher.waitFor("speech.error", id);

    await service.dispose();
    expect(failure.error).toBe("Speech request timed out after 50 ms");
    expect(bodyCancelled).toBe(true);
    expect(service.status()).toEqual({ state: "stopped", queued: 0 });
  });

  it("caps and cancels an oversized basic content-type error body", async () => {
    let bodyCancelled = false;
    const synthesizer = createSpeechSynthesizer(
      basicHttpConfig,
      cwd,
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

    const outcome: unknown = await synthesizer
      .synthesize({ text: "oversized error" }, new AbortController().signal)
      .catch((error: unknown) => error);
    if (!(outcome instanceof Error)) {
      throw new Error("Expected the basic HTTP adapter to reject");
    }
    expect(outcome.message).toContain("returned text/plain instead of audio");
    expect(outcome.message).toContain("diagnostic-start");
    expect(outcome.message).not.toContain("diagnostic-tail");
    expect(bodyCancelled).toBe(true);
  });

  it("maps none and disabled playback to the explicit disabled adapter", () => {
    const none = createSpeechSynthesizer(playableConfig("none", {}), cwd);
    const disabled = createSpeechSynthesizer(
      {
        audio_synthesis_type: "edge-tts",
        play_audio: { enable: false, player: "ffplay" },
      },
      cwd,
    );
    expect(none).toBeInstanceOf(DisabledSpeechSynthesizer);
    expect(disabled).toBeInstanceOf(DisabledSpeechSynthesizer);
  });

});
