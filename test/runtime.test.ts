import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigStore, type JsonObject } from "../src/config/config-store.js";
import {
  IdleConfigurationError,
  MAX_TIMER_DELAY_MS,
  validateIdleConfig,
} from "../src/config/idle.js";
import type {
  AgentExecutor,
  EventSource,
  SpeechService,
} from "../src/core/contracts.js";
import { EventProcessor } from "../src/core/event-processor.js";
import type {
  AgentRequest,
  AgentResponse,
  AppEvent,
  LiveEvent,
} from "../src/domain/types.js";
import {
  Application,
  createCoreApplication,
  RESTART_EXIT_CODE,
  RuntimeScheduler,
  type ApplicationServices,
  type RuntimeEventBus,
  type RuntimeEventProcessor,
  type RuntimeClock,
  type RuntimeLogger,
} from "../src/runtime/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Application lifecycle", () => {
  it("starts dependencies in order and tears them down in exact reverse order", async () => {
    const { config } = await temporaryConfig(baseConfig());
    const calls: string[] = [];
    const executor = fakeExecutor(calls);
    const speech = fakeSpeech(calls);
    const processor = fakeProcessor(calls);
    const automation = {
      async start(): Promise<void> {
        calls.push("automation:start");
      },
      async stop(): Promise<void> {
        calls.push("automation:stop");
      },
    };
    const platform: EventSource = {
      name: "fake",
      async start(): Promise<void> {
        calls.push("platform:start");
      },
      async dispose(): Promise<void> {
        calls.push("platform:stop");
      },
    };
    const server = {
      async start(): Promise<void> {
        calls.push("server:start");
      },
      async close(): Promise<void> {
        calls.push("server:stop");
      },
    };
    const manualInput = {
      async start(): Promise<void> {
        calls.push("manual:start");
      },
      async stop(): Promise<void> {
        calls.push("manual:stop");
      },
    };
    const application = new Application({
      services: services(config, executor, speech, processor, {
        automation,
        platform,
        server,
        manualInput,
      }),
    });

    await application.start();
    await application.stop();

    expect(calls).toEqual([
      "automation:start",
      "platform:start",
      "server:start",
      "manual:start",
      "manual:stop",
      "server:stop",
      "platform:stop",
      "automation:stop",
      "processor:stop",
      "speech:stop",
      "agent:stop",
    ]);
  });

  it("propagates a fatal startup error after rolling back every acquired component", async () => {
    const { config } = await temporaryConfig(baseConfig());
    const calls: string[] = [];
    const fatal = new Error("port unavailable");
    const application = new Application({
      services: services(
        config,
        fakeExecutor(calls),
        fakeSpeech(calls),
        fakeProcessor(calls),
        {
          automation: {
            async start(): Promise<void> {
              calls.push("automation:start");
            },
            async stop(): Promise<void> {
              calls.push("automation:stop");
            },
          },
          platform: {
            name: "fake",
            async start(): Promise<void> {
              calls.push("platform:start");
            },
            async dispose(): Promise<void> {
              calls.push("platform:stop");
            },
          },
          server: {
            async start(): Promise<void> {
              calls.push("server:start");
              throw fatal;
            },
            async close(): Promise<void> {
              calls.push("server:stop");
            },
          },
        },
      ),
    });

    await expect(application.start()).rejects.toBe(fatal);
    expect(calls).toEqual([
      "automation:start",
      "platform:start",
      "server:start",
      "server:stop",
      "platform:stop",
      "automation:stop",
      "processor:stop",
      "speech:stop",
      "agent:stop",
    ]);
    expect(application.status().state).toBe("failed");
  });

  it("routes a credential-free manual reread through the composed processor", async () => {
    const { config } = await temporaryConfig(baseConfig());
    const observed: LiveEvent[] = [];
    const processor: RuntimeEventProcessor = {
      async process(event) {
        observed.push(event);
        return { event, text: event.content, source: "reread" };
      },
    };
    const application = new Application({
      services: services(
        config,
        fakeExecutor([]),
        fakeSpeech([]),
        processor,
      ),
      now: () => 123,
    });

    await application.start();
    await expect(
      application.submitManual({
        content: "smoke test",
        metadata: { chatType: "reread" },
      }),
    ).resolves.toMatchObject({ text: "smoke test", source: "reread" });
    await application.stop();

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      type: "talk",
      platform: "stdin",
      username: "manual",
      content: "smoke test",
      timestamp: 123,
      metadata: { chatType: "reread", source: "manual" },
    });
  });

  it("reloads and atomically restores configuration while lifecycle hooks stay serialized", async () => {
    const initial = baseConfig();
    const { config, path } = await temporaryConfig(initial);
    const calls: string[] = [];
    const application = new Application({
      services: services(
        config,
        fakeExecutor(calls),
        fakeSpeech(calls),
        fakeProcessor(calls),
      ),
      plugins: [
        {
          name: "reload-observer",
          async reload(context): Promise<void> {
            calls.push(`reload:${context.services.config.get<string>("marker")}`);
          },
        },
      ],
    });
    await application.start();

    await writeFile(path, JSON.stringify({ ...initial, marker: "changed" }));
    await application.reload();
    await writeFile(
      `${path}.bak`,
      JSON.stringify({ ...initial, marker: "factory" }),
    );
    await application.restore();

    expect(config.get("marker")).toBe("factory");
    expect(calls).toContain("reload:changed");
    expect(calls).toContain("reload:factory");
    await application.stop();
  });

  it("refreshes the live processor's badword cache during application reload", async () => {
    const initial = {
      ...baseConfig(),
      filter: {
        badwords: {
          enable: true,
          discard: false,
          path: "badwords.txt",
          replace: "*",
        },
      },
    };
    const { config, path } = await temporaryConfig(initial);
    await writeFile(join(path, "..", "badwords.txt"), "old\n");
    const processor = new EventProcessor({
      config,
      executor: fakeExecutor([]),
      publisher: fakePublisher(),
    });
    const application = new Application({
      services: services(
        config,
        fakeExecutor([]),
        fakeSpeech([]),
        processor,
      ),
    });
    await application.start();

    await expect(
      application.processEvent({ ...testEvent("old-word"), content: "old" }),
    ).resolves.toMatchObject({ text: "*" });
    await writeFile(join(path, "..", "badwords.txt"), "new\n");
    await application.reload();

    await expect(
      application.processEvent({ ...testEvent("removed-word"), content: "old" }),
    ).resolves.toMatchObject({ text: "old" });
    await expect(
      application.processEvent({ ...testEvent("added-word"), content: "new" }),
    ).resolves.toMatchObject({ text: "*" });
    await application.stop();
  });

  it("requests an external restart only after graceful reverse teardown", async () => {
    const { config } = await temporaryConfig(baseConfig());
    const calls: string[] = [];
    const application = new Application({
      services: services(
        config,
        fakeExecutor(calls),
        fakeSpeech(calls),
        fakeProcessor(calls),
      ),
    });
    await application.start();

    await application.requestRestart();

    expect(application.requestedExitCode).toBe(RESTART_EXIT_CODE);
    expect(application.status()).toMatchObject({
      state: "stopped",
      restartRequested: true,
    });
    expect(calls).toEqual(["processor:stop", "speech:stop", "agent:stop"]);
  });
  it("drains admitted events and rejects new events before plugin reload", async () => {
    const { config } = await temporaryConfig(baseConfig());
    const entered = deferred<void>();
    const release = deferred<void>();
    const reloads: string[] = [];
    const processor: RuntimeEventProcessor = {
      async process(): Promise<undefined> {
        entered.resolve();
        await release.promise;
        return undefined;
      },
    };
    const application = new Application({
      services: services(
        config,
        fakeExecutor([]),
        fakeSpeech([]),
        processor,
      ),
      plugins: [
        {
          name: "reload-observer",
          reload(context) {
            reloads.push(
              context.services.config.get<string>("marker") ?? "initial",
            );
          },
        },
      ],
    });
    await application.start();

    const admitted = application.processEvent(testEvent("admitted"));
    await entered.promise;
    const reload = application.reload();
    const rejected = application.processEvent(testEvent("rejected"));
    await Promise.resolve();

    expect(application.status().state).toBe("reloading");
    await expect(rejected).rejects.toThrow("Cannot process an event");
    expect(reloads).toEqual([]);

    release.resolve();
    await admitted;
    await reload;
    expect(reloads).toEqual(["initial"]);
    await application.stop();
  });

  it("compensates every reloadable plugin and restores disk after a late failure", async () => {
    const initial = { ...baseConfig(), marker: "old" };
    const { config, path } = await temporaryConfig(initial);
    const active = { first: "old", late: "old" };
    const calls: string[] = [];
    const failure = new Error("late reload failed");
    const application = new Application({
      services: services(
        config,
        fakeExecutor([]),
        fakeSpeech([]),
        fakeProcessor([]),
      ),
      plugins: [
        {
          name: "first",
          reload(context) {
            active.first = context.services.config.get<string>("marker")!;
            calls.push(`first:${active.first}`);
          },
        },
        {
          name: "late",
          reload(context) {
            active.late = context.services.config.get<string>("marker")!;
            calls.push(`late:${active.late}`);
            if (active.late === "new") {
              throw failure;
            }
          },
        },
      ],
    });
    await application.start();
    await writeFile(path, JSON.stringify({ ...initial, marker: "new" }));

    await expect(application.reload()).rejects.toBe(failure);

    expect(config.get("marker")).toBe("old");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      marker: "old",
    });
    expect(active).toEqual({ first: "old", late: "old" });
    expect(calls).toEqual([
      "first:new",
      "late:new",
      "first:old",
      "late:old",
    ]);
    expect(application.status().state).toBe("running");
    await application.stop();
  });

  it("restores memory and compensates components when persistence rollback fails", async () => {
    const initial = { ...baseConfig(), marker: "old" };
    const { config, path } = await temporaryConfig(initial);
    const rollbackFailure = new Error("rollback save failed");
    const originalSave = config.save.bind(config);
    Object.defineProperty(config, "save", {
      configurable: true,
      value: async (next: JsonObject): Promise<void> => {
        if (next["marker"] === "old") {
          throw rollbackFailure;
        }
        await originalSave(next);
      },
    });
    let activeMarker = "old";
    const application = new Application({
      services: services(
        config,
        fakeExecutor([]),
        fakeSpeech([]),
        fakeProcessor([]),
      ),
      plugins: [
        {
          name: "late",
          reload(context) {
            activeMarker = context.services.config.get<string>("marker")!;
            if (activeMarker === "new") {
              throw new Error("candidate activation failed");
            }
          },
        },
      ],
    });
    await application.start();
    await writeFile(path, JSON.stringify({ ...initial, marker: "new" }));

    const failure = await application.reload().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toContain(rollbackFailure);
    expect(config.get("marker")).toBe("old");
    expect(activeMarker).toBe("old");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      marker: "new",
    });
    expect(application.status().state).toBe("failed");
    await application.stop();
  });

  it("stops a currently-starting plugin before and after its late start settles", async () => {
    const { config } = await temporaryConfig(baseConfig());
    const external = new AbortController();
    const entered = deferred<void>();
    const release = deferred<void>();
    const reason = new DOMException("shutdown", "AbortError");
    let stops = 0;
    const application = new Application({
      services: services(
        config,
        fakeExecutor([]),
        fakeSpeech([]),
        fakeProcessor([]),
      ),
      signal: external.signal,
      plugins: [
        {
          name: "blocking-start",
          async start(): Promise<void> {
            entered.resolve();
            await release.promise;
          },
          stop() {
            stops += 1;
            release.resolve();
          },
        },
      ],
    });

    const starting = application.start();
    await entered.promise;
    external.abort(reason);

    await expect(starting).rejects.toBe(reason);
    await application.stop();
    expect(stops).toBe(2);
    expect(application.status().state).toBe("stopped");
  });

  it("closes a composed default server when a later factory fails", async () => {
    const { config } = await temporaryConfig(baseConfig());
    let unsubscribeCount = 0;
    const listeners = new Set<(event: AppEvent) => void>();
    const publisher: RuntimeEventBus = {
      publish(event) {
        for (const listener of listeners) {
          listener(event);
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          if (listeners.delete(listener)) {
            unsubscribeCount += 1;
          }
        };
      },
    };
    const factoryFailure = new Error("manual input factory failed");

    await expect(
      createCoreApplication({
        stdin: true,
        platform: false,
        services: {
          config,
          publisher,
          logger: fakeLogger(),
          executor: fakeExecutor([]),
          speech: fakeSpeech([]),
          processor: fakeProcessor([]),
          automation: null,
        },
        factories: {
          manualInput: async () => {
            throw factoryFailure;
          },
        },
      }),
    ).rejects.toBe(factoryFailure);

    expect(unsubscribeCount).toBe(1);
    expect(listeners.size).toBe(0);
  });

  it("cleans a failed replacement executor and recreates the old generation", async () => {
    const initial = { ...baseConfig(), marker: "old" };
    const { config, path } = await temporaryConfig(initial);
    const resetCalls: string[] = [];
    const created: string[] = [];
    const resetFailure = new Error("old executor reset failed");
    let oldSequence = 0;
    let newSequence = 0;
    let initialResetAttempts = 0;
    const application = await createCoreApplication({
      server: false,
      stdin: false,
      platform: false,
      services: {
        config,
        publisher: fakePublisher(),
        logger: fakeLogger(),
        speech: fakeSpeech([]),
        processor: fakeProcessor([]),
        automation: null,
      },
      factories: {
        executor(context) {
          const snapshot = context.components["config"] as JsonObject;
          const marker = String(snapshot["marker"]);
          const id =
            marker === "old"
              ? `old-${++oldSequence}`
              : `new-${++newSequence}`;
          created.push(id);
          return {
            async execute(request): Promise<AgentResponse> {
              return {
                text: request.content,
                model: id,
                provider: "fake",
              };
            },
            async *stream(request): AsyncIterable<string> {
              yield request.content;
            },
            async reset(): Promise<void> {
              resetCalls.push(id);
              if (id === "old-1" && initialResetAttempts++ === 0) {
                throw resetFailure;
              }
            },
          };
        },
      },
    });
    await application.start();
    await writeFile(path, JSON.stringify({ ...initial, marker: "new" }));

    await expect(application.reload()).rejects.toBe(resetFailure);
    const response = await application.services.executor.execute({
      sessionId: "replacement",
      username: "tester",
      content: "still old",
      metadata: {},
    });

    expect(created).toEqual(["old-1", "new-1", "old-2"]);
    expect(resetCalls).toEqual(["old-1", "new-1", "old-1"]);
    expect(response.model).toBe("old-2");
    expect(config.get("marker")).toBe("old");
    await application.stop();
  });
  it("preserves an invalid user-edited config file when candidate parsing fails", async () => {
    const initial = { ...baseConfig(), marker: "old" };
    const { config, path } = await temporaryConfig(initial);
    let reloadCalls = 0;
    const application = new Application({
      services: services(
        config,
        fakeExecutor([]),
        fakeSpeech([]),
        fakeProcessor([]),
      ),
      plugins: [
        {
          name: "observer",
          reload() {
            reloadCalls += 1;
          },
        },
      ],
    });
    await application.start();
    await writeFile(path, "{ invalid json");

    await expect(application.reload()).rejects.toBeInstanceOf(SyntaxError);

    expect(config.get("marker")).toBe("old");
    expect(await readFile(path, "utf8")).toBe("{ invalid json");
    expect(reloadCalls).toBe(0);
    expect(application.status().state).toBe("running");
    await application.stop();
  });

});

