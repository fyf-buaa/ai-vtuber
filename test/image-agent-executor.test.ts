import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Context,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import { PiAgentError } from "../src/agent/errors.js";
import {
  createImageAgentExecutor,
  primaryAgentSupportsImage,
  resolveImageAgentConfig,
} from "../src/agent/image-agent-executor.js";
import {
  PiAgentExecutor,
  type PiAgentExecutorOptions,
} from "../src/agent/pi-agent-executor.js";

const PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");

function dedicatedVisionConfig(): Record<string, unknown> {
  return {
    agent: {
      mode: "llm",
      provider: "openai-compatible",
      model: "text-only-main",
      apiKey: "main-agent-secret",
      baseUrl: "https://main.example.test/v1",
      input: ["text"],
    },
    image_recognition: {
      enable: true,
      provider: "vision-fixture",
      model: "vision-fixture-model",
      apiKey: "dedicated-vision-secret",
      baseUrl: "https://vision.example.test/v1",
      systemPrompt: "Transcribe only visible details.",
      prompt: "Describe this image",
    },
  };
}

function visionModels(input: ("text" | "image")[] = ["text", "image"]) {
  const provider = fauxProvider({
    provider: "vision-fixture",
    models: [{ id: "vision-fixture-model", input }],
    tokenSize: { min: 1, max: 1 },
  });
  const models = createModels();
  models.setProvider(provider.provider);
  return { models, provider };
}

describe("resolveImageAgentConfig", () => {
  it("stays lazy when dedicated image transcription is not enabled", () => {
    const root: Record<string, unknown> = {
      image_recognition: { enable: false },
    };
    Object.defineProperty(root, "agent", {
      enumerable: true,
      get(): never {
        throw new Error("disabled image recognition must not inspect Agent configuration");
      },
    });

    expect(resolveImageAgentConfig(root)).toBeUndefined();
    expect(createImageAgentExecutor(root)).toBeUndefined();
    expect(resolveImageAgentConfig({ image_recognition: { enable: "true" } }))
      .toBeUndefined();
    expect(resolveImageAgentConfig(null)).toBeUndefined();
  });

  it("resolves credentials and model settings from image_recognition", () => {
    const { models } = visionModels();
    const resolved = resolveImageAgentConfig(dedicatedVisionConfig(), models);

    expect(resolved).toMatchObject({
      provider: "vision-fixture",
      model: "vision-fixture-model",
      apiKey: "dedicated-vision-secret",
      baseUrl: "https://vision.example.test/v1",
      systemPrompt: "Transcribe only visible details.",
      input: ["text", "image"],
    });
  });

  it("rejects a dedicated text-only model", () => {
    const textModel = builtinModels().getModels()
      .find((model) => !model.input.includes("image"));
    if (!textModel) throw new Error("Pi builtin catalog has no text-only model");

    expect(() => resolveImageAgentConfig({
      ...dedicatedVisionConfig(),
      image_recognition: {
        enable: true,
        provider: textModel.provider,
        model: textModel.id,
        apiKey: "configured-key",
      },
    })).toThrow(/dedicated Pi model .* support image input/iu);
  });

  it("rejects a text-only model supplied by a custom provider", () => {
    const { models } = visionModels(["text"]);

    expect(() => resolveImageAgentConfig(dedicatedVisionConfig(), models))
      .toThrow(PiAgentError);
    expect(() => resolveImageAgentConfig(dedicatedVisionConfig(), models))
      .toThrow(/support image input/iu);
  });
});

describe("createImageAgentExecutor", () => {
  it("uses the dedicated Pi model and removes primary model and tools", async () => {
    const contexts: Context[] = [];
    const { models, provider } = visionModels();
    provider.setResponses([
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("image transcribed");
      },
    ]);
    const primaryModel = {
      input: ["text"],
    } as unknown as NonNullable<PiAgentExecutorOptions["model"]>;
    const executor = createImageAgentExecutor(dedicatedVisionConfig(), {
      models,
      model: primaryModel,
      tools: [{} as never],
      toolsForSession: () => [{} as never],
    });

    expect(executor).toBeInstanceOf(PiAgentExecutor);
    if (!executor) throw new Error("Expected an enabled image executor");
    await expect(executor.execute({
      sessionId: "dedicated-image-session",
      username: "camera",
      content: "Describe this exact image",
      images: [`data:image/png;base64,${PNG_BASE64}`],
    })).resolves.toMatchObject({
      text: "image transcribed",
      provider: "vision-fixture",
      model: "vision-fixture-model",
    });

    expect(contexts).toHaveLength(1);
    const userMessage = contexts[0]?.messages[0];
    expect(userMessage?.role).toBe("user");
    if (
      !userMessage ||
      userMessage.role !== "user" ||
      typeof userMessage.content === "string"
    ) {
      throw new Error("Expected a multimodal Pi user message");
    }
    expect(userMessage.content).toEqual([
      { type: "text", text: "Describe this exact image" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ]);
  });

  it("does not inspect a fallback when the injected primary model supports images", () => {
    const { models } = visionModels();
    const primaryModel = models.getModel(
      "vision-fixture",
      "vision-fixture-model",
    );
    if (!primaryModel) throw new Error("Expected the fixture visual model");
    const config = { image_recognition: { enable: true } };

    expect(primaryAgentSupportsImage(config, { model: primaryModel })).toBe(true);
    expect(createImageAgentExecutor(config, {
      model: primaryModel,
    })).toBeUndefined();
  });

  it("rejects an invalid fallback even with a text-only primary model", () => {
    const { models } = visionModels(["text"]);
    const primaryModel = {
      input: ["text"],
    } as unknown as NonNullable<PiAgentExecutorOptions["model"]>;

    expect(() => createImageAgentExecutor(dedicatedVisionConfig(), {
      models,
      model: primaryModel,
    })).toThrow(/support image input/iu);
  });
});
