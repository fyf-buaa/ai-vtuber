import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigStore, type JsonObject } from "../src/config/config-store.js";
import { EventProcessorOverloadError } from "../src/core/event-processor.js";
import type {
  AppEvent,
  LiveEvent,
  SpeechRequest,
  SpeechState,
} from "../src/domain/types.js";
import { EventBus } from "../src/infrastructure/event-bus.js";
import {
  createOperatorServer,
  type EventSubmitter,
  type OperatorAnalyticsService,
  type OperatorRequestAuthorizer,
  type OperatorServer,
  type OperatorServerDependencies,
  type PlaybackCallback,
  type RuntimeControls,
} from "../src/server/index.js";

const servers: OperatorServer[] = [];
const temporaryDirectories: string[] = [];

type HarnessOptions = {
  readonly token?: string;
  readonly config?: JsonObject;
  readonly runtimeStatus?: unknown;
  readonly authorizeRequest?: OperatorRequestAuthorizer;
  readonly analytics?: OperatorAnalyticsService;
  readonly speechState?: SpeechState;
  readonly runtimeUpdateConfig?: boolean;
  readonly applicationRoot?: string;
  readonly webRoot?: string;
  readonly sseHistorySize?: number;
  readonly submitError?: Error;
  readonly edgeVoiceCatalog?: OperatorServerDependencies["edgeVoiceCatalog"];
  readonly avatar?: OperatorServerDependencies["avatar"];
  readonly now?: () => number;
};

type Harness = {
  readonly baseUrl: string;
  readonly configStore: ConfigStore;
  readonly submitted: LiveEvent[];
  readonly speechRequests: SpeechRequest[];
  readonly runtimeCalls: string[];
  readonly events: EventBus;
  readonly server: OperatorServer;
  readonly playbackCallbacks: PlaybackCallback[];
};

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "ai-vtuber-http-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "config.local.json");
  await writeFile(
    configPath,
    `${JSON.stringify(options.config ?? { webui: { ip: "127.0.0.1", port: 0 } }, null, 2)}\n`,
    "utf8",
  );
  const configStore = await ConfigStore.load(configPath);
  const submitted: LiveEvent[] = [];
  const speechRequests: SpeechRequest[] = [];
  const runtimeCalls: string[] = [];
  const playbackCallbacks: PlaybackCallback[] = [];
  const events = new EventBus();
  const eventSubmitter: EventSubmitter = {
    async submit(event) {
      if (options.submitError !== undefined) {
        throw options.submitError;
      }
      submitted.push(event);
      return {
        event,
        text: `已处理：${event.content}`,
        source: event.metadata["chatType"] === "reread" ? "reread" : "agent",
      };
    },
  };
  const runtime: RuntimeControls = {
    status() {
      return options.runtimeStatus ?? {
        state: "running",
        queue: { pending: 2 },
        agent: { state: "running" },
      };
    },
    async start() {
      runtimeCalls.push("start");
    },
    async stop() {
      runtimeCalls.push("stop");
    },
    async reload() {
      runtimeCalls.push("reload");
    },
    ...(options.runtimeUpdateConfig === true
      ? {
          async updateConfig(
            candidate: JsonObject,
            expectedGeneration: number,
          ): Promise<number> {
            runtimeCalls.push("updateConfig");
            await configStore.save(candidate, expectedGeneration);
            return configStore.generation;
          },
        }
      : {}),
    async restore() {
      runtimeCalls.push("restore");
    },
  };
  const server = createOperatorServer(
    {
      configStore,
      eventSubmitter,
      runtime,
      speech: {
        async enqueue(request) {
          speechRequests.push(request);
          return `speech-${speechRequests.length}`;
        },
        status() {
          return { state: options.speechState ?? "idle", queued: 3 };
        },
      },
      ...(options.authorizeRequest === undefined
        ? {}
        : { authorizeRequest: options.authorizeRequest }),
      ...(options.analytics === undefined
        ? {}
        : { analytics: options.analytics }),
      ...(options.edgeVoiceCatalog === undefined
        ? {}
        : { edgeVoiceCatalog: options.edgeVoiceCatalog }),
      ...(options.avatar === undefined ? {} : { avatar: options.avatar }),
      onPlaybackCallback(callback) {
        playbackCallbacks.push(callback);
      },
      events,
      env: options.token === undefined
        ? {}
        : { AI_VTUBER_OPERATOR_TOKEN: options.token },
      createId: (() => {
        let sequence = 0;
        return () => `http-event-${++sequence}`;
      })(),
      now: options.now ?? (() => 1_750_000_000_000),
    },
    {
      host: "127.0.0.1",
      port: 0,
      webRoot: options.webRoot ?? resolve(process.cwd(), "web"),
      applicationRoot: options.applicationRoot ?? directory,
      sseHeartbeatMs: 60_000,
      ...(options.sseHistorySize === undefined
        ? {}
        : { sseHistorySize: options.sseHistorySize }),
    },
  );
  servers.push(server);
  const address = await server.start();
  return {
    baseUrl: address.url,
    configStore,
    submitted,
    speechRequests,
    server,
    runtimeCalls,
    playbackCallbacks,
    events,
  };
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function json(response: Response): Promise<JsonObject> {
  return await response.json() as JsonObject;
}


afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("operator HTTP server", () => {
  it("scopes iframe authentication to avatar assets and expires signed grants", async () => {
    let now = 1_750_000_000_000;
    const avatarStatus = {
      enabled: true,
      modelName: "Hiyori",
      previewUrl: "/avatar/Live2D/",
      camera: {
        state: "stopped" as const, connected: false, deviceName: "OBS Virtual Camera",
        width: 1280, height: 720, fps: 30, sceneName: "AI Vtuber Live2D",
      },
    };
    const harness = await createHarness({
      token: "private-avatar-token",
      now: () => now,
      avatar: {
        status: async () => avatarStatus,
        camera: async () => avatarStatus,
        async handleRequest(_request, response) {
          response.setHeader("Content-Type", "text/plain");
          response.end("private avatar stream");
        },
      },
    });
    const rendererUrl = `${harness.baseUrl}/avatar/Live2D/events`;
    expect((await fetch(rendererUrl)).status).toBe(401);
    const issued = await fetch(`${harness.baseUrl}/api/avatar`, {
      headers: bearer("private-avatar-token"),
    });
    expect(issued.status).toBe(200);
    const cookie = issued.headers.get("set-cookie")!.split(";")[0]!;
    const authorized = await fetch(rendererUrl, { headers: { Cookie: cookie } });
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toBe("private avatar stream");
    expect(authorized.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    const command = await fetch(`${harness.baseUrl}/api/avatar/camera`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    expect(command.status).toBe(401);
    const tampered = cookie.replace(/=(\d)/u, "=$19");
    expect((await fetch(rendererUrl, { headers: { Cookie: tampered } })).status).toBe(401);
    now += 60 * 60 * 1_000 + 1;
    expect((await fetch(rendererUrl, { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("closes an avatar event stream whose handler has already returned", async () => {
    let avatarResponseClosed = false;
    const harness = await createHarness({
      avatar: {
        status: async () => ({
          enabled: true,
          modelName: "Hiyori",
          previewUrl: "/avatar/Live2D/",
          camera: {
            state: "stopped", connected: false, deviceName: "OBS Virtual Camera",
            width: 1280, height: 720, fps: 30, sceneName: "AI Vtuber Live2D",
          },
        }),
        camera: async () => {
          throw new Error("not used");
        },
        async handleRequest(_request, response) {
          response.once("close", () => {
            avatarResponseClosed = true;
          });
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("data: connected\n\n");
        },
      },
    });
    const stream = await fetch(`${harness.baseUrl}/avatar/Live2D/events`);
    expect(stream.status).toBe(200);
    let closed = false;
    const closing = harness.server.close().then(() => { closed = true; });
    try {
      await vi.waitFor(() => expect(closed).toBe(true));
      await closing;
      expect(avatarResponseClosed).toBe(true);
    } finally {
      await stream.body?.cancel();
    }
  });

  it("serves public health and readiness probes", async () => {
    const harness = await createHarness({ token: "operator-secret" });

    const health = await fetch(`${harness.baseUrl}/healthz`);
    const ready = await fetch(`${harness.baseUrl}/readyz`);

    expect(health.status).toBe(200);
    expect(await json(health)).toMatchObject({ status: "ok" });
    expect(ready.status).toBe(200);
    expect(await json(ready)).toEqual({ status: "ready" });
  });

  it("serves the settings document only at the exact settings paths", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "ai-vtuber-settings-web-"));
    temporaryDirectories.push(webRoot);
    const settingsDocument = "<!doctype html><title>Settings fixture</title>\n";
    await writeFile(join(webRoot, "settings.html"), settingsDocument, "utf8");
    const harness = await createHarness({
      webRoot,
      applicationRoot: webRoot,
      config: {
        webui: {
          ip: "127.0.0.1",
          port: 0,
          local_dir_to_endpoint: {
            enable: true,
            config: [{ url_path: "/settings", local_dir: "." }],
          },
        },
      },
    });

    const [withoutSlash, withSlash, headWithoutSlash, headWithSlash, nested] =
      await Promise.all([
        fetch(`${harness.baseUrl}/settings`),
        fetch(`${harness.baseUrl}/settings/`),
        fetch(`${harness.baseUrl}/settings`, { method: "HEAD" }),
        fetch(`${harness.baseUrl}/settings/`, { method: "HEAD" }),
        fetch(`${harness.baseUrl}/settings/missing`),
      ]);

    for (const response of [withoutSlash, withSlash]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(response.headers.get("content-length")).toBe(
        String(settingsDocument.length),
      );
      expect(await response.text()).toBe(settingsDocument);
    }
    for (const response of [headWithoutSlash, headWithSlash]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(response.headers.get("content-length")).toBe(
        String(settingsDocument.length),
      );
      expect(await response.text()).toBe("");
    }
    expect(nested.status).toBe(404);
  });

  it("enforces optional bearer authentication on operator and compatibility APIs", async () => {
    const harness = await createHarness({ token: "operator-secret" });

    const missing = await fetch(`${harness.baseUrl}/api/status`);
    const incorrect = await fetch(`${harness.baseUrl}/api/status`, {
      headers: bearer("wrong-secret"),
    });
    const accepted = await fetch(`${harness.baseUrl}/api/status`, {
      headers: bearer("operator-secret"),
    });

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(accepted.status).toBe(200);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("runs fail-closed async account authorization only after local bearer authorization", async () => {
    let mode: "allow" | "deny" | "throw" = "deny";
    const decisions: Array<{ configured: boolean; authorized: boolean }> = [];
    const harness = await createHarness({
      token: "operator-secret",
      authorizeRequest: async (_request, localBearer) => {
        decisions.push(localBearer);
        await Promise.resolve();
        if (mode === "throw") {
          throw new Error("account service unavailable");
        }
        return mode === "allow";
      },
    });

    const missingBearer = await fetch(`${harness.baseUrl}/api/status`);
    const denied = await fetch(`${harness.baseUrl}/api/status`, {
      headers: bearer("operator-secret"),
    });
    mode = "throw";
    const unavailable = await fetch(`${harness.baseUrl}/api/status`, {
      headers: bearer("operator-secret"),
    });
    mode = "allow";
    const accepted = await fetch(`${harness.baseUrl}/api/status`, {
      headers: bearer("operator-secret"),
    });

    expect(missingBearer.status).toBe(401);
    expect(denied.status).toBe(403);
    expect(unavailable.status).toBe(403);
    expect(await json(unavailable)).toMatchObject({
      error: { code: "authorization_denied" },
    });
    expect(accepted.status).toBe(200);
    expect(decisions).toEqual([
      { configured: true, authorized: true },
      { configured: true, authorized: true },
      { configured: true, authorized: true },
    ]);
  });

  it("serves an authenticated Pi catalog without exposing stored credentials", async () => {
    const harness = await createHarness({
      token: "operator-secret",
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        agent: {
          mode: "llm",
          provider: "openai-compatible",
          model: "catalog-local-model",
          apiKey: "catalog-private-key",
          baseUrl: "http://127.0.0.1:8000/v1/chat/completions",
          headers: {
            Authorization: "Bearer catalog-header-secret",
            "X-Trace-Id": "safe",
          },
        },
      },
    });

    const unauthorized = await fetch(`${harness.baseUrl}/api/agent/catalog`);
    const response = await fetch(`${harness.baseUrl}/api/agent/catalog`, {
      headers: bearer("operator-secret"),
    });
    const text = await response.text();
    const payload = JSON.parse(text) as JsonObject;
    const suggested = payload["suggestedAgent"] as JsonObject;
    const providers = payload["providers"] as JsonObject[];
    const piModels = builtinModels();
    const oauthOnlyModels = piModels.getModels("openai-codex");
    const exposedModels = providers.flatMap((provider) => {
      const models = provider["models"];
      return Array.isArray(models) ? models as JsonObject[] : [];
    });
    const providerIds = providers.map((provider) => provider["id"]);

    expect(unauthorized.status).toBe(401);
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      source: "agent",
      apiKeyConfigured: true,
      modes: [
        { id: "llm", name: "LLM" },
        { id: "reread", name: "Reread" },
        { id: "disabled", name: "Disabled" },
      ],
    });
    expect(suggested).toMatchObject({
      mode: "llm",
      provider: "openai-compatible",
      model: "catalog-local-model",
      apiKey: "",
      baseUrl: "http://127.0.0.1:8000/v1",
      headers: { "X-Trace-Id": "safe" },
    });
    expect(suggested).toEqual(expect.objectContaining({
      systemPrompt: expect.any(String),
      maxTokens: expect.any(Number),
      contextWindow: expect.any(Number),
      maxSessions: expect.any(Number),
      thinkingLevel: expect.any(String),
      reasoning: expect.any(Boolean),
      input: expect.any(Array),
      samplingParams: expect.any(Object),
    }));
    expect(
      providers.some(
        (provider) =>
          provider["id"] === "openai" &&
          Array.isArray(provider["models"]) &&
          provider["models"].length > 0,
      ),
    ).toBe(true);
    expect(providerIds).toEqual(expect.arrayContaining(["openai", "anthropic"]));
    expect(providerIds).not.toContain("openai-codex");
    expect(oauthOnlyModels.length).toBeGreaterThan(0);
    expect(
      exposedModels.some((exposed) =>
        oauthOnlyModels.some(
          (model) =>
            exposed["id"] === model.id && exposed["api"] === model.api,
        ),
      ),
    ).toBe(false);
    expect(providers.at(-1)).toEqual({
      id: "openai-compatible",
      name: "OpenAI Compatible",
      models: [],
    });
    expect(text).not.toContain("catalog-private-key");
    expect(text).not.toContain("catalog-header-secret");
    expect(text).not.toContain("Authorization");
  });

  it("serves the authenticated Edge TTS voice catalog without exposing request credentials", async () => {
    const edgeVoiceCatalog = vi.fn<NonNullable<
      OperatorServerDependencies["edgeVoiceCatalog"]
    >>(async (options) => {
      expect(options?.trustedClientToken).toBe("fixture-edge-token");
      expect(options?.chromiumVersion).toBe("144.0.0.0");
      return [{
        name: "Microsoft Voice",
        shortName: "zh-CN-XiaoyiNeural",
        gender: "Female",
        locale: "zh-CN",
        localeName: "Chinese (Mainland)",
        friendlyName: "Microsoft Xiaoyi Online (Natural) - Chinese (Mainland)",
      }];
    });
    const harness = await createHarness({
      token: "operator-secret",
      edgeVoiceCatalog,
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        "edge-tts": {
          voice: "zh-CN-XiaoyiNeural",
          trusted_client_token: "fixture-edge-token",
          chromium_version: "144.0.0.0",
        },
      },
    });

    const unauthorized = await fetch(`${harness.baseUrl}/api/speech/edge/voices`);
    const response = await fetch(`${harness.baseUrl}/api/speech/edge/voices`, {
      headers: bearer("operator-secret"),
    });
    const text = await response.text();
    const payload = JSON.parse(text) as JsonObject;

    expect(unauthorized.status).toBe(401);
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      fetchedAt: 1_750_000_000_000,
      voices: [{
        shortName: "zh-CN-XiaoyiNeural",
        gender: "Female",
        locale: "zh-CN",
        localeName: "Chinese (Mainland)",
      }],
    });
    expect(edgeVoiceCatalog).toHaveBeenCalledOnce();
    expect(text).not.toContain("fixture-edge-token");
  });

  it("keeps the Pi catalog editable when canonical Agent configuration is invalid", async () => {
    const harness = await createHarness({
      token: "operator-secret",
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        agent: {
          mode: "llm",
          provider: "openai-compatible",
          model: "",
          apiKey: "invalid-agent-private-key",
        },
      },
    });

    const response = await fetch(`${harness.baseUrl}/api/agent/catalog`, {
      headers: bearer("operator-secret"),
    });
    const text = await response.text();
    const payload = JSON.parse(text) as JsonObject;
    const suggestion = payload["suggestedAgent"] as JsonObject;

    expect(response.status).toBe(200);
    expect(payload["source"]).toBe("agent");
    expect(payload["validationError"]).toEqual(expect.any(String));
    expect(suggestion["mode"]).toBe("disabled");
    expect(suggestion["provider"]).toEqual(expect.any(String));
    expect(suggestion["model"]).toEqual(expect.any(String));
    expect(suggestion["apiKey"]).toBe("");
    expect(text).not.toContain("invalid-agent-private-key");
  });

  it("serves bounded analytics through authenticated operator routes", async () => {
    const calls: unknown[] = [];
    const analytics: OperatorAnalyticsService = {
      commentWordFrequency(options = {}) {
        calls.push(["words", options]);
        return {
          type: "commentWordFrequency",
          sampleSize: 2,
          sampleLimit: options.sampleLimit ?? 10_000,
          items: [{ name: "hello", value: 2 }],
        };
      },
      integralRanking(metric = "integral", limit = 10) {
        calls.push(["ranking", metric, limit]);
        return { type: "integralRanking", metric, limit, items: [] };
      },
      async giftAggregates(limit = 10) {
        await Promise.resolve();
        calls.push(["gifts", limit]);
        return { type: "giftAggregates" as const, limit, items: [] };
      },
    };
    const harness = await createHarness({
      token: "operator-secret",
      analytics,
    });
    const headers = bearer("operator-secret");

    const words = await fetch(
      `${harness.baseUrl}/api/analytics/comment-word-frequency?limit=3&sampleLimit=20`,
      { headers },
    );
    const ranking = await fetch(
      `${harness.baseUrl}/api/analytics/integral-ranking?metric=total_price&limit=2`,
      { headers },
    );
    const gifts = await fetch(
      `${harness.baseUrl}/api/analytics/gift-aggregates?limit=1`,
      { headers },
    );
    const invalidMetric = await fetch(
      `${harness.baseUrl}/api/analytics/integral-ranking?metric=password`,
      { headers },
    );
    const invalidLimit = await fetch(
      `${harness.baseUrl}/api/analytics/gift-aggregates?limit=0`,
      { headers },
    );

    expect(words.status).toBe(200);
    expect(await json(words)).toMatchObject({
      type: "commentWordFrequency",
      sampleLimit: 20,
      items: [{ name: "hello", value: 2 }],
    });
    expect(ranking.status).toBe(200);
    expect(await json(ranking)).toMatchObject({
      type: "integralRanking",
      metric: "total_price",
      limit: 2,
    });
    expect(gifts.status).toBe(200);
    expect(invalidMetric.status).toBe(422);
    expect(invalidLimit.status).toBe(422);
    expect(calls).toEqual([
      ["words", { limit: 3, sampleLimit: 20 }],
      ["ranking", "total_price", 2],
      ["gifts", 1],
    ]);

    const unavailableHarness = await createHarness({
      token: "operator-secret",
    });
    const unavailable = await fetch(
      `${unavailableHarness.baseUrl}/api/analytics/gift-aggregates`,
      { headers },
    );
    expect(unavailable.status).toBe(404);
  });

  it("submits a manual chat event through the injected event submitter", async () => {
    const harness = await createHarness();

    const response = await fetch(`${harness.baseUrl}/api/events/manual`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "comment",
        platform: "operator-test",
        username: "测试员",
        content: "测试手动链路",
      }),
    });
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ accepted: true, processed: true });
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]).toMatchObject({
      id: "http-event-1",
      type: "comment",
      platform: "operator-test",
      username: "测试员",
      content: "测试手动链路",
      timestamp: 1_750_000_000_000,
    });
  });

  it("requires search credentials before saving and safely round-trips a configured key", async () => {
    const harness = await createHarness({
      config: {
        agent: { mode: "reread" },
        search_online: { enable: false, provider: "tavily", api_key: "", endpoint: "", count: 1 },
      },
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`));
    const candidate = structuredClone(initial["config"] as JsonObject);
    const search = candidate["search_online"] as JsonObject;
    search["enable"] = true;
    const headers = { "Content-Type": "application/json", "If-Match": `"${String(initial["revision"])}"` };
    const rejected = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT", headers, body: JSON.stringify(candidate),
    });
    expect(rejected.status).toBe(422);
    expect(await json(rejected)).toMatchObject({ error: { code: "invalid_search_config" } });
    expect(harness.configStore.get("search_online", "enable")).toBe(false);

    search["api_key"] = "search-private-key";
    const accepted = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT", headers, body: JSON.stringify(candidate),
    });
    expect(accepted.status).toBe(200);
    const acceptedText = await accepted.text();
    expect(acceptedText).not.toContain("search-private-key");
    const saved = JSON.parse(acceptedText) as { config: JsonObject; revision: number };
    const savedSearch = saved.config["search_online"] as JsonObject;
    expect(savedSearch["api_key"]).toBe("[REDACTED]");
    savedSearch["count"] = 2;
    const roundTrip = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: { ...headers, "If-Match": `"${saved.revision}"` },
      body: JSON.stringify(saved.config),
    });
    expect(roundTrip.status).toBe(200);
    expect(harness.configStore.get("search_online", "api_key")).toBe("search-private-key");
    expect(harness.configStore.get("search_online", "count")).toBe(2);
  });

  it("rejects moving a redacted Azure subscription key to a different regional endpoint", async () => {
    const harness = await createHarness({
      config: {
        agent: { mode: "disabled" },
        speech: {
          azure: {
            region: "eastus",
            subscription_key: "azure-private-key",
          },
        },
      },
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`));
    const candidate = initial["config"] as JsonObject;
    const azure = ((candidate["speech"] as JsonObject)["azure"] as JsonObject);
    expect(azure["subscription_key"]).toBe("[REDACTED]");
    const roundTrip = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });
    expect(roundTrip.status).toBe(200);
    azure["region"] = "westus";
    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String((await json(roundTrip))["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ error: { code: "invalid_agent_config" } });
    expect(harness.configStore.get("speech", "azure", "region")).toBe("eastus");
  });

  it("rejects duplicate schedule identities without persisting or advancing the revision", async () => {
    const harness = await createHarness({
      config: { platform: "talk", agent: { mode: "reread" }, schedule: [] },
      runtimeUpdateConfig: true,
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`));
    const candidate = initial["config"] as JsonObject;
    candidate["schedule"] = [
      {
        id: "same-task",
        name: "First task",
        enable: true,
        run_on_start: false,
        interval: { mode: "fixed", every: 10, unit: "minutes" },
        prompts: ["First context"],
      },
      {
        id: "same-task",
        name: "Second task",
        enable: true,
        run_on_start: false,
        interval: { mode: "random", min: 5, max: 15, unit: "minutes" },
        prompts: ["Separate context"],
      },
    ];
    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({
      error: { code: "invalid_schedule_config", details: { path: "schedule.1.id" } },
    });
    const unchanged = await json(await fetch(`${harness.baseUrl}/api/config`));
    expect(unchanged["revision"]).toBe(initial["revision"]);
    expect((unchanged["config"] as JsonObject)["schedule"]).toEqual([]);

    const persisted = await ConfigStore.load(harness.configStore.path);
    expect(persisted.get("schedule")).toEqual([]);
  });
  it("rejects invalid idle configuration before it reaches the runtime", async () => {
    const harness = await createHarness({
      config: { platform: "talk", agent: { mode: "reread" } },
      runtimeUpdateConfig: true,
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`));
    const candidate = initial["config"] as JsonObject;
    candidate["idle_time_task"] = "invalid";
    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({
      error: { code: "invalid_idle_config", details: { path: "idle_time_task" } },
    });
    expect(harness.runtimeCalls).not.toContain("updateConfig");
  });

  it("rejects caption configuration outside the project output directories", async () => {
    const harness = await createHarness({
      config: {
        agent: { mode: "disabled" },
        captions: {
          enable: true,
          file_path: "src/caption.txt",
          raw_file_path: "out/raw.vtt",
        },
      },
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`));
    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(initial["config"]),
    });
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({
      error: { code: "invalid_caption_config" },
    });
  });

  it("preserves but locks pending platform settings and rejects their selection", async () => {
    const harness = await createHarness({
      config: {
        platform: "talk",
        marker: "old",
        youtube: { api_key: "stored-secret" },
        webui: {
          show_card: { common_config: { twitch: { token: "stored-token" } } },
        },
      },
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`));
    expect(initial["readOnlyPaths"]).toEqual(expect.arrayContaining([
      ["youtube"],
      ["webui", "show_card", "common_config", "twitch"],
    ]));

    const unchangedPending = structuredClone(initial["config"] as JsonObject);
    unchangedPending["marker"] = "updated";
    const headers = {
      "Content-Type": "application/json",
      "If-Match": `"${String(initial["revision"])}"`,
    };
    const saved = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers,
      body: JSON.stringify(unchangedPending),
    });
    expect(saved.status).toBe(200);
    expect(harness.configStore.get("youtube", "api_key")).toBe("stored-secret");

    const changedPending = structuredClone(unchangedPending);
    (changedPending["youtube"] as JsonObject)["api_key"] = "replacement";
    const changed = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...headers,
        "If-Match": `"${String((await json(saved))["revision"])}"`,
      },
      body: JSON.stringify(changedPending),
    });
    expect(changed.status).toBe(403);
    expect(await json(changed)).toMatchObject({ error: { code: "platform_pending" } });

    const pendingRoot = structuredClone(unchangedPending);
    pendingRoot["platform"] = "youtube";
    const selected = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...headers,
        "If-Match": `"${String(harness.configStore.generation)}"`,
      },
      body: JSON.stringify(pendingRoot),
    });
    expect(selected.status).toBe(422);
    expect(await json(selected)).toMatchObject({ error: { code: "platform_pending" } });
    expect(harness.configStore.get("platform")).toBe("talk");
  });

  it.each([
    { field: "provider", value: "exa" },
    { field: "endpoint", value: "https://collector.test/search" },
  ])("does not rebind a redacted search key when $field changes", async ({ field, value }) => {
    const harness = await createHarness({
      config: {
        agent: { mode: "reread" },
        search_online: { enable: true, provider: "tavily", api_key: "search-private-key", endpoint: "", count: 1 },
      },
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`));
    const candidate = initial["config"] as JsonObject;
    const search = candidate["search_online"] as JsonObject;
    search[field] = value;
    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": `"${String(initial["revision"])}"` },
      body: JSON.stringify(candidate),
    });
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ error: { code: "invalid_search_config" } });
    expect(harness.configStore.get("search_online", "provider")).toBe("tavily");
    expect(harness.configStore.get("search_online", "endpoint")).toBe("");
  });

  it("redacts credentials and preserves them across a redacted config round trip", async () => {
    const harness = await createHarness({
      token: "operator-secret",
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        agent: { mode: "disabled", apiKey: "never-return-this" },
        login: { password: "also-hidden", username: "operator" },
        nested: { enabled: true },
      },
    });

    const getResponse = await fetch(`${harness.baseUrl}/api/config`, {
      headers: bearer("operator-secret"),
    });
    const getText = await getResponse.text();
    const getPayload = JSON.parse(getText) as {
      config: JsonObject;
      revision: number;
    };

    expect(getText).not.toContain("never-return-this");
    expect(getText).not.toContain("also-hidden");
    expect((getPayload.config["agent"] as JsonObject)["apiKey"]).toBe("[REDACTED]");
    (getPayload.config["nested"] as JsonObject)["enabled"] = false;
    const headers = {
      ...bearer("operator-secret"),
      "Content-Type": "application/json",
      "If-Match": `"${String(getPayload.revision)}"`,
    };

    const putResponse = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers,
      body: JSON.stringify(getPayload.config),
    });
    const putText = await putResponse.text();
    const putPayload = JSON.parse(putText) as { revision: number };

    expect(putResponse.status).toBe(200);
    expect(putText).not.toContain("never-return-this");
    expect(harness.configStore.get("agent", "apiKey")).toBe("never-return-this");
    expect(harness.configStore.get("login", "password")).toBe("also-hidden");
    expect(harness.configStore.get("nested", "enabled")).toBe(false);

    const ambiguous = structuredClone(getPayload.config);
    (ambiguous["agent"] as JsonObject)["apiKey"] = "<redacted>";
    const ambiguousResponse = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...headers,
        "If-Match": `"${String(putPayload.revision)}"`,
      },
      body: JSON.stringify(ambiguous),
    });
    expect(ambiguousResponse.status).toBe(422);
    expect(harness.configStore.get("agent", "apiKey")).toBe("never-return-this");
  });

  it("requires a fresh UMS password before moving a redacted UMS login origin", async () => {
    const harness = await createHarness({
      token: "operator-secret",
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        agent: { mode: "disabled" },
        login: {
          enable: true,
          username: "ums-operator",
          password: "ums-stored-password",
          ums_api: "http://127.0.0.1:19000/legacy-ums",
        },
      },
    });
    const headers = bearer("operator-secret");
    const initial = await json(
      await fetch(`${harness.baseUrl}/api/config`, { headers }),
    );
    const roundTrip = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(initial["config"]),
    });
    const saved = await json(roundTrip);
    expect(roundTrip.status).toBe(200);
    expect(harness.configStore.get("login", "password")).toBe(
      "ums-stored-password",
    );
    const sameOrigin = structuredClone(saved["config"] as JsonObject);
    (sameOrigin["login"] as JsonObject)["ums_api"] =
      "http://127.0.0.1:19000/another-ignored-path";
    const sameOriginResponse = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "If-Match": `"${String(saved["revision"])}"`,
      },
      body: JSON.stringify(sameOrigin),
    });
    const sameOriginSaved = await json(sameOriginResponse);
    expect(sameOriginResponse.status).toBe(200);
    expect(harness.configStore.get("login", "password")).toBe(
      "ums-stored-password",
    );


    const moved = structuredClone(sameOriginSaved["config"] as JsonObject);
    const movedLogin = moved["login"] as JsonObject;
    movedLogin["ums_api"] = "https://credential-collector.example.invalid/ignored";
    const rejected = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "If-Match": `"${String(sameOriginSaved["revision"])}"`,
      },
      body: JSON.stringify(moved),
    });
    const rejectedText = await rejected.text();
    expect(rejected.status).toBe(422);
    expect(JSON.parse(rejectedText)).toMatchObject({
      error: { code: "invalid_agent_config" },
    });
    expect(rejectedText).not.toContain("ums-stored-password");
    expect(harness.configStore.get("login", "ums_api")).toBe(
      "http://127.0.0.1:19000/another-ignored-path",
    );
    expect(harness.configStore.get("login", "password")).toBe(
      "ums-stored-password",
    );

    const shadowed = structuredClone(moved);
    (shadowed["login"] as JsonObject)["api"] = "http://127.0.0.1:19000";
    const shadowedResponse = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "If-Match": `"${String(sameOriginSaved["revision"])}"`,
      },
      body: JSON.stringify(shadowed),
    });
    expect(shadowedResponse.status).toBe(422);
    expect(harness.configStore.get("login", "ums_api")).toBe(
      "http://127.0.0.1:19000/another-ignored-path",
    );

    movedLogin["password"] = "ums-replacement-password";
    const accepted = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "If-Match": `"${String(sameOriginSaved["revision"])}"`,
      },
      body: JSON.stringify(moved),
    });
    expect(accepted.status).toBe(200);
    expect(harness.configStore.get("login", "ums_api")).toBe(
      "https://credential-collector.example.invalid/ignored",
    );
    expect(harness.configStore.get("login", "password")).toBe(
      "ums-replacement-password",
    );
  });

  it("validates restored Pi agent configuration before persistence", async () => {
    const harness = await createHarness({
      token: "operator-secret",
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        agent: {
          mode: "llm",
          provider: "openai-compatible",
          model: "local-model",
          apiKey: "stored-agent-private-key",
          baseUrl: "http://127.0.0.1:8000/v1",
        },
      },
    });
    const initial = await json(
      await fetch(`${harness.baseUrl}/api/config`, {
        headers: bearer("operator-secret"),
      }),
    );
    const initialConfig = initial["config"] as JsonObject;
    expect((initialConfig["agent"] as JsonObject)["apiKey"]).toBe("[REDACTED]");

    const roundTrip = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...bearer("operator-secret"),
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(initialConfig),
    });
    const saved = await json(roundTrip);
    expect(roundTrip.status).toBe(200);
    expect(harness.configStore.get("agent", "apiKey")).toBe(
      "stored-agent-private-key",
    );
    const rebound = structuredClone(saved["config"] as JsonObject);
    (rebound["agent"] as JsonObject)["baseUrl"] =
      "https://credential-collector.example.invalid/v1";
    const reboundResponse = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...bearer("operator-secret"),
        "Content-Type": "application/json",
        "If-Match": `"${String(saved["revision"])}"`,
      },
      body: JSON.stringify(rebound),
    });
    expect(reboundResponse.status).toBe(422);
    expect(await json(reboundResponse)).toMatchObject({
      error: { code: "invalid_agent_config" },
    });
    expect(harness.configStore.get("agent", "baseUrl")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(harness.configStore.get("agent", "apiKey")).toBe(
      "stored-agent-private-key",
    );


    const invalid = structuredClone(saved["config"] as JsonObject);
    const invalidAgent = invalid["agent"] as JsonObject;
    invalidAgent["baseUrl"] = "";
    invalidAgent["apiKey"] = "replacement-private-key";
    const rejected = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...bearer("operator-secret"),
        "Content-Type": "application/json",
        "If-Match": `"${String(saved["revision"])}"`,
      },
      body: JSON.stringify(invalid),
    });
    const rejectedText = await rejected.text();
    const rejectedPayload = JSON.parse(rejectedText) as JsonObject;

    expect(rejected.status).toBe(422);
    expect(rejectedPayload).toMatchObject({
      error: { code: "invalid_agent_config" },
    });
    expect(rejectedText).not.toContain("replacement-private-key");
    expect(harness.configStore.get("agent", "baseUrl")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(harness.configStore.get("agent", "apiKey")).toBe(
      "stored-agent-private-key",
    );
  });

  it("validates a dedicated visual fallback for a text-only primary Agent", async () => {
    const models = builtinModels().getModels();
    const vision = models.find((model) => model.input.includes("image"));
    const textOnly = models.find((model) => !model.input.includes("image"));
    if (!vision || !textOnly) {
      throw new Error("Pi catalog must expose both visual and text-only models");
    }
    const harness = await createHarness({
      token: "operator-secret",
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        agent: {
          mode: "reread",
          provider: "openai-compatible",
          model: "shared-model",
          apiKey: "stored-agent-private-key",
          baseUrl: "https://main.example.test/v1",
          input: ["text"],
        },
        image_recognition: { enable: false },
      },
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`, {
      headers: bearer("operator-secret"),
    }));
    const candidate = structuredClone(initial["config"] as JsonObject);
    candidate["image_recognition"] = {
      enable: true,
      provider: textOnly.provider,
      model: textOnly.id,
      apiKey: "dedicated-private-key",
      prompt: "Transcribe this image",
    };

    const rejected = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...bearer("operator-secret"),
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });
    expect(rejected.status).toBe(422);
    expect(await json(rejected)).toMatchObject({
      error: {
        code: "invalid_agent_config",
        message: expect.stringMatching(
          /image_recognition model .* must support image input/iu,
        ),
      },
    });
    expect(harness.configStore.get("image_recognition", "enable")).toBe(false);

    (candidate["image_recognition"] as JsonObject)["provider"] = vision.provider;
    (candidate["image_recognition"] as JsonObject)["model"] = vision.id;
    const accepted = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...bearer("operator-secret"),
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });
    expect(accepted.status).toBe(200);
    expect(harness.configStore.get("image_recognition", "enable")).toBe(true);
    expect(harness.configStore.get("image_recognition", "model")).toBe(vision.id);
  });

  it("rejects an active OAuth-only Pi provider submitted directly", async () => {
    const codexModel = builtinModels().getModels("openai-codex")[0];
    if (!codexModel) throw new Error("Pi OpenAI Codex catalog is empty");
    const harness = await createHarness({
      token: "operator-secret",
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        agent: {
          mode: "disabled",
          provider: "openai-codex",
          model: codexModel.id,
        },
      },
    });
    const initial = await json(
      await fetch(`${harness.baseUrl}/api/config`, {
        headers: bearer("operator-secret"),
      }),
    );
    const candidate = structuredClone(initial["config"] as JsonObject);
    const candidateAgent = candidate["agent"] as JsonObject;
    candidateAgent["mode"] = "llm";
    candidateAgent["apiKey"] = "replacement-private-key";

    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...bearer("operator-secret"),
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });
    const body = await response.text();
    const payload = JSON.parse(body) as JsonObject;

    expect(response.status).toBe(422);
    expect(payload).toMatchObject({
      error: {
        code: "invalid_agent_config",
        message: expect.any(String),
      },
    });
    const message = (payload["error"] as JsonObject)["message"];
    expect(message).toEqual(expect.stringContaining("openai-codex"));
    expect(message).toEqual(expect.stringMatching(/oauth-only/iu));
    expect(message).toEqual(expect.stringMatching(/api key/iu));
    expect(body).not.toContain("replacement-private-key");
    expect(harness.configStore.get("agent", "mode")).toBe("disabled");
    expect(harness.configStore.get("agent", "apiKey")).toBeUndefined();
  });

  it("rejects obsolete root LLM fields on config saves", async () => {
    const harness = await createHarness({
      token: "operator-secret",
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        agent: { mode: "disabled" },
      },
    });
    const initial = await json(
      await fetch(`${harness.baseUrl}/api/config`, {
        headers: bearer("operator-secret"),
      }),
    );
    const candidate = structuredClone(initial["config"] as JsonObject);
    candidate["chat_type"] = "chatgpt";
    candidate["openai"] = { api_key: "obsolete-private-key" };

    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...bearer("operator-secret"),
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });
    const body = await response.text();

    expect(response.status).toBe(422);
    expect(JSON.parse(body)).toMatchObject({
      error: {
        code: "invalid_agent_config",
        message: expect.stringMatching(/chat_type.*no longer supported/iu),
      },
    });
    expect(body).not.toContain("obsolete-private-key");
    expect(harness.configStore.get("chat_type")).toBeUndefined();
    expect(harness.configStore.get("openai")).toBeUndefined();
  });

  it("allows an equivalent normalized provider alias with a redacted credential", async () => {
    const harness = await createHarness({
      token: "operator-secret",
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        agent: {
          mode: "disabled",
          provider: " OpenAI ",
          model: "retained-model",
          apiKey: "alias-private-key",
          baseUrl: "https://api.openai.com/v1/",
        },
      },
    });
    const initial = await json(
      await fetch(`${harness.baseUrl}/api/config`, {
        headers: bearer("operator-secret"),
      }),
    );
    const candidate = structuredClone(initial["config"] as JsonObject);
    const agent = candidate["agent"] as JsonObject;
    agent["provider"] = "openai";
    agent["baseUrl"] = "https://api.openai.com/v1";

    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...bearer("operator-secret"),
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });

    expect(response.status).toBe(200);
    expect(harness.configStore.get("agent", "provider")).toBe("openai");
    expect(harness.configStore.get("agent", "apiKey")).toBe(
      "alias-private-key",
    );
  });

  it("allows endpoint changes when the persisted Agent credential is empty", async () => {
    const harness = await createHarness({
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        agent: {
          mode: "reread",
          provider: "openai-compatible",
          model: "local-model",
          apiKey: "",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`));
    const candidate = structuredClone(initial["config"] as JsonObject);
    const agent = candidate["agent"] as JsonObject;
    expect(agent["apiKey"]).toBe("");
    agent["baseUrl"] = "http://127.0.0.1:8000/v1";

    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });

    expect(response.status).toBe(200);
    expect(harness.configStore.get("agent", "apiKey")).toBe("");
    expect(harness.configStore.get("agent", "baseUrl")).toBe(
      "http://127.0.0.1:8000/v1",
    );
  });

  it("allows canonical reread and disabled saves without a provider", async () => {
    const harness = await createHarness({
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        agent: { mode: "reread" },
      },
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`));
    const reread = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(initial["config"]),
    });
    const rereadPayload = await json(reread);
    expect(reread.status).toBe(200);

    const disabled = structuredClone(rereadPayload["config"] as JsonObject);
    disabled["agent"] = { mode: "disabled" };
    const disabledResponse = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String(rereadPayload["revision"])}"`,
      },
      body: JSON.stringify(disabled),
    });
    expect(disabledResponse.status).toBe(200);
    expect(harness.configStore.get("agent", "mode")).toBe("disabled");
  });

  it("prevents changing the OBS credential destination through the WebUI", async () => {
    const harness = await createHarness({
      token: "operator-secret",
      config: {
        agent: { mode: "disabled" },
        live2d: { camera: { obs_websocket_url: "ws://127.0.0.1:4455", password: "obs-private" } },
      },
    });
    const headers = bearer("operator-secret");
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`, { headers }));
    const candidate = structuredClone(initial["config"] as JsonObject);
    ((candidate["live2d"] as JsonObject)["camera"] as JsonObject)["obs_websocket_url"] =
      "ws://127.0.0.1:9999";
    const changed = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json", "If-Match": `"${String(initial["revision"])}"` },
      body: JSON.stringify(candidate),
    });
    expect(changed.status).toBe(403);
    expect(harness.configStore.get("live2d", "camera", "obs_websocket_url")).toBe("ws://127.0.0.1:4455");
    expect(JSON.stringify(await json(changed))).not.toContain("obs-private");
  });

  it("advertises and locks the independent Live2D listener bind", async () => {
    const harness = await createHarness({
      config: {
        agent: { mode: "disabled" },
        live2d: { host: "127.0.0.1", port: 12345 },
      },
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`));
    expect(initial["readOnlyPaths"]).toEqual(expect.arrayContaining([
      ["live2d", "host"],
      ["live2d", "port"],
    ]));
    const candidate = structuredClone(initial["config"] as JsonObject);
    (candidate["live2d"] as JsonObject)["host"] = "0.0.0.0";
    const changed = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });
    expect(changed.status).toBe(403);
    expect(harness.configStore.get("live2d", "host")).toBe("127.0.0.1");
  });

  it("reports runtime, speech, playback, and legacy system queue status without secrets", async () => {
    const harness = await createHarness({
      runtimeStatus: {
        state: "ready",
        queue: { pending: 4 },
        agent: { state: "running", token: "must-not-leak" },
      },
    });

    const callback = await fetch(`${harness.baseUrl}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "audio_playback_completed",
        data: { wait_play_audio_num: 7, wait_synthesis_msg_num: 5 },
      }),
    });
    const status = await fetch(`${harness.baseUrl}/api/status`);
    const statusText = await status.text();
    const legacy = await fetch(`${harness.baseUrl}/get_sys_info`);
    const legacyPayload = await json(legacy);

    expect(callback.status).toBe(200);
    expect(harness.playbackCallbacks).toEqual([
      {
        type: "audio_playback_completed",
        data: { wait_play_audio_num: 7, wait_synthesis_msg_num: 5 },
      },
    ]);
    expect(status.status).toBe(200);
    expect(statusText).not.toContain("must-not-leak");
    expect(JSON.parse(statusText)).toMatchObject({
      runtime: { state: "ready", queue: { pending: 4 } },
      speech: { state: "idle", queued: 3 },
      playback: { waitPlayAudio: 7, waitSynthesis: 5 },
    });
    expect(legacyPayload).toMatchObject({
      code: 200,
      data: {
        audio: { state: "idle", queued: 3 },
      },
    });
  });

  it("normalizes legacy send requests without bypassing the event submitter", async () => {
    const harness = await createHarness();

    const response = await fetch(`${harness.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "reread",
        data: {
          type: "reread",
          platform: "webui",
          username: "旧版操作员",
          content: "原样复读",
          insert_index: -1,
        },
      }),
    });
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ code: 200, data: { processed: true } });
    expect(harness.submitted[0]).toMatchObject({
      type: "talk",
      platform: "webui",
      username: "旧版操作员",
      content: "原样复读",
      metadata: {
        legacyEndpoint: "send",
        legacyType: "reread",
        chatType: "reread",
        insert_index: -1,
      },
    });
  });

  it("returns structured 4xx errors for malformed JSON, media types, and actions", async () => {
    const harness = await createHarness();

    const malformed = await fetch(`${harness.baseUrl}/api/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    const wrongMediaType = await fetch(`${harness.baseUrl}/api/actions`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "reload" }),
    });
    const unsupported = await fetch(`${harness.baseUrl}/api/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "spawn-shell" }),
    });

    expect(malformed.status).toBe(400);
    expect(await json(malformed)).toMatchObject({ error: { code: "invalid_json" } });
    expect(wrongMediaType.status).toBe(415);
    expect(await json(wrongMediaType)).toMatchObject({
      error: { code: "unsupported_media_type" },
    });
    expect(unsupported.status).toBe(422);
    expect(await json(unsupported)).toMatchObject({
      error: { code: "unsupported_action" },
    });
  });
  it("requires strong config revisions and rejects remote native-execution changes", async () => {
    const harness = await createHarness({
      token: "operator-secret",
      config: {
        webui: { ip: "127.0.0.1", port: 0 },
        nested: { value: "old" },
        virtual_microphone: {
          enable: false,
          executable: "local-virtual-microphone",
        },
      },
    });
    const authorization = bearer("operator-secret");
    const getResponse = await fetch(`${harness.baseUrl}/api/config`, {
      headers: authorization,
    });
    const initial = await getResponse.json() as {
      config: JsonObject;
      revision: number;
      readOnlyPaths: readonly (readonly string[])[];
    };
    expect(initial.readOnlyPaths).toEqual(expect.arrayContaining([
      ["virtual_microphone", "executable"],
    ]));
    const candidate = structuredClone(initial.config);
    (candidate["nested"] as JsonObject)["value"] = "new";

    const missing = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(candidate),
    });
    const saved = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
        "If-Match": `"${String(initial.revision)}"`,
      },
      body: JSON.stringify(candidate),
    });
    const savedPayload = await saved.json() as {
      config: JsonObject;
      revision: number;
    };
    const stale = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
        "If-Match": `"${String(initial.revision)}"`,
      },
      body: JSON.stringify(initial.config),
    });
    const malicious = structuredClone(savedPayload.config);
    malicious["executable_actions"] = [
      {
        id: "shell",
        enable: true,
        executable: "/bin/sh",
        args: ["-c", "id"],
      },
    ];
    const nativePolicy = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
        "If-Match": `"${String(savedPayload.revision)}"`,
      },
      body: JSON.stringify(malicious),
    });
    const virtualMicrophonePolicy = structuredClone(savedPayload.config);
    (virtualMicrophonePolicy["virtual_microphone"] as JsonObject)["executable"] =
      "remote-virtual-microphone";
    const virtualMicrophoneResponse = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
        "If-Match": `"${String(savedPayload.revision)}"`,
      },
      body: JSON.stringify(virtualMicrophonePolicy),
    });

    expect(missing.status).toBe(428);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("etag")).toBe(
      `"${String(savedPayload.revision)}"`,
    );
    expect(stale.status).toBe(412);
    expect(nativePolicy.status).toBe(403);
    expect(await json(nativePolicy)).toMatchObject({
      error: {
        code: "native_execution_policy_immutable",
        details: { path: "executable_actions" },
      },
    });
    expect(virtualMicrophoneResponse.status).toBe(403);
    expect(await json(virtualMicrophoneResponse)).toMatchObject({
      error: {
        code: "native_execution_policy_immutable",
        details: { path: "virtual_microphone.executable" },
      },
    });
    expect(harness.configStore.snapshot()).toEqual(savedPayload.config);
  });

  it("fails closed for tokenless requests with a non-loopback Host", async () => {
    const harness = await createHarness();

    const spoofedRequest = (path: string): Promise<number> =>
      new Promise<number>((resolveStatus, rejectRequest) => {
        const request = httpRequest(
          `${harness.baseUrl}${path}`,
          { headers: { Host: "attacker.example" } },
          (response) => {
            response.resume();
            response.once("end", () => {
              resolveStatus(response.statusCode ?? 0);
            });
          },
        );
        request.once("error", rejectRequest);
        request.end();
      });
    const denied = await spoofedRequest("/api/status");
    const health = await spoofedRequest("/healthz");

    expect(denied).toBe(401);
    expect(health).toBe(200);
  });


  it("reports non-running runtime and stopping speech as not ready", async () => {
    const stopped = await createHarness({
      runtimeStatus: { state: "stopped" },
    });
    const stoppingSpeech = await createHarness({ speechState: "stopping" });

    const stoppedResponse = await fetch(`${stopped.baseUrl}/readyz`);
    const stoppingSpeechResponse = await fetch(
      `${stoppingSpeech.baseUrl}/readyz`,
    );

    expect(stoppedResponse.status).toBe(503);
    expect(stoppingSpeechResponse.status).toBe(503);
    expect(await json(stoppedResponse)).toMatchObject({
      error: { code: "dependency_not_ready" },
    });
  });

  it("delegates operator reload exactly once without preloading ConfigStore", async () => {
    const harness = await createHarness();
    const configReload = vi.spyOn(harness.configStore, "reload");

    const response = await fetch(`${harness.baseUrl}/api/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reload" }),
    });

    expect(response.status).toBe(200);
    expect(harness.runtimeCalls).toEqual(["reload"]);
    expect(configReload).not.toHaveBeenCalled();
    expect(harness.configStore.generation).toBe(0);
  });

  it("invalidates an HTTP revision after an external ConfigStore mutation", async () => {
    const harness = await createHarness({
      token: "operator-secret",
      config: { nested: { value: "initial" } },
    });
    const authorization = bearer("operator-secret");
    const initialResponse = await fetch(`${harness.baseUrl}/api/config`, {
      headers: authorization,
    });
    const initial = await initialResponse.json() as {
      config: JsonObject;
      revision: number;
    };
    await harness.configStore.save({ nested: { value: "external" } });

    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
        "If-Match": `"${String(initial.revision)}"`,
      },
      body: JSON.stringify(initial.config),
    });

    expect(response.status).toBe(412);
    expect(response.headers.get("etag")).toBe("\"1\"");
    expect(await json(response)).toMatchObject({
      error: {
        code: "config_revision_conflict",
        details: { expectedRevision: 0, currentRevision: 1 },
      },
    });
    expect(harness.configStore.get("nested", "value")).toBe("external");
  });

  it("uses the runtime update transaction when the control provides it", async () => {
    const harness = await createHarness({
      runtimeUpdateConfig: true,
      config: { nested: { value: "initial" } },
    });
    const initial = await json(await fetch(`${harness.baseUrl}/api/config`));
    const candidate = structuredClone(initial["config"] as JsonObject);
    (candidate["nested"] as JsonObject)["value"] = "updated";

    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String(initial["revision"])}"`,
      },
      body: JSON.stringify(candidate),
    });

    expect(response.status).toBe(200);
    expect(harness.runtimeCalls).toEqual(["updateConfig"]);
    expect(harness.configStore.generation).toBe(1);
    expect(harness.configStore.get("nested", "value")).toBe("updated");
  });

  it("requires a process restart for effective operator bind changes", async () => {
    const direct = await createHarness({
      config: { webui: { ip: "127.0.0.1", port: 8_081 } },
    });
    const directInitial = await json(
      await fetch(`${direct.baseUrl}/api/config`),
    );
    const directCandidate = structuredClone(
      directInitial["config"] as JsonObject,
    );
    (directCandidate["webui"] as JsonObject)["port"] = 9_999;
    const directResponse = await fetch(`${direct.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String(directInitial["revision"])}"`,
      },
      body: JSON.stringify(directCandidate),
    });

    const fallback = await createHarness({
      config: { api_ip: "127.0.0.1", api_port: 8_081 },
    });
    const fallbackInitial = await json(
      await fetch(`${fallback.baseUrl}/api/config`),
    );
    const fallbackCandidate = structuredClone(
      fallbackInitial["config"] as JsonObject,
    );
    fallbackCandidate["api_ip"] = "0.0.0.0";
    const fallbackResponse = await fetch(`${fallback.baseUrl}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${String(fallbackInitial["revision"])}"`,
      },
      body: JSON.stringify(fallbackCandidate),
    });

    expect(directResponse.status).toBe(409);
    expect(fallbackResponse.status).toBe(409);
    expect(await json(directResponse)).toMatchObject({
      error: { code: "operator_bind_restart_required" },
    });
    expect(await json(fallbackResponse)).toMatchObject({
      error: { code: "operator_bind_restart_required" },
    });
  });

  it("bounds synthesized legacy gift fields and content", async () => {
    const harness = await createHarness();

    const response = await fetch(`${harness.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "gift",
        data: {
          type: "gift",
          gift_name: "x".repeat(20_001),
          num: "1",
        },
      }),
    });

    expect(response.status).toBe(422);
    expect(harness.submitted).toEqual([]);
    expect(await json(response)).toMatchObject({
      error: { code: "invalid_field" },
    });
  });

  it("does not serve configured static roots outside applicationRoot", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ai-vtuber-static-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "private.png"), new Uint8Array([1, 2, 3]));
    const harness = await createHarness({
      config: {
        webui: {
          local_dir_to_endpoint: {
            enable: true,
            config: [{ url_path: "/assets", local_dir: outside }],
          },
        },
      },
    });

    const response = await fetch(`${harness.baseUrl}/assets/private.png`);

    expect(response.status).toBe(404);
  });

  it("strips inline image blobs from operator SSE while retaining metadata", async () => {
    const harness = await createHarness();
    const dataUrl = "data:image/png;base64,aW1hZ2U=";
    const inbound: AppEvent = {
      type: "inbound",
      event: {
        id: "image-event",
        type: "image",
        platform: "camera",
        username: "operator",
        content: "describe",
        timestamp: 1,
        metadata: {
          images: [dataUrl],
          imageBase64: "aW1hZ2U=",
          imageMimeType: "image/png",
          imageBytes: 5,
          imagePath: "captures/frame.png",
        },
      },
      timestamp: 1,
    };
    harness.events.publish(inbound);

    const response = await fetch(`${harness.baseUrl}/api/events`);
    await harness.server.close();
    const replay = await response.text();

    expect(replay).toContain("image-event");
    expect(replay).toContain("imageMimeType");
    expect(replay).toContain("imageBytes");
    expect(replay).toContain("captures/frame.png");
    expect(replay).not.toContain("data:image");
    expect(replay).not.toContain("aW1hZ2U=");
    expect(replay).not.toContain("imageBase64");
  });

  it("drops oversized SSE events and bounds aggregate replay history bytes", async () => {
    const harness = await createHarness({ sseHistorySize: 200 });
    harness.events.publish({
      type: "system.status",
      component: "oversized",
      status: "ready",
      message: `oversized-sentinel-${"x".repeat(40_000)}`,
      timestamp: 1,
    });
    for (let index = 0; index < 10; index += 1) {
      harness.events.publish({
        type: "system.status",
        component: `history-${String(index)}`,
        status: "ready",
        message: `history-${String(index)}-${"y".repeat(18_000)}`,
        timestamp: index + 2,
      });
    }

    const response = await fetch(`${harness.baseUrl}/api/events`);
    await harness.server.close();
    const replay = await response.text();

    expect(replay).not.toContain("oversized-sentinel");
    expect(replay).not.toContain("history-0-");
    expect(replay).toContain("history-9-");
    expect(Buffer.byteLength(replay)).toBeLessThan(256 * 1024);
  });

  it("maps event processor admission overload to an explicit retryable response", async () => {
    const harness = await createHarness({
      submitError: new EventProcessorOverloadError("sessions", 4),
    });

    const response = await fetch(`${harness.baseUrl}/api/events/manual`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "busy" }),
    });

    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({
      error: {
        code: "event_processor_overloaded",
        details: { resource: "sessions", limit: 4 },
      },
    });
  });
});
