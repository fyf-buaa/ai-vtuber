import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Message,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import {
  PiAgentExecutor,
  resolvePiAgentConfig,
} from "../src/agent/index.js";
import type {
  AgentDeltaAppEvent,
  AgentRequest,
  AppEvent,
} from "../src/domain/types.js";

function request(
  sessionId: string,
  content: string,
  systemPrompt?: string,
): AgentRequest {
  return {
    sessionId,
    username: sessionId,
    content,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  };
}

function textOf(message: Message): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  }
  if (message.role === "assistant") {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function createFauxExecutor(options: {
  readonly maxSessions?: number;
  readonly maxImageBytes?: number;
  readonly maxStreamBufferBytes?: number;
  readonly maxStreamBufferChunks?: number;
  readonly publisher?: { publish(event: AppEvent): void };
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly tokensPerSecond?: number;
}) {
  const faux = fauxProvider({
    provider: "executor-faux",
    models: [{
      id: "executor-model",
      input: ["text", "image"],
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    }],
    tokenSize: { min: 1, max: 1 },
    ...(options.tokensPerSecond !== undefined
      ? { tokensPerSecond: options.tokensPerSecond }
      : {}),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const executor = new PiAgentExecutor(
    {
      agent: {
        provider: "executor-faux",
        model: "executor-model",
        systemPrompt: "default system",
      },
    },
    {
      models,
      model: faux.getModel(),
      ...(options.maxSessions !== undefined
        ? { maxSessions: options.maxSessions }
        : {}),
      ...(options.maxImageBytes !== undefined
        ? { maxImageBytes: options.maxImageBytes }
        : {}),
      ...(options.maxStreamBufferBytes !== undefined
        ? { maxStreamBufferBytes: options.maxStreamBufferBytes }
        : {}),
      ...(options.maxStreamBufferChunks !== undefined
        ? { maxStreamBufferChunks: options.maxStreamBufferChunks }
        : {}),
      ...(options.publisher ? { publisher: options.publisher } : {}),
    },
  );
  return { executor, faux };
}

describe("PiAgentExecutor", () => {
  it("keeps history isolated while resetting request prompt overrides and sessions", async () => {
    const { executor, faux } = createFauxExecutor({});
    const contexts: Context[] = [];
    faux.setResponses([
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("alice-1");
      },
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("bob-1");
      },
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("alice-2");
      },
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("alice-after-reset");
      },
    ]);

    await expect(
      executor.execute(request("alice", "first", "alice system")),
    ).resolves.toMatchObject({ text: "alice-1", provider: "executor-faux" });
    await executor.execute(request("bob", "hello"));
    await executor.execute(request("alice", "second"));

    expect(contexts[0]?.systemPrompt).toBe("alice system");
    expect(contexts[0]?.messages.map(textOf)).toEqual(["first"]);
    expect(contexts[1]?.systemPrompt).toBe("default system");
    expect(contexts[1]?.messages.map(textOf)).toEqual(["hello"]);
    expect(contexts[2]?.systemPrompt).toBe("default system");
    expect(contexts[2]?.messages.map(textOf)).toEqual([
      "first",
      "alice-1",
      "second",
    ]);

    await executor.reset("alice");
    await executor.execute(request("alice", "fresh"));
    expect(contexts[3]?.messages.map(textOf)).toEqual(["fresh"]);
    expect(faux.state.callCount).toBe(4);
  });

  it("keeps long conversations within the provider limit while retaining recent turns", async () => {
    const { executor, faux } = createFauxExecutor({ contextWindow: 1_024, maxTokens: 128 });
    const contexts: Context[] = [];
    const prompts = Array.from({ length: 12 }, (_, index) => `turn-${index}: ${"x".repeat(800)}`);
    faux.setResponses(prompts.map((_, index) => (context) => {
      contexts.push(structuredClone(context));
      if (context.messages.map(textOf).join("").length > 3_500) {
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "Provider context length exceeded",
        });
      }
      return fauxAssistantMessage(`answer-${index}`);
    }));
    try {
      for (const [index, prompt] of prompts.entries()) {
        await expect(executor.execute(request("long-lived", prompt)))
          .resolves.toMatchObject({ text: `answer-${index}` });
      }
      const retained = contexts.at(-1)!.messages.map(textOf);
      expect(retained).toContain(prompts.at(-1));
      expect(retained).toContain(prompts.at(-2));
      expect(retained).toContain("answer-10");
      expect(retained).not.toContain(prompts[0]);
    } finally {
      await executor.reset();
    }
  });

  it("prunes complete old turns during tool continuations without orphaning results", async () => {
    const faux = fauxProvider({
      provider: "bounded-tool-faux",
      models: [{ id: "bounded-tool-model", contextWindow: 1_536, maxTokens: 128 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const contexts: Context[] = [];
    const first = `old-first: ${"x".repeat(1_000)}`;
    const second = `old-second: ${"y".repeat(1_000)}`;
    const toolText = "tool evidence ".repeat(300);
    faux.setResponses([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("second answer"),
      (context) => {
        expect(context.messages.map(textOf)).toContain(first);
        return fauxAssistantMessage(
          fauxToolCall("lookup", {}, { id: "lookup-call" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        contexts.push({ messages: structuredClone(context.messages) });
        return fauxAssistantMessage("grounded answer");
      },
    ]);
    const executor = new PiAgentExecutor(
      { agent: { provider: "bounded-tool-faux", model: "bounded-tool-model" } },
      {
        models,
        tools: [{
          name: "lookup",
          label: "Lookup",
          description: "Look up evidence",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: toolText }],
            details: {},
          }),
        }],
      },
    );
    try {
      await executor.execute(request("tool-history", first));
      await executor.execute(request("tool-history", second));
      await expect(executor.execute(request("tool-history", "use lookup")))
        .resolves.toMatchObject({ text: "grounded answer" });
      const messages = contexts[0]!.messages;
      expect(messages.map(textOf)).not.toContain(first);
      expect(messages.map(textOf)).toContain("use lookup");
      expect(messages.at(-2)).toMatchObject({
        role: "assistant",
        content: [expect.objectContaining({ type: "toolCall", id: "lookup-call" })],
      });
      expect(messages.at(-1)).toMatchObject({
        role: "toolResult",
        toolCallId: "lookup-call",
        content: [{ type: "text", text: toolText }],
      });
    } finally {
      await executor.reset();
    }
  });

  it("rejects an oversized current turn or system prompt without poisoning saved history", async () => {
    const { executor, faux } = createFauxExecutor({ contextWindow: 1_024, maxTokens: 128 });
    const contexts: Context[] = [];
    faux.setResponses([
      fauxAssistantMessage("remembered"),
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("still usable");
      },
    ]);
    try {
      await executor.execute(request("bounded-input", "remember this"));
      await expect(executor.execute(request("bounded-input", "x".repeat(5_000))))
        .rejects.toMatchObject({ code: "execution", message: expect.stringContaining("input budget") });
      await expect(executor.execute(request("bounded-input", "small", "x".repeat(5_000))))
        .rejects.toMatchObject({ code: "execution", message: expect.stringContaining("input budget") });
      await expect(executor.execute(request("bounded-input", "continue")))
        .resolves.toMatchObject({ text: "still usable" });
      expect(contexts[0]!.messages.map(textOf)).toEqual(["remember this", "remembered", "continue"]);
      expect(contexts[0]!.systemPrompt).toBe("default system");
    } finally {
      await executor.reset();
    }
  });

  it("omits configured tools when the tools capability is disabled", async () => {
    const faux = fauxProvider({
      provider: "tool-capability-faux",
      models: [{ id: "tool-capability-model" }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const observedTools: string[][] = [];
    faux.setResponses([
      (context) => {
        observedTools.push((context.tools ?? []).map(({ name }) => name));
        return fauxAssistantMessage("without tools");
      },
      (context) => {
        observedTools.push((context.tools ?? []).map(({ name }) => name));
        return fauxAssistantMessage("with tools");
      },
    ]);
    const staticTool = {
      name: "static_tool",
      label: "Static tool",
      description: "Static test tool",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      }),
    };
    const sessionTool = {
      ...staticTool,
      name: "session_tool",
      label: "Session tool",
    };
    const toolsForSession = vi.fn(() => [sessionTool]);
    const config = {
      provider: "tool-capability-faux",
      model: "tool-capability-model",
    };
    const disabled = new PiAgentExecutor(
      { agent: { ...config, tools: false } },
      { models, tools: [staticTool], toolsForSession },
    );
    const enabled = new PiAgentExecutor(
      { agent: { ...config, tools: true } },
      { models, tools: [staticTool], toolsForSession },
    );

    await disabled.execute(request("tools-disabled", "hello"));
    expect(toolsForSession).not.toHaveBeenCalled();
    await enabled.execute(request("tools-enabled", "hello"));

    expect(observedTools).toEqual([
      [],
      ["static_tool", "session_tool"],
    ]);
    expect(toolsForSession).toHaveBeenCalledOnce();
    expect(toolsForSession).toHaveBeenCalledWith("tools-enabled");
  });

  it("enforces image source and byte policies before provider invocation", async () => {
    const localHarness = createFauxExecutor({});
    await expect(
      localHarness.executor.execute({
        ...request("local-image", "inspect"),
        images: ["./private.png"],
      }),
    ).rejects.toMatchObject({
      code: "configuration",
      message: expect.stringContaining("localImageRoots"),
    });
    expect(localHarness.faux.state.callCount).toBe(0);

    const boundedHarness = createFauxExecutor({ maxImageBytes: 1 });
    const pngSignature = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]).toString("base64");
    await expect(
      boundedHarness.executor.execute({
        ...request("large-image", "inspect"),
        images: [`data:image/png;base64,${pngSignature}`],
      }),
    ).rejects.toMatchObject({
      code: "configuration",
      message: "Image 1 exceeds the 1-byte limit",
    });
    expect(boundedHarness.faux.state.callCount).toBe(0);
  });

  it("streams real pi Agent text deltas without publishing terminal events", async () => {
    const events: AppEvent[] = [];
    const { executor, faux } = createFauxExecutor({
      publisher: { publish: (event) => events.push(event) },
    });
    faux.setResponses([fauxAssistantMessage("streamed response")]);

    const deltas: string[] = [];
    for await (const delta of executor.stream(request("stream", "say it"))) {
      deltas.push(delta);
    }

    expect(deltas.join("")).toBe("streamed response");
    expect(faux.state.callCount).toBe(1);
    const publishedDeltas = events.filter(
      (event): event is AgentDeltaAppEvent => event.type === "agent.delta",
    );
    expect(publishedDeltas.map((event) => event.text).join("")).toBe(
      "streamed response",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "agent.completed" || event.type === "agent.error",
      ),
    ).toEqual([]);
  });

  it("ignores empty text deltas", async () => {
    const events: AppEvent[] = [];
    const { executor, faux } = createFauxExecutor({
      publisher: { publish: (event) => events.push(event) },
    });
    faux.setResponses([fauxAssistantMessage("")]);

    const deltas: string[] = [];
    for await (const delta of executor.stream(request("empty", "say nothing"))) {
      deltas.push(delta);
    }

    expect(deltas).toEqual([]);
    expect(events.filter((event) => event.type === "agent.delta")).toEqual([]);
    expect(faux.state.callCount).toBe(1);
  });

  it.each([
    {
      label: "byte",
      limit: 4,
      limits: { maxStreamBufferBytes: 4 },
      optionName: "maxStreamBufferBytes",
    },
    {
      label: "chunk",
      limit: 1,
      limits: { maxStreamBufferChunks: 1 },
      optionName: "maxStreamBufferChunks",
    },
  ] as const)(
    "fails a paused consumer on $label buffer overflow",
    async ({ limit, limits, optionName }) => {
      let publishedDeltaCount = 0;
      const {
        promise: overflowDelta,
        resolve: resolveOverflowDelta,
      } = Promise.withResolvers<void>();
      const { executor, faux } = createFauxExecutor({
        ...limits,
        publisher: {
          publish: (event) => {
            if (
              event.type === "agent.delta" &&
              ++publishedDeltaCount === 3
            ) {
              resolveOverflowDelta();
            }
          },
        },
      });
      faux.setResponses([fauxAssistantMessage("overflow test")]);
      const iterator = executor
        .stream(request(`overflow-${optionName}`, "start"))
        [Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toEqual({
        value: "over",
        done: false,
      });
      await overflowDelta;

      await expect(iterator.next()).rejects.toMatchObject({
        name: "PiAgentError",
        code: "execution",
        message: `Pi Agent stream buffer overflow: ${optionName} limit of ${limit} exceeded`,
      });
      expect(faux.state.callCount).toBe(1);
      expect(publishedDeltaCount).toBe(3);
    },
    2_000,
  );

  it.each([
    ["maxStreamBufferBytes", { maxStreamBufferBytes: 0 }],
    ["maxStreamBufferChunks", { maxStreamBufferChunks: 1.5 }],
  ] as const)("requires a positive integer %s", (optionName, limits) => {
    expect(() => createFauxExecutor(limits)).toThrow(
      `Pi Agent executor ${optionName} must be a positive integer`,
    );
  });

  it("cancels an active pi Agent stream through AbortSignal", async () => {
    const { executor, faux } = createFauxExecutor({ tokensPerSecond: 200 });
    faux.setResponses([
      fauxAssistantMessage("a response long enough to have several deltas"),
    ]);
    const controller = new AbortController();
    const iterator = executor
      .stream(request("cancel", "start"), { signal: controller.signal })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    controller.abort();
    let failure: unknown;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "cancelled" });
  });

  it("evicts the least-recently-used idle session at the retention bound", async () => {
    const { executor, faux } = createFauxExecutor({ maxSessions: 1 });
    const contexts: Context[] = [];
    faux.setResponses([
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("one");
      },
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("two");
      },
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("three");
      },
    ]);

    await executor.execute(request("one", "first"));
    await executor.execute(request("two", "second"));
    await executor.execute(request("one", "third"));

    expect(contexts.map((context) => context.messages.map(textOf))).toEqual([
      ["first"],
      ["second"],
      ["third"],
    ]);
  });

  it("applies thinking level and only explicit model metadata overrides", async () => {
    const faux = fauxProvider({
      provider: "override-faux",
      models: [
        {
          id: "override-model",
          reasoning: false,
          input: ["text"],
          contextWindow: 4_096,
          maxTokens: 512,
        },
      ],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const observed: Array<{
      reasoning: unknown;
      model: {
        reasoning: boolean;
        input: readonly string[];
        contextWindow: number;
        maxTokens: number;
      };
    }> = [];
    faux.setResponses([
      (_context, options, _state, model) => {
        observed.push({
          reasoning: options?.reasoning,
          model: {
            reasoning: model.reasoning,
            input: [...model.input],
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          },
        });
        return fauxAssistantMessage("overridden");
      },
      (_context, options, _state, model) => {
        observed.push({
          reasoning: options?.reasoning,
          model: {
            reasoning: model.reasoning,
            input: [...model.input],
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          },
        });
        return fauxAssistantMessage("catalog defaults");
      },
    ]);

    const overridden = new PiAgentExecutor(
      {
        agent: {
          provider: "override-faux",
          model: "override-model",
          thinkingLevel: "high",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 8_192,
          maxTokens: 1_024,
        },
      },
      { models },
    );
    const untouched = new PiAgentExecutor(
      {
        agent: {
          provider: "override-faux",
          model: "override-model",
        },
      },
      { models },
    );

    await overridden.execute(request("overridden", "hello"));
    await untouched.execute(request("untouched", "hello"));

    expect(observed).toEqual([
      {
        reasoning: "high",
        model: {
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 8_192,
          maxTokens: 1_024,
        },
      },
      {
        reasoning: undefined,
        model: {
          reasoning: false,
          input: ["text"],
          contextWindow: 4_096,
          maxTokens: 512,
        },
      },
    ]);
  });

  it("applies explicit overrides to a model selected from the builtin catalog", async () => {
    const builtin = builtinModels().getModels("anthropic")[0];
    if (!builtin) throw new Error("Pi Anthropic catalog is empty");
    const input: Array<"text" | "image"> = builtin.input.includes("image")
      ? ["text"]
      : ["text", "image"];
    const expected = {
      reasoning: !builtin.reasoning,
      input,
      contextWindow: builtin.contextWindow + 1,
      maxTokens: builtin.maxTokens + 1,
    };
    const transport = fauxProvider({
      provider: "builtin-override-transport",
      models: [{ id: "transport-model" }],
    });
    let observed:
      | {
          reasoning: boolean;
          input: readonly string[];
          contextWindow: number;
          maxTokens: number;
        }
      | undefined;
    transport.setResponses([
      (_context, _options, _state, model) => {
        observed = {
          reasoning: model.reasoning,
          input: [...model.input],
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        };
        return fauxAssistantMessage("builtin overridden");
      },
    ]);
    const executor = new PiAgentExecutor(
      {
        agent: {
          provider: builtin.provider,
          model: builtin.id,
          apiKey: "configured-test-key",
          ...expected,
        },
      },
      {
        streamFn: (model, context, options) =>
          transport.provider.streamSimple(model, context, options),
      },
    );

    await executor.execute(request("builtin-overrides", "hello"));

    expect(observed).toEqual(expected);
  });

  it("rejects OAuth-only builtin providers across runtime selection paths", async () => {
    const builtinModelsCollection = builtinModels();
    const provider = builtinModelsCollection.getProvider("openai-codex");
    const model = builtinModelsCollection.getModels("openai-codex")[0];
    if (!provider || !model) {
      throw new Error("Pi OpenAI Codex catalog is empty");
    }
    const injectedModels = createModels();
    injectedModels.setProvider(provider);
    const agent = {
      mode: "llm",
      provider: model.provider,
      model: model.id,
      apiKey: "configured-test-key",
    };
    const unexpectedStream = () => {
      throw new Error("OAuth-only provider stream must not start");
    };
    const executors = [
      new PiAgentExecutor({ agent }, { streamFn: unexpectedStream }),
      new PiAgentExecutor(
        {
          agent: {
            ...agent,
            openAICompatible: true,
            baseUrl: "https://example.invalid/v1",
          },
        },
        { streamFn: unexpectedStream },
      ),
      new PiAgentExecutor(
        { agent },
        { model, streamFn: unexpectedStream },
      ),
      new PiAgentExecutor(
        { agent },
        { models: injectedModels, streamFn: unexpectedStream },
      ),
    ];

    for (const [index, executor] of executors.entries()) {
      await expect(
        executor.execute(request(`oauth-only-${index}`, "hello")),
      ).rejects.toMatchObject({
        name: "PiAgentError",
        code: "configuration",
        message: expect.stringMatching(/openai-codex.*OAuth-only.*API key/iu),
      });
    }
  });

  it("rejects obsolete root LLM configuration", () => {
    expect(() =>
      resolvePiAgentConfig({
        chat_type: "chatgpt",
        openai: {
          api: "http://127.0.0.1:8000/v1/chat/completions",
          api_key: ["obsolete-key"],
        },
      })
    ).toThrow(/chat_type.*no longer supported/iu);
  });
  it("rejects explicit temperature overrides before resolving the model", () => {
    expect(() =>
      resolvePiAgentConfig({
        agent: {
          provider: "openai-compatible",
          model: "configured-model",
          temperature: 0.7,
        },
      })
    ).toThrow(/agent\.temperature .* default temperature/iu);
    expect(() =>
      resolvePiAgentConfig({
        agent: {
          provider: "openai-compatible",
          model: "configured-model",
          samplingParams: { temperature: 0.7 },
        },
      })
    ).toThrow(/agent\.samplingParams\.temperature .* default temperature/iu);
  });


  it("keeps canonical builtin base URL overrides on the Pi catalog model", () => {
    const builtin = builtinModels().getModels("openai")[0];
    if (!builtin) throw new Error("Pi OpenAI catalog is empty");

    const resolved = resolvePiAgentConfig({
      agent: {
        mode: "llm",
        provider: builtin.provider,
        model: builtin.id,
        apiKey: "configured-key",
        baseUrl: "https://gateway.example.invalid/v1",
      },
    });

    expect(resolved).toMatchObject({
      provider: builtin.provider,
      model: builtin.id,
      baseUrl: "https://gateway.example.invalid/v1",
      openAICompatible: false,
    });
  });

  it.each([
    ["google", false],
    ["anthropic", false],
    ["qwen", true],
    ["moonshotai-cn", false],
    ["deepseek", false],
    ["openrouter", false],
  ] as const)(
    "keeps canonical Pi provider %s",
    (provider, openAICompatible) => {
      const resolved = resolvePiAgentConfig({
        agent: {
          provider,
          model: "configured-model",
          apiKey: "configured-key",
        },
      });
      expect(resolved).toMatchObject({
        provider,
        model: "configured-model",
        apiKey: "configured-key",
        openAICompatible,
      });
    },
  );

  it("does not read ambient provider credentials for a custom compatible endpoint", async () => {
    const previous = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "ambient-private-key";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network access is forbidden"));
    try {
      const executor = new PiAgentExecutor({
        agent: {
          provider: "openai",
          model: "deployment",
          baseUrl: "https://collector.example.invalid/v1",
          openAICompatible: true,
        },
      });

      await expect(
        executor.execute(request("custom-endpoint-env", "hello")),
      ).rejects.toMatchObject({ code: "auth" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (previous === undefined) {
        delete process.env["OPENAI_API_KEY"];
      } else {
        process.env["OPENAI_API_KEY"] = previous;
      }
    }
  });

  it("surfaces configuration, provider, model, and auth failures explicitly", async () => {
    await expect(
      new PiAgentExecutor({ chat_type: "reread" }).execute(
        request("bad-config", "hello"),
      ),
    ).rejects.toMatchObject({ code: "configuration" });

    await expect(
      new PiAgentExecutor({
        agent: { provider: "missing-provider", model: "missing-model" },
      }).execute(request("bad-provider", "hello")),
    ).rejects.toMatchObject({ code: "provider" });

    await expect(
      new PiAgentExecutor({
        agent: { provider: "deepseek", model: "definitely-not-a-model" },
      }).execute(request("bad-model", "hello")),
    ).rejects.toMatchObject({ code: "model" });

    await expect(
      new PiAgentExecutor({
        agent: {
          provider: "acme",
          model: "acme-model",
          apiType: "openai-completions",
          baseUrl: "https://example.invalid/v1",
        },
      }).execute(request("bad-auth", "hello")),
    ).rejects.toMatchObject({ code: "auth" });
  });
});
