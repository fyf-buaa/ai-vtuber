import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiAgentExecutorOptions } from "../src/agent/index.js";

import type {
  AgentExecutor,
  SpeechService,
} from "../src/core/contracts.js";
import type { JsonObject } from "../src/config/config-store.js";
import type {
  AgentRequest,
  AgentResponse,
  LiveEvent,
  SpeechRequest,
} from "../src/domain/types.js";
import {
  createPinnedContentFetch,
  type ContentFetchContext,
} from "../src/features/content/index.js";
import type { SqliteRepository } from "../src/persistence/index.js";
import { createApplication } from "../src/runtime/index.js";
import type { OperatorAnalyticsService } from "../src/server/index.js";

interface AnalyticsExtension {
  readonly commentWordFrequency: OperatorAnalyticsService["commentWordFrequency"];
}

function isAnalyticsExtension(value: unknown): value is AnalyticsExtension {
  return (
    typeof value === "object" &&
    value !== null &&
    "commentWordFrequency" in value &&
    typeof value.commentWordFrequency === "function"
  );
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("full application composition", () => {


  it("boots the exported default composition and performs a no-network reread", async () => {
    const { directory, path } = await temporaryConfig(baseConfig());
    const networkRequests: string[] = [];
    let speechDisposed = 0;
    const application = await createApplication({
      configPath: path,
      cwd: directory,
      stdin: false,
      server: false,
      platform: false,
      services: {
        speech: quietSpeech(() => {
          speechDisposed += 1;
        }),
      },
      features: {
        fetch: async (input) => {
          networkRequests.push(String(input));
          throw new Error("unexpected network request");
        },
      },
    });

    await application.start();
    const reply = await application.submitManual({
      content: "完整运行时复读",
      metadata: { speak: false },
    });

    expect(reply).toMatchObject({
      text: "完整运行时复读",
      source: "reread",
    });
    expect(application.status().components["features"]).toMatchObject({
      state: "running",
      generation: 1,
      database: { enabled: false },
      analytics: { enabled: false },
      ums: { enabled: false, state: "disabled" },
    });
    await application.stop();
    expect(networkRequests).toEqual([]);
    expect(speechDisposed).toBe(1);
  });

  it("applies info_to_callback internally with an operator token instead of calling the authenticated callback endpoint", async () => {
    const { directory, path } = await temporaryConfig({
      ...baseConfig(),
      play_audio: { info_to_callback: true },
      webui: { auth_token: "operator-test-token", ip: "127.0.0.1", port: 0 },
    });
    const requests: string[] = [];
    const playbackQueues: number[] = [];
    const application = await createApplication({
      configPath: path,
      cwd: directory,
      stdin: false,
      services: {
        speech: quietSpeech(),
        automation: {
          start() {},
          stop() {},
          notePlaybackQueue(waitPlayAudio) {
            playbackQueues.push(waitPlayAudio);
          },
        },
      },
      features: {
        fetch: async (input) => {
          requests.push(String(input));
          throw new Error("playback status must not use HTTP");
        },
      },
    });
    await application.start();
    try {
      const request: SpeechRequest = { text: "completed speech" };
      application.services.publisher.publish({
        type: "speech.queued",
        speechId: "callback-speech",
        request,
        timestamp: 1,
      });
      application.services.publisher.publish({
        type: "speech.completed",
        speechId: "callback-speech",
        request,
        timestamp: 2,
      });
      await vi.waitFor(() => expect(playbackQueues).toEqual([0]));
      expect(requests).toEqual([]);
    } finally {
      await application.stop();
    }
  });

  it("admits operator events through application activity and reload draining", async () => {
    const { directory, path } = await temporaryConfig({
      ...baseConfig(),
      webui: { ip: "127.0.0.1", port: 0 },
    });
    const processorEntered = deferred<void>();
    const processorRelease = deferred<void>();
    const activities: LiveEvent[] = [];
    let processorSignal: AbortSignal | undefined;
    let operatorPort: number | undefined;
    const application = await createApplication({
      configPath: path,
      cwd: directory,
      stdin: false,
      platform: false,
      services: {
        executor: quietExecutor("primary"),
        speech: quietSpeech(),
        processor: {
          async process(event, options) {
            processorSignal = options?.signal;
            processorEntered.resolve();
            await processorRelease.promise;
            return undefined;
          },
        },
        automation: {
          start() {
            return undefined;
          },
          stop() {
            return undefined;
          },
          noteActivity(event) {
            activities.push(event);
          },
        },
      },
    });
    if (application.services.publisher.subscribe === undefined) {
      throw new Error("Expected the full application event bus");
    }
    const unsubscribe = application.services.publisher.subscribe((event) => {
      const port = event.type === "system.status" &&
          event.component === "operator-server" &&
          event.status === "ready"
        ? event.metadata?.["port"]
        : undefined;
      if (typeof port === "number") {
        operatorPort = port;
      }
    });

    await application.start();
    try {
      if (operatorPort === undefined) {
        throw new Error("Expected the operator server ready port");
      }
      const responsePromise = fetch(
        `http://127.0.0.1:${String(operatorPort)}/api/events/manual`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "comment",
            platform: "operator-test",
            username: "operator",
            content: "admitted operator event",
          }),
        },
      );
      await processorEntered.promise;

      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        type: "comment",
        platform: "operator-test",
        content: "admitted operator event",
      });
      expect(processorSignal).toBeInstanceOf(AbortSignal);
      expect(processorSignal?.aborted).toBe(false);

      let reloadSettled = false;
      const reload = application.reload().then(() => {
        reloadSettled = true;
      });
      await vi.waitFor(() => {
        expect(application.status().state).toBe("reloading");
      });
      expect(reloadSettled).toBe(false);

      processorRelease.resolve();
      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        accepted: true,
        processed: false,
      });
      await reload;
      expect(reloadSettled).toBe(true);
    } finally {
      processorRelease.resolve();
      unsubscribe();
      await application.stop();
    }
  });

  it("routes images to a dedicated Pi visual fallback without exposing Agent tools", async () => {
    const { directory, path } = await temporaryConfig(
      enabledImageConfig("initial"),
    );
    const dataUrl = `data:image/png;base64,${Buffer.from("image").toString("base64")}`;
    const primary = new RecordingExecutor("primary");
    const image = new RecordingExecutor("image");
    const textModels = { kind: "text-models" } as unknown as NonNullable<
      PiAgentExecutorOptions["models"]
    >;
    const textModel = {
      input: ["text"],
    } as unknown as NonNullable<PiAgentExecutorOptions["model"]>;
    const textStreamFn = vi.fn() as unknown as NonNullable<
      PiAgentExecutorOptions["streamFn"]
    >;
    const textToolsForSession = vi.fn(() => []);
    let receivedConfig: JsonObject | undefined;
    let receivedOptions: PiAgentExecutorOptions | undefined;
    const application = await createApplication({
      configPath: path,
      cwd: directory,
      stdin: false,
      server: false,
      platform: false,
      services: {
        executor: primary,
        speech: quietSpeech(),
      },
      features: {
        pi: {
          models: textModels,
          model: textModel,
          streamFn: textStreamFn,
          maxSessions: 99,
          localImageRoots: [directory],
          maxImageBytes: 1_024,
          tools: [{} as never],
          toolsForSession: textToolsForSession,
        },
        createImageExecutor(config, options) {
          receivedConfig = config;
          receivedOptions = options;
          return image;
        },
      },
    });

    await application.start();
    try {
      await application.services.processor.process(
        imageEvent("isolated-image", dataUrl),
      );
      expect(image.requests).toHaveLength(1);
      expect(image.requests[0]).toMatchObject({
        content: "describe this frame",
        images: [dataUrl],
        metadata: {
          eventId: "isolated-image",
          eventType: "image",
          chatType: "image_recognition_schedule",
        },
      });
      expect(primary.requests).toEqual([]);

      await application.services.processor.process({
        ...comment("ordinary-comment", "ordinary chat"),
        metadata: { speak: false, chatType: "agent" },
      });
      expect(primary.requests).toHaveLength(1);
      expect(primary.requests[0]).toMatchObject({
        content: "ordinary chat",
        metadata: {
          eventId: "ordinary-comment",
          eventType: "comment",
          chatType: "agent",
        },
      });
      expect(image.requests).toHaveLength(1);

      expect(receivedConfig).toMatchObject({
        marker: "initial",
        agent: {
          provider: "openai-compatible",
          model: "text-only-main",
        },
        image_recognition: {
          enable: true,
          provider: "google",
          model: "gemini-2.5-flash",
        },
      });
      expect(receivedOptions?.publisher).toBe(application.services.publisher);
      expect(receivedOptions?.models).toBe(textModels);
      expect(receivedOptions?.model).toBe(textModel);
      expect(receivedOptions?.streamFn).toBe(textStreamFn);
      expect(receivedOptions?.maxSessions).toBe(99);
      expect(receivedOptions?.localImageRoots).toEqual([directory]);
      expect(receivedOptions?.maxImageBytes).toBe(1_024);
      expect(receivedOptions).not.toHaveProperty("tools");
      expect(receivedOptions).not.toHaveProperty("toolsForSession");
      expect(textToolsForSession).not.toHaveBeenCalled();
    } finally {
      await application.stop();
    }
  });

  it("keeps disabled image recognition lazy and routes image events to the primary executor", async () => {
    const { directory, path } = await temporaryConfig({
      ...baseConfig(),
      image_recognition: { enable: false },
    });
    const primary = new RecordingExecutor("primary");
    const inactivePiOptions: PiAgentExecutorOptions = {};
    let optionReads = 0;
    Object.defineProperty(inactivePiOptions, "models", {
      enumerable: true,
      get() {
        optionReads += 1;
        throw new Error("disabled image options must stay unread");
      },
    });
    const createImageExecutor = vi.fn(() => {
      throw new Error("disabled image factory must not run");
    });
    const application = await createApplication({
      configPath: path,
      cwd: directory,
      stdin: false,
      server: false,
      platform: false,
      services: {
        executor: primary,
        speech: quietSpeech(),
      },
      features: {
        pi: inactivePiOptions,
        createImageExecutor,
      },
    });

    await application.start();
    try {
      const dataUrl = "data:image/png;base64,aW1hZ2U=";
      await application.services.processor.process(
        imageEvent("disabled-image", dataUrl),
      );
      expect(primary.requests).toHaveLength(1);
      expect(primary.requests[0]).toMatchObject({
        images: [dataUrl],
        metadata: {
          eventType: "image",
          chatType: "image_recognition_schedule",
        },
      });
      expect(createImageExecutor).not.toHaveBeenCalled();
      expect(optionReads).toBe(0);
    } finally {
      await application.stop();
    }
  });

  it("retires image executors on reload, preserves an external primary, and resets the current image on stop", async () => {
    const initial = enabledImageConfig("old");
    const { directory, path } = await temporaryConfig(initial);
    const primary = new RecordingExecutor("primary");
    const images: RecordingExecutor[] = [];
    const application = await createApplication({
      configPath: path,
      cwd: directory,
      stdin: false,
      server: false,
      platform: false,
      services: {
        executor: primary,
        speech: quietSpeech(),
      },
      features: {
        createImageExecutor(config) {
          const executor = new RecordingExecutor(
            `image-${String(config["marker"])}`,
          );
          images.push(executor);
          return executor;
        },
      },
    });

    await application.start();
    try {
      await application.services.processor.process(
        imageEvent("old-image", "data:image/png;base64,b2xk"),
      );
      expect(images).toHaveLength(1);
      expect(images[0]?.requests).toHaveLength(1);

      await writeFile(
        path,
        JSON.stringify(enabledImageConfig("new")),
      );
      await application.reload();

      expect(images).toHaveLength(2);
      expect(images[0]?.resetCalls).toEqual([undefined]);
      expect(primary.resetCalls).toEqual([]);
      await application.services.processor.process(
        imageEvent("new-image", "data:image/png;base64,bmV3"),
      );
      expect(images[0]?.requests).toHaveLength(1);
      expect(images[1]?.requests).toHaveLength(1);
    } finally {
      await application.stop();
    }

    expect(images[1]?.resetCalls).toEqual([undefined]);
    expect(primary.resetCalls).toEqual([undefined]);
  });

  it("rolls an invalid dedicated visual-model reload back to the working fallback", async () => {
    const initial = enabledImageConfig("working");
    const { directory, path } = await temporaryConfig(initial);
    const primary = new RecordingExecutor("primary");
    const vision = fauxProvider({
      provider: "google",
      models: [{ id: "gemini-2.5-flash", input: ["text", "image"] }],
      tokenSize: { min: 1, max: 1 },
    });
    vision.setResponses([
      () => fauxAssistantMessage("vision-before"),
      () => fauxAssistantMessage("vision-after"),
    ]);
    const models = createModels();
    models.setProvider(vision.provider);
    const pngDataUrl = `data:image/png;base64,${Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]).toString("base64")}`;
    const application = await createApplication({
      configPath: path,
      cwd: directory,
      stdin: false,
      server: false,
      platform: false,
      services: {
        executor: primary,
        speech: quietSpeech(),
      },
      features: {
        pi: { models },
      },
    });

    await application.start();
    try {
      await expect(
        application.services.processor.process(
          imageEvent("before-blip", pngDataUrl),
        ),
      ).resolves.toMatchObject({
        text: "vision-before",
        source: "agent",
      });
      const imageRecognition = initial["image_recognition"] as Record<
        string,
        unknown
      >;
      await writeFile(
        path,
        JSON.stringify({
          ...initial,
          marker: "broken",
          image_recognition: {
            ...imageRecognition,
            model: "missing-vision-model",
          },
        }),
      );

      await expect(application.reload()).rejects.toThrow(
        /Unknown model "missing-vision-model"/u,
      );
      expect(application.services.config.get("marker")).toBe("working");
      expect(primary.resetCalls).toEqual([]);
      await expect(
        application.services.processor.process(
          imageEvent("after-blip", pngDataUrl),
        ),
      ).resolves.toMatchObject({
        text: "vision-after",
        source: "agent",
      });
      expect(vision.state.callCount).toBe(2);
    } finally {
      await application.stop();
    }
  });

  it("resets both feature executors even when the primary reset fails", async () => {
    const { directory, path } = await temporaryConfig(
      enabledImageConfig("reset"),
    );
    const primary = new RecordingExecutor("primary", 1);
    const image = new RecordingExecutor("image");
    const application = await createApplication({
      configPath: path,
      cwd: directory,
      stdin: false,
      server: false,
      platform: false,
      services: {
        executor: primary,
        speech: quietSpeech(),
      },
      features: {
        createImageExecutor: () => image,
      },
    });

    await application.start();
    try {
      await expect(
        application.services.executor.reset("shared-session"),
      ).rejects.toBeInstanceOf(AggregateError);
      expect(primary.resetCalls).toEqual(["shared-session"]);
      expect(image.resetCalls).toEqual(["shared-session"]);
    } finally {
      await application.stop();
    }
  });

  it("resets an executor returned for both roles only once per cleanup", async () => {
    const initial = enabledImageConfig("shared-old");
    const { directory, path } = await temporaryConfig(initial);
    const shared = new RecordingExecutor("shared");
    const application = await createApplication({
      configPath: path,
      cwd: directory,
      stdin: false,
      server: false,
      platform: false,
      services: {
        executor: shared,
        speech: quietSpeech(),
      },
      features: {
        createImageExecutor: () => shared,
      },
    });

    await application.start();
    try {
      await writeFile(
        path,
        JSON.stringify(enabledImageConfig("shared-new")),
      );
      await application.reload();
      expect(shared.resetCalls).toEqual([undefined]);
    } finally {
      await application.stop();
    }
    expect(shared.resetCalls).toEqual([undefined, undefined]);
  });


  it("persists comments in enabled SQLite and exposes real analytics", async () => {
    const { directory, path } = await temporaryConfig({
      ...baseConfig(),
      database: {
        enable: true,
        path: "state.sqlite",
        comment_enable: true,
      },
    });
    const application = await createApplication({
      configPath: path,
      cwd: directory,
      stdin: false,
      server: false,
      platform: false,
      services: { speech: quietSpeech() },
    });
    await application.start();

    await application.processEvent(comment("one", "hello hello world"));
    await application.processEvent(comment("two", "hello runtime"));
    const analytics = application.services.extensions?.["analytics"];

    expect(isAnalyticsExtension(analytics)).toBe(true);
    if (!isAnalyticsExtension(analytics)) {
      throw new Error("Expected analytics extension");
    }
    expect(
      await Promise.resolve(analytics.commentWordFrequency({ limit: 3 })),
    ).toMatchObject({
      type: "commentWordFrequency",
      sampleSize: 2,
      items: [
        { name: "hello", value: 3 },
        { name: "runtime", value: 1 },
        { name: "world", value: 1 },
      ],
    });
    expect(application.status().components["features"]).toMatchObject({
      database: { enabled: true },
      analytics: { enabled: true },
    });
    await application.stop();
  });

  it("waits for a stable analytics bundle instead of using a retired repository", async () => {
    const initial = {
      ...baseConfig(),
      marker: "old",
      database: {
        enable: true,
        path: "old.sqlite",
        comment_enable: true,
      },
    };
    const { directory, path } = await temporaryConfig(initial);
    const candidateFactoryEntered = deferred<void>();
    const releaseCandidateFactory = deferred<void>();
    const disposedRepositories: string[] = [];
    const application = await createApplication({
      configPath: path,
      cwd: directory,
      stdin: false,
      server: false,
      platform: false,
      services: { speech: quietSpeech() },
      factories: {
        async executor(context) {
          const snapshot = context.components["config"] as JsonObject;
          if (snapshot["marker"] === "new") {
            candidateFactoryEntered.resolve();
            await releaseCandidateFactory.promise;
          }
          return quietExecutor(String(snapshot["marker"]));
        },
      },
      features: {
        createRepository: (repositoryPath) => ({
          path: repositoryPath,
          listRecentCommentContent() {
            return [
              repositoryPath.includes("new.sqlite")
                ? "newword newword"
                : "oldword oldword",
            ];
          },
          listIntegralRanking() {
            return [];
          },
          listGiftAggregates() {
            return [];
          },
          dispose() {
            disposedRepositories.push(repositoryPath);
          },
        }) as unknown as SqliteRepository,
      },
    });
    await application.start();
    const analytics = application.services.extensions?.["analytics"];
    expect(isAnalyticsExtension(analytics)).toBe(true);
    if (!isAnalyticsExtension(analytics)) {
      throw new Error("Expected analytics extension");
    }
    await writeFile(
      path,
      JSON.stringify({
        ...initial,
        marker: "new",
        database: {
          enable: true,
          path: "new.sqlite",
          comment_enable: true,
        },
      }),
    );

    const reload = application.reload();
    await candidateFactoryEntered.promise;
    let settled = false;
    const analyticsResult = Promise.resolve(
      analytics.commentWordFrequency({ limit: 1 }),
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCandidateFactory.resolve();

    await reload;
    await expect(analyticsResult).resolves.toMatchObject({
      items: [{ name: "newword", value: 2 }],
    });
    expect(disposedRepositories.some((value) => value.includes("old.sqlite")))
      .toBe(true);
    await application.stop();
  });


  it("lets Pi request web search as a tool, return sources, and enforce configured limits", async () => {
    const faux = fauxProvider({
      provider: "search-agent-faux",
      models: [{ id: "search-model" }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const { directory, path } = await temporaryConfig({
      ...baseConfig(),
      agent: { mode: "llm", provider: "search-agent-faux", model: "search-model", tools: true },
      search_online: {
        enable: true,
        provider: "tavily",
        api_key: "test-search-key",
        count: 1,
        endpoint: "https://1.1.1.1/search",
        https_proxy: "https://proxy.test:8443",
      },
    });
    const searches: string[] = [];
    let searchContext: ContentFetchContext | undefined;
    const contentFetch = createPinnedContentFetch(async (_url, init, context) => {
      searchContext = context;
      const body = JSON.parse(String(init.body)) as { query: string };
      searches.push(body.query);
      return Response.json({
        results: [{ title: "Source", url: "https://source.test/facts", content: "verified search evidence" }],
      });
    }, { pinsProxyRequests: true });
    faux.setResponses([
      (context) => {
        expect(searches).toEqual([]);
        const user = context.messages.at(-1);
        if (user?.role !== "user") throw new Error("Expected user input");
        const content = typeof user.content === "string" ? user.content
          : user.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        expect(content).toBe("联网你好");
        return fauxAssistantMessage("无需查询即可回答");
      },
      () => fauxAssistantMessage(
        fauxToolCall("online_search", { query: "recent facts", count: 1 }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const result = context.messages.at(-1);
        expect(result).toMatchObject({ role: "toolResult", toolName: "online_search", isError: false });
        if (result?.role !== "toolResult") throw new Error("Expected a Pi tool result");
        const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        expect(text).toContain("https://source.test/facts");
        expect(text).toContain("verified search evidence");
        return fauxAssistantMessage("已根据搜索资料回答");
      },
      () => fauxAssistantMessage(
        fauxToolCall("online_search", { query: "too many results", count: 2 }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "online_search", isError: true });
        return fauxAssistantMessage("请求超出搜索数量限制");
      },
    ]);
    const application = await createApplication({
      configPath: path, cwd: directory, stdin: false, server: false, platform: false,
      services: { speech: quietSpeech() },
      features: { contentFetch, pi: { models, model: faux.getModel() } },
    });
    await application.start();
    try {
      expect((await application.submitManual({ content: "联网你好", metadata: { speak: false } }))?.text).toBe("无需查询即可回答");
      expect(searches).toEqual([]);
      expect((await application.submitManual({ content: "最近有什么新消息", metadata: { speak: false } }))?.text).toBe("已根据搜索资料回答");
      expect(searches).toEqual(["recent facts"]);
      expect(searchContext?.proxyUrl).toBe("https://proxy.test:8443/");
      expect((await application.submitManual({ content: "再查一些", metadata: { speak: false } }))?.text).toBe("请求超出搜索数量限制");
      expect(searches).toEqual(["recent facts"]);
    } finally {
      await application.stop();
    }
  });

  it.each([
    { searchEnabled: false, toolsEnabled: true },
    { searchEnabled: true, toolsEnabled: false },
  ])("does not expose or execute disabled search (search=$searchEnabled, tools=$toolsEnabled)", async ({ searchEnabled, toolsEnabled }) => {
    const faux = fauxProvider({ provider: "search-gate-faux", models: [{ id: "search-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const { directory, path } = await temporaryConfig({
      ...baseConfig(),
      agent: { mode: "llm", provider: "search-gate-faux", model: "search-model", tools: toolsEnabled },
      search_online: { enable: searchEnabled, provider: "tavily", api_key: "test-search-key", count: 1 },
    });
    const searches: string[] = [];
    faux.setResponses([
      (context) => {
        expect(context.tools?.some(({ name }) => name === "online_search") ?? false).toBe(false);
        return fauxAssistantMessage(fauxToolCall("online_search", { query: "news" }), { stopReason: "toolUse" });
      },
      (context) => {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "online_search", isError: true });
        return fauxAssistantMessage("搜索工具不可用");
      },
    ]);
    const application = await createApplication({
      configPath: path, cwd: directory, stdin: false, server: false, platform: false,
      services: { speech: quietSpeech() },
      features: {
        pi: { models, model: faux.getModel() },
        contentFetch: createPinnedContentFetch(async (url) => {
          searches.push(url.href);
          throw new Error("Disabled search must not make requests");
        }),
      },
    });
    await application.start();
    try {
      expect((await application.submitManual({ content: "联网news", metadata: { speak: false } }))?.text).toBe("搜索工具不可用");
      expect(searches).toEqual([]);
    } finally {
      await application.stop();
    }
  });


});

function baseConfig(): Record<string, unknown> {
  return {
    platform: "talk",
    agent: { mode: "reread" },
    audio_synthesis_type: "none",
    schedule: [],
    idle_time_task: { enable: false },
    image_recognition: { enable: false },
    login: { enable: false },
  };
}

function enabledImageConfig(marker: string): Record<string, unknown> {
  return {
    ...baseConfig(),
    marker,
    agent: {
      mode: "reread",
      provider: "openai-compatible",
      model: "text-only-main",
      apiKey: "full-application-main-key-123456789",
      baseUrl: "https://main.example.test/v1",
      input: ["text"],
    },
    image_recognition: {
      enable: true,
      provider: "google",
      model: "gemini-2.5-flash",
      apiKey: "full-application-vision-key-123456789",
      prompt: "describe this frame",
    },
  };
}

function validWav(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const wav = Buffer.alloc(12 + body.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(4 + body.byteLength, 4);
  wav.write("WAVE", 8, "ascii");
  body.copy(wav, 12);
  return wav;
}


function quietSpeech(onDispose?: () => void): SpeechService {
  return {
    async enqueue(): Promise<string> {
      return "quiet-speech";
    },
    async enqueueAudio(): Promise<string> {
      return "quiet-speech";
    },
    async stop(): Promise<void> {
      return undefined;
    },
    status() {
      return { state: "idle", queued: 0 };
    },
    async dispose(): Promise<void> {
      onDispose?.();
    },
  };
}

function comment(id: string, content: string): LiveEvent {
  return {
    id,
    type: "comment",
    platform: "test",
    username: "viewer",
    content,
    timestamp: Date.now(),
    metadata: { speak: false },
  };
}

function imageEvent(id: string, dataUrl: string): LiveEvent {
  return {
    id,
    type: "image",
    platform: "test",
    username: "camera",
    content: "describe this frame",
    timestamp: Date.now(),
    metadata: {
      speak: false,
      images: [dataUrl],
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function quietExecutor(model: string): AgentExecutor {
  return {
    async execute(request): Promise<AgentResponse> {
      return { text: request.content, model, provider: "test" };
    },
    async *stream(request) {
      yield request.content;
    },
    async reset() {
      return undefined;
    },
  };
}

class RecordingExecutor implements AgentExecutor {
  readonly requests: AgentRequest[] = [];
  readonly resetCalls: Array<string | undefined> = [];

  constructor(
    readonly model: string,
    private resetFailures = 0,
  ) {}

  async execute(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(request);
    return {
      text: `${this.model}:${request.content}`,
      model: this.model,
      provider: "test",
    };
  }

  async *stream(request: AgentRequest): AsyncIterable<string> {
    this.requests.push(request);
    yield `${this.model}:${request.content}`;
  }

  async reset(sessionId?: string): Promise<void> {
    this.resetCalls.push(sessionId);
    if (this.resetFailures > 0) {
      this.resetFailures -= 1;
      throw new Error(`${this.model} reset failed`);
    }
  }
}




async function temporaryConfig(
  value: Record<string, unknown>,
): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ai-vtuber-full-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(value));
  return { directory, path };
}
