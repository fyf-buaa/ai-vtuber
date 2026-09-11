import { describe, expect, it } from "vitest";

import {
  agentCatalogModel,
  cloneJsonObject,
  describeSettingsConfig,
  isReadOnlySettingsPath,
  isSecretSettingsPath,
  isSettingsPathDirty,
  jsonValueAtPath,
  materializeSettingsAgent,
  parseAgentCatalog,
  selectAgentModel,
  selectAgentProvider,
  setJsonValueAtPath,
  type AgentCatalog,
  type JsonObject,
} from "../web/settings-model.js";

function catalogFixture(source: "agent" | "default" = "agent"): AgentCatalog {
  return parseAgentCatalog({
    schemaVersion: 1,
    modes: [
      { id: "llm", name: "模型回复" },
      { id: "reread", name: "复读" },
      { id: "disabled", name: "停用" },
    ],
    source,
    suggestedAgent: {
      mode: "llm",
      provider: "fixture-a",
      model: "model-a",
      apiKey: "",
      baseUrl: "",
      systemPrompt: "fixture prompt",
      maxTokens: 80,
      contextWindow: 800,
      maxSessions: 100,
      thinkingLevel: "medium",
      reasoning: true,
      input: ["text"],
      tools: true,
      headers: {},
      samplingParams: {},
    },
    apiKeyConfigured: false,
    providers: [
      {
        id: "fixture-a",
        name: "Fixture A",
        models: [
          {
            id: "model-a",
            name: "Model A",
            api: "fixture-api-a",
            reasoning: true,
            input: ["text"],
            contextWindow: 800,
            maxTokens: 80,
            tools: true,
          },
          {
            id: "model-a2",
            name: "Model A2",
            api: "fixture-api-a",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 1_600,
            maxTokens: 160,
            tools: false,
          },
        ],
      },
      {
        id: "fixture-b",
        name: "Fixture B",
        models: [
          {
            id: "model-b",
            name: "Model B",
            api: "fixture-api-b",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 3_200,
            maxTokens: 320,
            tools: true,
          },
        ],
      },
      {
        id: "openai-compatible",
        name: "OpenAI Compatible",
        models: [],
      },
    ],
  });
}

