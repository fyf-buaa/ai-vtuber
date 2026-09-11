import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigGenerationConflictError,
  ConfigStore,
  type JsonObject,
} from "../src/config/config-store.js";
import type {
  AgentExecutor,
  SpeechService,
} from "../src/core/contracts.js";
import type { AgentRequest, AgentResponse } from "../src/domain/types.js";
import {
  Application,
  type ApplicationOptions,
  type ApplicationServices,
  type RuntimeEventProcessor,
} from "../src/runtime/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { force: true, recursive: true })
    ),
  );
});

describe("Application single-use lifecycle", () => {
  it("rejects restarting a stopped application instance", async () => {
    const { store } = await temporaryConfig({ marker: "initial" });
    const application = createApplication(store);

    await application.start();
    await application.stop();

    await expect(application.start()).rejects.toThrow(
      /single-use.*stopped/iu,
    );
  });

  it("rejects another start after the first start attempt fails", async () => {
    const { store } = await temporaryConfig({ marker: "initial" });
    const fatal = new Error("startup failed");
    let attempts = 0;
    const application = createApplication(store, {
      plugins: [{
        name: "failing-start",
        start() {
          attempts += 1;
          throw fatal;
        },
      }],
    });

    await expect(application.start()).rejects.toBe(fatal);
    await expect(application.start()).rejects.toThrow(
      /single-use.*failed/iu,
    );
    expect(attempts).toBe(1);
  });

  it("waits for delayed startup resource creation and performs a final stop", async () => {
    const { store } = await temporaryConfig({ marker: "initial" });
    const external = new AbortController();
    const entered = deferred();
    const releaseCreation = deferred();
    let resourceOpen = false;
    let stopCalls = 0;
    const application = createApplication(store, {
      signal: external.signal,
      plugins: [{
        name: "late-resource",
        order: 100,
        async start() {
          entered.resolve();
          await releaseCreation.promise;
          resourceOpen = true;
        },
        async stop() {
          stopCalls += 1;
          resourceOpen = false;
          releaseCreation.resolve();
        },
      }],
    });

    const starting = application.start();
    await entered.promise;
    external.abort(new DOMException("test abort", "AbortError"));

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(stopCalls).toBe(2);
    expect(resourceOpen).toBe(false);
    await application.stop();
  });
});

describe("Application configuration transactions", () => {
  it("serializes concurrent updates and rejects a stale generation", async () => {
    const { store } = await temporaryConfig({ marker: "initial" });
    const firstReloadEntered = deferred();
    const releaseFirstReload = deferred();
    const application = createApplication(store, {
      plugins: [{
        name: "blocking-reload",
        async reload(context) {
          if (context.services.config.get("marker") === "first") {
            firstReloadEntered.resolve();
            await releaseFirstReload.promise;
          }
        },
      }],
    });
    await application.start();

    const first = application.updateConfig({ marker: "first" }, 0);
    await firstReloadEntered.promise;
    const conflicting = application.updateConfig({ marker: "second" }, 0);
    releaseFirstReload.resolve();

    await expect(first).resolves.toBe(1);
    await expect(conflicting).rejects.toBeInstanceOf(
      ConfigGenerationConflictError,
    );
    expect(store.snapshot()).toEqual({ marker: "first" });
    expect(store.generation).toBe(1);
    await application.stop();
  });

  it("rolls back persisted config and invalidates the failed revision", async () => {
    const { store, path } = await temporaryConfig({ marker: "working" });
    const observed: string[] = [];
    const application = createApplication(store, {
      plugins: [{
        name: "validating-reload",
        reload(context) {
          const marker = context.services.config.get<string>("marker") ?? "";
          observed.push(marker);
          if (marker === "invalid") {
            throw new Error("plugin rejected config");
          }
        },
      }],
    });
    await application.start();

    await expect(
      application.updateConfig({ marker: "invalid" }, 0),
    ).rejects.toThrow("plugin rejected config");

    expect(store.snapshot()).toEqual({ marker: "working" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ marker: "working" });
    expect(store.generation).toBe(2);
    expect(observed).toEqual(["invalid", "working"]);
    await expect(
      application.updateConfig({ marker: "stale" }, 0),
    ).rejects.toBeInstanceOf(ConfigGenerationConflictError);
    await application.stop();
  });

  it("keeps the last-working snapshot but preserves an external bind edit on disk", async () => {
    const initial: JsonObject = {
      marker: "working",
      webui: { ip: "127.0.0.1", port: 8_081 },
    };
    const external: JsonObject = {
      marker: "external",
      webui: { ip: "127.0.0.1", port: 9_999 },
    };
    const { store, path } = await temporaryConfig(initial);
    let pluginReloads = 0;
    const application = createApplication(store, {
      plugins: [{
        name: "reload-observer",
        reload() {
          pluginReloads += 1;
        },
      }],
    });
    await application.start();
    await writeFile(path, JSON.stringify(external), "utf8");

    await expect(application.reload()).rejects.toThrow(/restart.*webui\.ip/iu);

    expect(store.snapshot()).toEqual(initial);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(external);
    expect(store.generation).toBe(2);
    expect(pluginReloads).toBe(0);
    await application.stop();
  });
});

function createApplication(
  config: ConfigStore,
  options: Omit<ApplicationOptions, "services"> = {},
): Application {
  return new Application({
    ...options,
    manageExecutorLifecycle: false,
    services: services(config),
  });
}

function services(config: ConfigStore): ApplicationServices {
  const executor: AgentExecutor = {
    async execute(request: AgentRequest): Promise<AgentResponse> {
      return {
        text: request.content,
        model: "test",
        provider: "test",
      };
    },
    async *stream(request: AgentRequest): AsyncIterable<string> {
      yield request.content;
    },
    async reset(): Promise<void> {
      return undefined;
    },
  };
  const speech: SpeechService = {
    async enqueue(): Promise<string> {
      return "speech";
    },
    async enqueueAudio(): Promise<string> {
      return "speech";
    },
    async stop(): Promise<void> {
      return undefined;
    },
    status() {
      return { state: "idle", queued: 0 };
    },
    async dispose(): Promise<void> {
      return undefined;
    },
  };
  const processor: RuntimeEventProcessor = {
    async process(): Promise<undefined> {
      return undefined;
    },
    async dispose(): Promise<void> {
      return undefined;
    },
  };
  return {
    config,
    executor,
    speech,
    processor,
    publisher: { publish() { return undefined; } },
    logger: {
      debug() { return undefined; },
      info() { return undefined; },
      warn() { return undefined; },
      error() { return undefined; },
    },
  };
}

async function temporaryConfig(
  config: JsonObject,
): Promise<{ readonly store: ConfigStore; readonly path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ai-vtuber-application-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config), "utf8");
  return { store: await ConfigStore.load(path), path };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  return Promise.withResolvers<void>();
}