describe("RuntimeScheduler", () => {
  it("serializes simultaneous schedules and leaves no live timer after stop", async () => {
    const configValue = {
      ...baseConfig(),
      agent: { mode: "llm" },
      schedule: [
        { id: "first", name: "First task", enable: true, run_on_start: false, interval: { mode: "fixed", every: 0.002, unit: "seconds" }, prompts: ["one"] },
        { id: "second", name: "Second task", enable: true, run_on_start: false, interval: { mode: "fixed", every: 0.002, unit: "seconds" }, prompts: ["two"] },
      ],
    };
    const { config } = await temporaryConfig(configValue);
    let active = 0;
    let maximumActive = 0;
    const events: LiveEvent[] = [];
    let completed = 0;
    const scheduler = new RuntimeScheduler({
      config,
      processor: {
        async process(event, options): Promise<undefined> {
          events.push(event);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await abortableDelay(8, options?.signal);
          active -= 1;
          completed += 1;
          return undefined;
        },
      },
      random: () => 0,
    });

    vi.useFakeTimers();
    try {
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(45);
      await scheduler.stop();
      const completedAtStop = completed;
      await vi.advanceTimersByTimeAsync(15);
      expect(maximumActive).toBe(1);
      expect(events.map(event => event.content)).toEqual(expect.arrayContaining(["one", "two"]));
      expect(completed).toBe(completedAtStop);
      expect(scheduler.status()).toMatchObject({ running: false, taskCount: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("applies playback backlog callbacks to the current idle cycle", async () => {
    const { config } = await temporaryConfig({
      ...baseConfig(),
      idle_time_task: {
        enable: true,
        type: "直播间无消息更新闲时",
        idle_time_min: 30,
        idle_time_max: 30,
        wait_play_audio_num_threshold: 2,
        idle_time_reduce_to: 30,
        trigger_type: [],
        copywriting: {
          enable: true,
          random: false,
          copy: ["backlog idle"],
        },
        comment: { enable: false },
      },
    });
    const waits: Array<{
      readonly milliseconds: number;
      release(): void;
    }> = [];
    const clock: RuntimeClock = {
      now: () => 0,
      sleep(milliseconds, signal) {
        return new Promise<void>((resolveSleep, rejectSleep) => {
          const onAbort = (): void => {
            signal.removeEventListener("abort", onAbort);
            rejectSleep(
              signal.reason ?? new DOMException("Aborted", "AbortError"),
            );
          };
          signal.addEventListener("abort", onAbort, { once: true });
          waits.push({
            milliseconds,
            release() {
              signal.removeEventListener("abort", onAbort);
              resolveSleep();
            },
          });
        });
      },
    };
    const observed = deferred<LiveEvent>();
    let dispatchCount = 0;
    const scheduler = new RuntimeScheduler({
      config,
      clock,
      random: () => 0,
      processor: {
        async process(event): Promise<undefined> {
          dispatchCount += 1;
          observed.resolve(event);
          return undefined;
        },
      },
    });

    await scheduler.start();
    expect(waits[0]?.milliseconds).toBe(1_000);
    scheduler.notePlaybackQueue(2);
    waits.shift()?.release();
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    expect(dispatchCount).toBe(0);
    expect(waits[0]?.milliseconds).toBe(1_000);

    scheduler.notePlaybackQueue(3);
    waits.shift()?.release();
    const event = await observed.promise;
    await scheduler.stop();

    expect(event).toMatchObject({
      type: "idle",
      content: "backlog idle",
      metadata: { idleMode: "copywriting", source: "idle_time_task" },
    });
  });

  it("shares strict enabled idle validation with scheduler startup", async () => {
    const valid = {
      enable: true,
      type: "直播间无消息更新闲时",
      idle_time_min: 1,
      idle_time_max: MAX_TIMER_DELAY_MS / 1_000,
      idle_time_reduce_to: 0,
      wait_play_audio_num_threshold: 0,
      min_msg_queue_len_to_trigger: 0,
      min_audio_queue_len_to_trigger: 0,
      trigger_type: [],
      copywriting: { enable: true, random: false, copy: ["ready"] },
      comment: { enable: false },
    };
    expect(() => validateIdleConfig(valid)).not.toThrow();
    expect(() =>
      validateIdleConfig({ ...valid, idle_time_max: MAX_TIMER_DELAY_MS / 1_000 + 1 }),
    ).toThrow(IdleConfigurationError);
    expect(() =>
      validateIdleConfig({ ...valid, copywriting: { enable: true, random: false, copy: [] } }),
    ).toThrow(IdleConfigurationError);
    expect(() => validateIdleConfig({ enable: false, copywriting: { enable: true } })).not.toThrow();
    expect(() => validateIdleConfig(undefined)).not.toThrow();
    expect(() =>
      validateIdleConfig({
        enable: true,
        copywriting: { enable: true, copy: ["minimal"] },
      }),
    ).not.toThrow();

    const { config } = await temporaryConfig({
      ...baseConfig(),
      idle_time_task: { ...valid, idle_time_min: 2, idle_time_max: 1 },
    });
    const scheduler = new RuntimeScheduler({ config, processor: fakeProcessor([]) });
    await expect(scheduler.start()).rejects.toBeInstanceOf(IdleConfigurationError);
  });



  it("removes settled scheduler loops while retaining failure details", async () => {
    const { config } = await temporaryConfig({
      ...baseConfig(),
      agent: { mode: "llm" },
      schedule: [
        {
          id: "settled",
          name: "Settled task",
          enable: true,
          run_on_start: true,
          interval: { mode: "fixed", every: 1, unit: "seconds" },
          prompts: ["scheduled"],
        },
      ],
    });
    const settledScheduler = new RuntimeScheduler({
      config,
      processor: fakeProcessor([]),
      clock: {
        now: () => 0,
        sleep: async () => {
          throw new DOMException("Synthetic completion", "AbortError");
        },
      },
    });

    await settledScheduler.start();
    try {
      await expect.poll(() => settledScheduler.status().taskCount).toBe(0);
      expect(settledScheduler.status()).toMatchObject({
        running: false,
        taskCount: 0,
        failures: [],
      });
    } finally {
      await settledScheduler.stop();
    }

    const failedScheduler = new RuntimeScheduler({
      config,
      processor: {
        async process(): Promise<undefined> {
          throw new Error("scheduled processor failed");
        },
      },
    });

    await failedScheduler.start();
    try {
      await expect.poll(() => failedScheduler.status().taskCount).toBe(0);
      expect(failedScheduler.status()).toMatchObject({
        running: false,
        taskCount: 0,
        failures: [
          {
            task: "schedule:settled",
            message: "scheduled processor failed",
          },
        ],
      });
    } finally {
      await failedScheduler.stop();
    }
  });
});

function services(
  config: ConfigStore,
  executor: AgentExecutor,
  speech: SpeechService,
  processor: RuntimeEventProcessor,
  optional: Partial<
    Pick<
      ApplicationServices,
      "automation" | "platform" | "server" | "manualInput"
    >
  > = {},
): ApplicationServices {
  return {
    config,
    publisher: fakePublisher(),
    logger: fakeLogger(),
    executor,
    speech,
    processor,
    ...optional,
  };
}

function fakeExecutor(calls: string[]): AgentExecutor {
  return {
    async execute(request: AgentRequest): Promise<AgentResponse> {
      return {
        text: request.content,
        model: "fake",
        provider: "fake",
      };
    },
    async *stream(request: AgentRequest): AsyncIterable<string> {
      yield request.content;
    },
    async reset(): Promise<void> {
      calls.push("agent:stop");
    },
  };
}

function fakeSpeech(calls: string[]): SpeechService {
  return {
    async enqueue(): Promise<string> {
      return "speech-id";
    },
    async enqueueAudio(): Promise<string> {
      return "speech-id";
    },
    async stop(): Promise<void> {
      return undefined;
    },
    status() {
      return { state: "idle", queued: 0 };
    },
    async dispose(): Promise<void> {
      calls.push("speech:stop");
    },
  };
}

function fakeProcessor(calls: string[]): RuntimeEventProcessor {
  return {
    async process(): Promise<undefined> {
      return undefined;
    },
    async dispose(): Promise<void> {
      calls.push("processor:stop");
    },
  };
}

function fakePublisher(): RuntimeEventBus {
  return {
    publish(_event: AppEvent): void {
      return undefined;
    },
  };
}

function fakeLogger(): RuntimeLogger {
  return {
    debug(): void {
      return undefined;
    },
    info(): void {
      return undefined;
    },
    warn(): void {
      return undefined;
    },
    error(): void {
      return undefined;
    },
  };
}

function baseConfig(): JsonObject {
  return {
    platform: "talk",
    agent: { mode: "reread" },
    schedule: [],
    idle_time_task: { enable: false },
    image_recognition: { enable: false },
  };
}

async function temporaryConfig(
  value: JsonObject,
): Promise<{ config: ConfigStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ai-vtuber-runtime-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(value));
  return { config: await ConfigStore.load(path), path };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function testEvent(id: string): LiveEvent {
  return {
    id,
    type: "comment",
    platform: "test",
    username: "tester",
    content: id,
    timestamp: 1,
    metadata: {},
  };
}

function blockingClock(sleeps: number[]): RuntimeClock {
  return {
    now: () => 0,
    sleep(milliseconds, signal) {
      sleeps.push(milliseconds);
      if (signal.aborted) {
        return Promise.reject(
          signal.reason ?? new DOMException("Aborted", "AbortError"),
        );
      }
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    },
  };
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(signal.reason);
      return;
    }
    const timer = setTimeout(resolvePromise, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        rejectPromise(signal.reason);
      },
      { once: true },
    );
  });
}