describe("settings model", () => {
  it("describes every leaf while preserving JSON control kinds", () => {
    const config: JsonObject = {
      provider: {
        enabled: true,
        retries: 2,
        name: "local",
        models: ["one", "two"],
        empty: {},
        optional: null,
        nested: { endpoint: "http://127.0.0.1" },
      },
    };

    const [section] = describeSettingsConfig(config, [["provider", "models"]]);

    expect(section?.key).toBe("provider");
    expect(section?.fields.map(({ kind, path, readOnly }) => ({ kind, path, readOnly })))
      .toEqual([
        { kind: "boolean", path: ["provider", "enabled"], readOnly: false },
        { kind: "number", path: ["provider", "retries"], readOnly: false },
        { kind: "string", path: ["provider", "name"], readOnly: false },
        { kind: "array", path: ["provider", "models"], readOnly: true },
        { kind: "object", path: ["provider", "empty"], readOnly: false },
        { kind: "null", path: ["provider", "optional"], readOnly: false },
        { kind: "string", path: ["provider", "nested", "endpoint"], readOnly: false },
      ]);
  });

  it("clones and updates nested fields without mutating the loaded config", () => {
    const loaded: JsonObject = { speech: { voice: { speed: 1 } } };
    const draft = cloneJsonObject(loaded);

    setJsonValueAtPath(draft, ["speech", "voice", "speed"], 1.25);

    expect(jsonValueAtPath(loaded, ["speech", "voice", "speed"])).toBe(1);
    expect(jsonValueAtPath(draft, ["speech", "voice", "speed"])).toBe(1.25);
    expect(isSettingsPathDirty(loaded, draft, ["speech", "voice", "speed"])).toBe(true);
  });

  it("matches protected path prefixes but not similarly named siblings", () => {
    const protectedPaths = [["actions", "executables"]] as const;

    expect(isReadOnlySettingsPath(["actions", "executables"], protectedPaths)).toBe(true);
    expect(isReadOnlySettingsPath(["actions", "executables", "0"], protectedPaths)).toBe(true);
    expect(isReadOnlySettingsPath(["actions", "executable_timeout"], protectedPaths)).toBe(false);
  });

  it.each([
    [["openai", "api_key"], true],
    [["service", "accessToken"], true],
    [["webui", "password"], true],
    [["oauth", "auth_code"], true],
    [["cloud", "access-key-id"], true],
    [["provider", "app.key"], true],
    [["provider", "ac_time_value"], true],
    [["headers", "Ocp-Apim-Subscription-Key"], true],
    [["speech", "speaker"], false],
  ] as const)("classifies secret path %j", (path, expected) => {
    expect(isSecretSettingsPath(path)).toBe(expected);
  });

  it("handles hostile object keys without modifying object prototypes", () => {
    const loaded = JSON.parse(
      '{"section":{"__proto__":{"polluted":"before"},"constructor":"kept"}}',
    ) as JsonObject;
    const draft = cloneJsonObject(loaded);

    setJsonValueAtPath(draft, ["section", "__proto__", "polluted"], "after");

    expect(jsonValueAtPath(draft, ["section", "__proto__", "polluted"])).toBe("after");
    expect(jsonValueAtPath(loaded, ["section", "__proto__", "polluted"])).toBe("before");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("reads and updates canonical array indices without accepting prototype paths", () => {
    const draft = cloneJsonObject({
      schedule: [{ id: "task-1", prompts: ["first"] }],
    });
    expect(jsonValueAtPath(draft, ["schedule", "0", "prompts", "0"])).toBe("first");
    setJsonValueAtPath(draft, ["schedule", "0", "prompts", "0"], "updated");
    expect(jsonValueAtPath(draft, ["schedule", "0", "prompts", "0"])).toBe("updated");
    expect(() => setJsonValueAtPath(draft, ["schedule", "01"], null)).toThrow();
    expect(() => setJsonValueAtPath(draft, ["schedule", "__proto__"], null)).toThrow();
  });

  it("compares structured values independent of object identity", () => {
    const loaded: JsonObject = { section: { list: [1, { value: "same" }] } };
    const draft = cloneJsonObject(loaded);

    expect(isSettingsPathDirty(loaded, draft, ["section", "list"])).toBe(false);
    setJsonValueAtPath(draft, ["section", "list"], [1, { value: "changed" }]);
    expect(isSettingsPathDirty(loaded, draft, ["section", "list"])).toBe(true);
  });

  it("forms a canonical root agent from the backend suggestion without mutating unrelated config", () => {
    const source: JsonObject = {
      future_plugin: { enabled: true },
    };
    const catalog = catalogFixture();

    const materialized = materializeSettingsAgent(source, catalog);

    expect(materialized.agentSynthesized).toBe(true);
    expect(Object.hasOwn(source, "agent")).toBe(false);
    expect(materialized.config["agent"]).toEqual(catalog.suggestedAgent);
    expect((materialized.config["agent"] as JsonObject)["apiKey"]).toBe("");
    expect(materialized.config["future_plugin"]).toEqual(source["future_plugin"]);
  });

  it("repairs partial and non-object agent values from the canonical suggestion", () => {
    const catalog = catalogFixture("agent");
    const partial: JsonObject = {
      agent: {
        mode: "llm",
        provider: "fixture-a",
        model: "model-a",
        extension: "preserved",
      },
    };

    const repaired = materializeSettingsAgent(partial, catalog);
    const repairedAgent = repaired.config["agent"] as JsonObject;
    expect(repaired.agentSynthesized).toBe(true);
    expect(repairedAgent).toMatchObject({
      mode: "llm",
      provider: "fixture-a",
      model: "model-a",
      extension: "preserved",
      thinkingLevel: "medium",
      headers: {},
    });
    expect(Object.hasOwn(partial["agent"] as JsonObject, "thinkingLevel")).toBe(false);

    const replaced = materializeSettingsAgent(
      { agent: "corrupt legacy value" },
      catalog,
    );
    expect(replaced).toMatchObject({
      agentSynthesized: true,
      config: { agent: catalog.suggestedAgent },
    });
  });

  it("normalizes a validated compatible provider alias during materialization", () => {
    const payload = JSON.parse(JSON.stringify(catalogFixture("agent"))) as Record<
      string,
      unknown
    >;
    const suggested = payload["suggestedAgent"] as Record<string, unknown>;
    suggested["provider"] = "openai-compatible";
    suggested["model"] = "legacy-deployment";
    suggested["baseUrl"] = "https://legacy-gateway.example.invalid/v1";
    const catalog = parseAgentCatalog(payload);
    const aliased = cloneJsonObject(catalog.suggestedAgent);
    setJsonValueAtPath(aliased, ["provider"], "qwen");
    setJsonValueAtPath(aliased, ["baseUrl"], "");

    const materialized = materializeSettingsAgent({ agent: aliased }, catalog);

    expect(materialized.agentSynthesized).toBe(true);
    expect(materialized.config["agent"]).toMatchObject({
      provider: "openai-compatible",
      model: "legacy-deployment",
      baseUrl: "https://legacy-gateway.example.invalid/v1",
    });
  });

  it("uses only catalog provider models and synchronizes effective model metadata", () => {
    const catalog = catalogFixture("agent");
    const original = cloneJsonObject(catalog.suggestedAgent);
    setJsonValueAtPath(original, ["maxTokens"], 999);
    setJsonValueAtPath(original, ["contextWindow"], 9_999);

    const changedProvider = selectAgentProvider(original, catalog, "fixture-b");

    expect(changedProvider).toMatchObject({
      provider: "fixture-b",
      model: "model-b",
      maxTokens: 320,
      contextWindow: 3_200,
      reasoning: false,
      input: ["text", "image"],
      tools: true,
    });
    expect(original).toMatchObject({
      provider: "fixture-a",
      model: "model-a",
      maxTokens: 999,
      contextWindow: 9_999,
    });

    const changedModel = selectAgentModel(original, catalog, "model-a2");
    expect(changedModel).toMatchObject({
      provider: "fixture-a",
      model: "model-a2",
      maxTokens: 160,
      contextWindow: 1_600,
      reasoning: false,
      input: ["text", "image"],
      tools: false,
    });
    expect(agentCatalogModel(catalog, "fixture-a", "model-a2")?.api).toBe("fixture-api-a");
  });

  it("refreshes metadata when two providers expose the same model id", () => {
    const payload = JSON.parse(JSON.stringify(catalogFixture("agent"))) as {
      providers: Array<{ models: Array<Record<string, unknown>> }>;
    };
    payload.providers[1]?.models.unshift({
      id: "model-a",
      name: "Model A via Fixture B",
      api: "fixture-api-b",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 4_096,
      maxTokens: 512,
      tools: false,
    });
    const catalog = parseAgentCatalog(payload);
    const original = cloneJsonObject(catalog.suggestedAgent);
    setJsonValueAtPath(original, ["maxTokens"], 999);

    expect(selectAgentProvider(original, catalog, "fixture-b")).toMatchObject({
      provider: "fixture-b",
      model: "model-a",
      maxTokens: 512,
      contextWindow: 4_096,
      reasoning: false,
      input: ["text", "image"],
      tools: false,
    });
  });

  it("preserves model overrides when the provider still accepts the model or accepts free input", () => {
    const catalog = catalogFixture("agent");
    const original = cloneJsonObject(catalog.suggestedAgent);
    setJsonValueAtPath(original, ["maxTokens"], 999);

    const unchangedProviderModel = selectAgentProvider(original, catalog, "fixture-a");
    expect(unchangedProviderModel).toMatchObject({ model: "model-a", maxTokens: 999 });

    const compatible = selectAgentProvider(original, catalog, "openai-compatible");
    expect(compatible).toMatchObject({
      provider: "openai-compatible",
      model: "model-a",
      maxTokens: 999,
    });
    const customModel = selectAgentModel(compatible, catalog, "deployment-from-fixture");
    expect(customModel).toMatchObject({
      provider: "openai-compatible",
      model: "deployment-from-fixture",
      maxTokens: 999,
    });
  });

  it("accepts unavailable retained provider data while the suggested mode is inactive", () => {
    const payload = JSON.parse(JSON.stringify(catalogFixture())) as Record<string, unknown>;
    const suggested = payload["suggestedAgent"] as Record<string, unknown>;
    suggested["mode"] = "disabled";
    suggested["provider"] = "retained-unavailable-provider";
    suggested["model"] = "retained-unavailable-model";

    expect(parseAgentCatalog(payload).suggestedAgent).toMatchObject({
      mode: "disabled",
      provider: "retained-unavailable-provider",
      model: "retained-unavailable-model",
    });
  });
});
