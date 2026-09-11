import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";

import {
  PiAgentConfigValidationError,
  createPiAgentCatalog,
  piAgentCatalogProviders,
  validatePiAgentConfig,
} from "../src/agent/index.js";

function openAiModelId(): string {
  const model = builtinModels().getModels("openai")[0];
  if (!model) throw new Error("Pi OpenAI catalog is empty");
  return model.id;
}

describe("Pi agent configuration catalog", () => {
  it("projects the Pi builtin collection and sanitizes a canonical suggestion", async () => {
    const catalog = await createPiAgentCatalog(
      {
        agent: {
          mode: "llm",
          provider: "openai-compatible",
          model: "canonical-local-model",
          apiKey: "canonical-private-key",
          baseUrl: "http://127.0.0.1:8000/v1/chat/completions",
          systemPrompt: "canonical system",
          maxTokens: 2_048,
          headers: {
            Authorization: "Bearer canonical-header-secret",
            "X.Api.Key": "punctuated-header-secret",
            "Ocp-Apim-Subscription-Key": "subscription-header-secret",
            "X-Trace-Id": "safe-trace",
          },
          samplingParams: {
            top_p: 0.8,
            apiKey: "nested-private-key",
            "api.key": "punctuated-param-secret",
            endpoint: "https://user:url-secret@example.invalid/v1",
          },
        },
      },
      { env: {} },
    );

    expect(catalog).toMatchObject({
      schemaVersion: 1,
      source: "agent",
      apiKeyConfigured: true,
      modes: [
        { id: "llm", name: "LLM" },
        { id: "reread", name: "Reread" },
        { id: "disabled", name: "Disabled" },
      ],
      suggestedAgent: {
        mode: "llm",
        provider: "openai-compatible",
        model: "canonical-local-model",
        apiKey: "",
        baseUrl: "http://127.0.0.1:8000/v1",
        systemPrompt: "canonical system",
        maxTokens: 2_048,
        headers: { "X-Trace-Id": "safe-trace" },
        samplingParams: { top_p: 0.8 },
        tools: true,
      },
    });
    expect(catalog).not.toHaveProperty("validationError");
    expect(catalog.suggestedAgent).not.toHaveProperty("temperature");
    expect(
      catalog.providers.some(({ id }) => id === catalog.suggestedAgent.provider),
    ).toBe(true);
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain("canonical-private-key");
    expect(serialized).not.toContain("canonical-header-secret");
    expect(serialized).not.toContain("nested-private-key");
    expect(serialized).not.toContain("punctuated-header-secret");
    expect(serialized).not.toContain("punctuated-param-secret");
    expect(serialized).not.toContain("subscription-header-secret");
    expect(serialized).not.toContain("url-secret");
    expect(serialized).not.toContain("Authorization");

    const projected = piAgentCatalogProviders();
    const builtin = builtinModels().getModels("openai")[0];
    const openai = projected.find((provider) => provider.id === "openai");
    expect(openai?.models[0]).toEqual(
      builtin === undefined
        ? undefined
        : {
            id: builtin.id,
            name: builtin.name,
            api: builtin.api,
            reasoning: builtin.reasoning,
            input: builtin.input,
            contextWindow: builtin.contextWindow,
            maxTokens: builtin.maxTokens,
            tools: true,
          },
    );
    expect(
      projected
        .filter(({ id }) => id !== "openai-compatible")
        .every(({ models }) => models.length > 0),
    ).toBe(true);
    const anthropic = builtinModels().getProvider("anthropic");
    expect(anthropic?.auth.apiKey).toBeDefined();
    expect(anthropic?.auth.oauth).toBeDefined();
    expect(projected.some(({ id }) => id === "anthropic")).toBe(true);
    expect(projected.some(({ id }) => id === "openai-codex")).toBe(false);
    expect(projected.at(-1)).toEqual({
      id: "openai-compatible",
      name: "OpenAI Compatible",
      models: [],
    });
  });

  it("rejects obsolete root LLM fields without deriving an Agent", async () => {
    const obsolete = {
      chat_type: "chatgpt",
      openai: { api_key: "stored-private-key" },
      chatgpt: {
        model: "obsolete-model",
        headers: { Authorization: "Bearer obsolete-header-credential" },
      },
    };
    await expect(
      validatePiAgentConfig(obsolete, { env: {} }),
    ).rejects.toBeInstanceOf(PiAgentConfigValidationError);
    await expect(
      validatePiAgentConfig({ system_prompt: "obsolete system prompt" }, { env: {} }),
    ).rejects.toThrow(/system_prompt.*no longer supported/iu);
    await expect(
      validatePiAgentConfig({ provider: "openai" }, { env: {} }),
    ).rejects.toThrow(/provider.*no longer supported/iu);
    await expect(
      validatePiAgentConfig(
        {
          agent: {
            mode: "llm",
            provider: "openai",
            model: "gpt-4.1",
            api_key: "obsolete-agent-key",
          },
        },
        { env: {} },
      ),
    ).rejects.toThrow(/agent\.api_key.*agent\.apiKey/iu);

    const catalog = await createPiAgentCatalog(obsolete, { env: {} });
    expect(catalog.source).toBe("default");
    expect(catalog.validationError).toMatch(/chat_type.*no longer supported/iu);
    expect(catalog.suggestedAgent).toMatchObject({
      mode: "disabled",
      apiKey: "",
      baseUrl: "",
      headers: {},
      samplingParams: {},
    });
    expect(catalog.suggestedAgent.provider).not.toBe("");
    expect(catalog.suggestedAgent.model).not.toBe("");
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain("stored-private-key");
    expect(serialized).not.toContain("obsolete-header-credential");
  });

  it("rejects obsolete image-recognition routing fields", async () => {
    await expect(
      validatePiAgentConfig(
        {
          agent: { mode: "disabled" },
          image_recognition: {
            enable: false,
            img_save_path: "./out/legacy-images",
          },
        },
        { env: {} },
      ),
    ).rejects.toThrow(
      /image_recognition\.img_save_path.*no longer supported.*dedicated Pi visual model/iu,
    );
    await expect(
      validatePiAgentConfig(
        {
          agent: { mode: "disabled" },
          image_recognition: { enable: false, gemini: {} },
        },
        { env: {} },
      ),
    ).rejects.toThrow(/image_recognition\.gemini.*no longer supported/iu);
  });

  it("keeps an unconfigured installation disabled in its catalog suggestion", async () => {
    const catalog = await createPiAgentCatalog({}, { env: {} });

    expect(catalog).toMatchObject({
      source: "default",
      apiKeyConfigured: false,
      suggestedAgent: {
        mode: "disabled",
        apiKey: "",
        baseUrl: "",
      },
    });
    expect(catalog.suggestedAgent.provider).not.toBe("");
    expect(catalog.suggestedAgent.model).not.toBe("");
  });

  it("does not materialize a builtin provider's implicit model base URL", async () => {
    const catalog = await createPiAgentCatalog(
      {
        agent: {
          mode: "llm",
          provider: "openai",
          model: openAiModelId(),
          apiKey: "builtin-private-key",
        },
      },
      { env: {} },
    );

    expect(catalog.suggestedAgent).toMatchObject({
      mode: "llm",
      provider: "openai",
      model: openAiModelId(),
      apiKey: "",
      baseUrl: "",
    });
    expect(JSON.stringify(catalog)).not.toContain("builtin-private-key");
  });

  it("accepts reread and disabled modes without an available provider", async () => {
    await expect(
      validatePiAgentConfig({ agent: { mode: "reread" } }, { env: {} }),
    ).resolves.toBeUndefined();
    await expect(
      validatePiAgentConfig(
        { agent: { mode: "disabled", provider: "missing", model: "missing" } },
        { env: {} },
      ),
    ).resolves.toBeUndefined();
  });
  it("rejects primary, dedicated visual, and sampling temperature overrides", async () => {
    await expect(
      validatePiAgentConfig(
        { agent: { mode: "reread", temperature: 0.7 } },
        { env: {} },
      ),
    ).rejects.toThrow(/agent\.temperature .* default temperature/iu);
    await expect(
      validatePiAgentConfig(
        {
          agent: {
            mode: "reread",
            samplingParams: { temperature: 0.7 },
          },
        },
        { env: {} },
      ),
    ).rejects.toThrow(/agent\.samplingParams\.temperature .* default temperature/iu);
    await expect(
      validatePiAgentConfig(
        {
          agent: { mode: "reread" },
          image_recognition: { enable: false, temperature: 0.2 },
        },
        { env: {} },
      ),
    ).rejects.toThrow(/image_recognition\.temperature .* default temperature/iu);
  });


  it("uses a dedicated visual model only when the primary model is text-only", async () => {
    const providers = piAgentCatalogProviders();
    const vision = providers
      .flatMap((provider) => provider.models.map((model) => ({ provider, model })))
      .find(({ model }) => model.input.includes("image"));
    const textOnly = providers
      .flatMap((provider) => provider.models.map((model) => ({ provider, model })))
      .find(({ model }) => !model.input.includes("image"));
    if (!vision || !textOnly) {
      throw new Error("Pi catalog must expose both visual and text-only models");
    }

    await expect(validatePiAgentConfig({
      agent: {
        mode: "llm",
        provider: vision.provider.id,
        model: vision.model.id,
        apiKey: "configured-primary-key",
      },
      image_recognition: {
        enable: true,
        provider: "missing-provider",
        model: "missing-model",
      },
    }, { env: {} })).resolves.toBeUndefined();

    const dedicated = {
      agent: {
        mode: "llm",
        provider: textOnly.provider.id,
        model: textOnly.model.id,
        apiKey: "configured-primary-key",
      },
      image_recognition: {
        enable: true,
        provider: vision.provider.id,
        model: vision.model.id,
        apiKey: "configured-vision-key",
        prompt: "Transcribe this image",
      },
    };
    await expect(validatePiAgentConfig(dedicated, { env: {} }))
      .resolves.toBeUndefined();

    const invalid = {
      ...dedicated,
      image_recognition: {
        ...dedicated.image_recognition,
        provider: textOnly.provider.id,
        model: textOnly.model.id,
      },
    };
    await expect(validatePiAgentConfig(invalid, { env: {} }))
      .rejects.toThrow(/image_recognition model .* must support image input/iu);
    const catalog = await createPiAgentCatalog(invalid, { env: {} });
    expect(catalog.validationError)
      .toMatch(/image_recognition model .* must support image input/iu);
  });

  it("forces custom compatible fallback models to accept image input", async () => {
    const config = {
      agent: { mode: "disabled" },
      image_recognition: {
        enable: true,
        provider: "openai-compatible",
        model: "custom-vision",
        apiKey: "configured-key",
        baseUrl: "https://vision.example.test/v1",
      },
    };

    await expect(validatePiAgentConfig(config, { env: {} })).resolves.toBeUndefined();
  });

  it("rejects OAuth-only builtin providers before compatibility projection", async () => {
    const model = builtinModels().getModels("openai-codex")[0];
    if (!model) throw new Error("Pi OpenAI Codex catalog is empty");
    const configurations = [
      {
        mode: "llm",
        provider: model.provider,
        model: model.id,
        apiKey: "configured-key",
      },
      {
        mode: "llm",
        provider: model.provider,
        model: model.id,
        apiKey: "configured-key",
        openAICompatible: true,
        baseUrl: "https://example.invalid/v1",
      },
    ];

    for (const agent of configurations) {
      await expect(
        validatePiAgentConfig({ agent }, { env: {} }),
      ).rejects.toMatchObject({
        name: "PiAgentConfigValidationError",
        message: expect.stringMatching(/openai-codex.*OAuth-only.*API key/iu),
      });
    }
  });

  it("accepts ambient provider credentials without making a network request", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network access is forbidden"));
    try {
      const input = {
        agent: {
          mode: "llm",
          provider: "openai",
          model: openAiModelId(),
          apiKey: "",
        },
      };
      await expect(
        validatePiAgentConfig(input, {
          env: { OPENAI_API_KEY: "ambient-private-key" },
        }),
      ).resolves.toBeUndefined();
      const catalog = await createPiAgentCatalog(input, {
        env: { OPENAI_API_KEY: "ambient-private-key" },
      });
      expect(catalog.apiKeyConfigured).toBe(true);
      expect(catalog).not.toHaveProperty("validationError");
      expect(JSON.stringify(catalog)).not.toContain("ambient-private-key");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    {
      label: "canonical explicit compatibility",
      input: {
        agent: {
          mode: "llm",
          provider: "openai",
          model: "deployment",
          baseUrl: "https://collector.example.invalid/v1",
          openAICompatible: true,
        },
      },
    },
  ])(
    "does not bind ambient provider credentials to a custom endpoint for $label",
    async ({ input }) => {
      const env = { OPENAI_API_KEY: "ambient-private-key" };

      await expect(
        validatePiAgentConfig(input, { env }),
      ).rejects.toBeInstanceOf(PiAgentConfigValidationError);
      const catalog = await createPiAgentCatalog(input, { env });
      expect(catalog.apiKeyConfigured).toBe(false);
      expect(catalog.validationError).toMatch(/credential/iu);
      expect(JSON.stringify(catalog)).not.toContain("ambient-private-key");
    },
  );

  it("does not treat an unredacted bare key field as an Agent credential", async () => {
    await expect(
      validatePiAgentConfig(
        {
          agent: {
            mode: "llm",
            provider: "openai-compatible",
            model: "custom-model",
            baseUrl: "https://gateway.example.invalid/v1",
            key: "ambiguous-visible-value",
          },
        },
        { env: {} },
      ),
    ).rejects.toBeInstanceOf(PiAgentConfigValidationError);
  });

  it("rejects unknown models, incomplete compatible providers, and invalid canonical field types", async () => {
    const validBase = {
      mode: "llm",
      provider: "openai",
      model: openAiModelId(),
      apiKey: "configured-key",
    };
    const invalidAgents = [
      { ...validBase, model: "definitely-not-a-pi-model" },
      {
        ...validBase,
        provider: "openai-compatible",
        model: "custom-model",
      },
      { ...validBase, maxTokens: 0 },
      { ...validBase, thinkingLevel: "extreme" },
      { ...validBase, input: ["audio"] },
      { ...validBase, headers: [] },
      { ...validBase, samplingParams: [] },
    ];

    for (const agent of invalidAgents) {
      await expect(
        validatePiAgentConfig({ agent }, { env: {} }),
      ).rejects.toBeInstanceOf(PiAgentConfigValidationError);
    }
  });
});
