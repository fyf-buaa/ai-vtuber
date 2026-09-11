import {
  Agent,
  estimateContextTokens,
  estimateTokens,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
  type MutableModels,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import type {
  AgentExecutionOptions,
  AgentExecutor,
} from "../core/contracts.js";
import type {
  AgentRequest,
  AgentResponse,
  AgentUsage,
  EventPublisher,
} from "../domain/types.js";
import { PiAgentError, type PiAgentErrorCode } from "./errors.js";
import { normalizePiImages } from "./image-input.js";
import {
  canUsePiEnvironmentCredential,
  defaultPiCompatibleBaseUrl,
  isPiCredentialHeaderName,
  isPiModelBaseUrlOverride,
  isPiProviderApiKeyConfigurable,
  piAgentEnvironmentKeys,
  resolvePiAgentConfig,
  type ResolvedPiAgentConfig,
} from "./provider-resolution.js";


const DEFAULT_MAX_STREAM_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_MAX_STREAM_BUFFER_CHUNKS = 1024;
const DELTA_QUEUE_COMPACTION_THRESHOLD = 1024;

export interface PiAgentExecutorOptions {
  readonly publisher?: EventPublisher;
  /** Preconfigured pi collection, primarily for credentials and deterministic providers. */
  readonly models?: Models;
  /** Preselected model. Pair with `models` or `streamFn` for custom providers. */
  readonly model?: Model<any>;
  /** Direct pi stream seam; requests still execute through a real pi `Agent`. */
  readonly streamFn?: StreamFn;
  readonly maxSessions?: number;
  /** Directory allowlist resolved canonically before use; omission disables local images. */
  readonly localImageRoots?: readonly string[];
  /** Positive decoded-byte limit per image. Defaults to 10 MiB. */
  readonly maxImageBytes?: number;
  /** Maximum UTF-8 bytes retained for a paused stream consumer. Defaults to 1 MiB. */
  readonly maxStreamBufferBytes?: number;
  /** Maximum deltas retained for a paused stream consumer. Defaults to 1024. */
  readonly maxStreamBufferChunks?: number;
  /** Tools copied into every newly-created session agent. */
  readonly tools?: readonly AgentTool<any>[];
  /** Additional tools copied into the agent created for a specific session. */
  readonly toolsForSession?: (
    sessionId: string,
  ) => readonly AgentTool<any>[];
}

interface ResolvedRuntime {
  readonly config: ResolvedPiAgentConfig;
  readonly model: Model<any>;
  readonly streamFn: StreamFn;
  readonly maxInputTokens: number;
}

interface SessionEntry {
  readonly id: string;
  readonly agent: Agent;
  gate: Promise<void>;
  reservations: number;
  closed: boolean;
}

interface RunCallbacks {
  readonly onDelta?: (delta: string) => void;
}

interface QueueWaiter {
  readonly resolve: (result: IteratorResult<string>) => void;
  readonly reject: (error: unknown) => void;
}

/** Stateful, bounded, pi-native implementation of the shared agent contract. */
export class PiAgentExecutor implements AgentExecutor {
  private readonly configInput: unknown;
  private readonly publisher: EventPublisher | undefined;
  private readonly options: PiAgentExecutorOptions;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly maxStreamBufferBytes: number;
  private readonly maxStreamBufferChunks: number;
  private runtime: ResolvedRuntime | undefined;

  constructor(config: unknown, options: PiAgentExecutorOptions = {}) {
    this.configInput = config;
    this.options = options;
    this.publisher = options.publisher;
    this.maxStreamBufferBytes = positiveIntegerOption(
      options.maxStreamBufferBytes,
      DEFAULT_MAX_STREAM_BUFFER_BYTES,
      "maxStreamBufferBytes",
    );
    this.maxStreamBufferChunks = positiveIntegerOption(
      options.maxStreamBufferChunks,
      DEFAULT_MAX_STREAM_BUFFER_CHUNKS,
      "maxStreamBufferChunks",
    );
  }

  async execute(
    request: AgentRequest,
    options: AgentExecutionOptions = {},
  ): Promise<AgentResponse> {
    return await this.runRequest(request, options, {});
  }

  async *stream(
    request: AgentRequest,
    options: AgentExecutionOptions = {},
  ): AsyncIterable<string> {
    const consumerAbort = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, consumerAbort.signal])
      : consumerAbort.signal;
    const deltas = new DeltaQueue(
      this.maxStreamBufferBytes,
      this.maxStreamBufferChunks,
    );
    let settled = false;
    const runPromise = this.runRequest(
      request,
      { signal },
      {
        onDelta: (delta) => {
          const overflow = deltas.push(delta);
          if (overflow) consumerAbort.abort(overflow);
        },
      },
    ).then(
      (response) => {
        settled = true;
        deltas.end();
        return response;
      },
      (error: unknown) => {
        settled = true;
        deltas.fail(error);
        throw error;
      },
    );
    void runPromise.catch(() => undefined);

    try {
      for (;;) {
        const next = await deltas.next();
        if (next.done) break;
        yield next.value;
      }
      await runPromise;
    } finally {
      if (!settled) {
        consumerAbort.abort(
          new DOMException("Agent stream consumer cancelled", "AbortError"),
        );
      }
      try {
        await runPromise;
      } catch {
        // The queue already delivered run failures. Consumer cancellation is
        // intentionally represented by iterator return rather than rethrowing.
      }
    }
  }

  async reset(sessionId?: string): Promise<void> {
    const targets = sessionId
      ? [...this.sessions.entries()].filter(([id]) => id === sessionId)
      : [...this.sessions.entries()];
    for (const [, entry] of targets) {
      entry.closed = true;
      entry.agent.abort();
    }
    await Promise.all(targets.map(([, entry]) => entry.gate));
    for (const [id, entry] of targets) {
      await entry.agent.waitForIdle();
      entry.agent.reset();
      if (this.sessions.get(id) === entry) this.sessions.delete(id);
    }
  }

  private async runRequest(
    request: AgentRequest,
    options: AgentExecutionOptions,
    callbacks: RunCallbacks,
  ): Promise<AgentResponse> {
    try {
      validateRequest(request);
      const runtime = this.getRuntime();
      const entry = this.getOrCreateSession(request.sessionId, runtime);
      const release = await this.acquireSession(entry, options.signal);
      try {
        return await this.runAgent(
          entry,
          runtime,
          request,
          options.signal,
          callbacks,
        );
      } finally {
        release();
      }
    } catch (error) {
      throw normalizeExecutorError(error, options.signal);
    }
  }

  private async runAgent(
    entry: SessionEntry,
    runtime: ResolvedRuntime,
    request: AgentRequest,
    signal: AbortSignal | undefined,
    callbacks: RunCallbacks,
  ): Promise<AgentResponse> {
    if (entry.closed) {
      throw new PiAgentError(
        "cancelled",
        `Agent session "${entry.id}" was reset before execution`,
      );
    }
    entry.agent.state.systemPrompt =
      request.systemPrompt ?? runtime.config.systemPrompt;

    const images = await normalizePiImages(request, {
      localImageRoots: this.options.localImageRoots,
      maxImageBytes: this.options.maxImageBytes,
    });
    if (images && !runtime.model.input.includes("image")) {
      throw new PiAgentError(
        "model",
        `Model "${runtime.model.id}" does not support image input`,
      );
    }
    if (signal?.aborted) {
      throw new PiAgentError("cancelled", "Agent request was cancelled", {
        cause: signal.reason,
      });
    }

    const startingMessages = entry.agent.state.messages.slice();
    const assistantMessages: AssistantMessage[] = [];
    let streamedText = "";
    const runState: { lastAssistant: AssistantMessage | undefined } = {
      lastAssistant: undefined,
    };
    const unsubscribe = entry.agent.subscribe((event) => {
      const delta = signal?.aborted ? undefined : textDelta(event);
      if (delta !== undefined && delta.length > 0) {
        streamedText += delta;
        callbacks.onDelta?.(delta);
        this.publisher?.publish({
          type: "agent.delta",
          request,
          text: delta,
          timestamp: Date.now(),
        });
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        runState.lastAssistant = event.message;
        assistantMessages.push(event.message);
      }
    });

    let onAbort: (() => void) | undefined;
    try {
      const promptPromise = entry.agent.prompt(request.content, images);
      if (signal) {
        onAbort = () => entry.agent.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      await promptPromise;
      if (signal?.aborted) {
        if (signal.reason instanceof PiAgentError) throw signal.reason;
        throw new PiAgentError("cancelled", "Agent request was cancelled", {
          cause: signal.reason,
        });
      }

      const finalAssistant = runState.lastAssistant;
      if (!finalAssistant) {
        throw new PiAgentError(
          "execution",
          `Pi Agent completed without an assistant response for session "${entry.id}"`,
        );
      }
      if (
        finalAssistant.stopReason === "error" ||
        finalAssistant.stopReason === "aborted" ||
        finalAssistant.errorMessage
      ) {
        throw errorFromAssistant(finalAssistant);
      }

      const response: AgentResponse = {
        text:
          streamedText.length > 0
            ? streamedText
            : assistantMessages.map(assistantText).join(""),
        model: finalAssistant.responseModel ?? finalAssistant.model,
        provider: finalAssistant.provider,
        ...(assistantMessages.length > 0
          ? { usage: sumUsage(assistantMessages) }
          : {}),
      };

      return response;
    } catch (error) {
      entry.agent.state.messages = startingMessages;
      throw error;
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  }

  private getRuntime(): ResolvedRuntime {
    if (this.runtime) return this.runtime;

    const injectedModels = this.options.models?.getModels() ?? [];
    const inferredModel =
      this.options.model ??
      (injectedModels.length === 1 ? injectedModels[0] : undefined);
    const config = resolvePiAgentConfig(this.configInput, {
      ...(inferredModel
        ? { provider: inferredModel.provider, model: inferredModel.id }
        : {}),
      ...(this.options.maxSessions !== undefined
        ? { maxSessions: this.options.maxSessions }
        : {}),
    });

    let models = this.options.models;
    let model = inferredModel;
    let availableModels: MutableModels | undefined;
    let selectedProvider = models?.getProvider(config.provider);
    if (!selectedProvider) {
      availableModels = builtinModels();
      selectedProvider = availableModels.getProvider(config.provider);
    }
    if (
      selectedProvider &&
      !isPiProviderApiKeyConfigurable(selectedProvider)
    ) {
      throw new PiAgentError(
        "configuration",
        `Pi provider "${selectedProvider.id}" is OAuth-only and cannot be configured with an API key`,
      );
    }
    if (!model && models) {
      if (!models.getProvider(config.provider)) {
        throw new PiAgentError(
          "provider",
          `Unknown pi provider "${config.provider}"`,
        );
      }
      model = models.getModel(config.provider, config.model);
      if (!model) {
        throw new PiAgentError(
          "model",
          `Unknown model "${config.model}" for pi provider "${config.provider}"`,
        );
      }
    }

    if (!model && config.openAICompatible) {
      const mutableModels = availableModels ?? builtinModels();
      model = registerCompatibleProvider(mutableModels, config);
      models = mutableModels;
    }

    if (!model) {
      const availableBuiltinModels = availableModels ?? builtinModels();
      if (!availableBuiltinModels.getProvider(config.provider)) {
        throw new PiAgentError(
          "provider",
          `Unknown pi provider "${config.provider}"`,
        );
      }
      model = availableBuiltinModels.getModel(config.provider, config.model);
      if (!model) {
        throw new PiAgentError(
          "model",
          `Unknown model "${config.model}" for pi provider "${config.provider}"`,
        );
      }
      models = availableBuiltinModels;
    }
    if (
      !config.openAICompatible &&
      isPiModelBaseUrlOverride(config.baseUrl, model.baseUrl) &&
      config.apiKey === undefined &&
      !hasAuthorizationHeader(config.headers)
    ) {
      throw new PiAgentError(
        "auth",
        "A custom agent.baseUrl requires an explicitly configured agent.apiKey or credential header",
      );
    }

    if (!this.options.model && !config.openAICompatible) {
      model = applyModelOverrides(model, config);
    }

    let baseStream = this.options.streamFn;
    if (!baseStream) {
      if (!models?.getProvider(model.provider)) {
        throw new PiAgentError(
          "provider",
          `No pi Models provider is available for injected model "${model.provider}/${model.id}"`,
        );
      }
      const resolvedModels = models;
      baseStream = (requestModel, context, streamOptions) =>
        resolvedModels.streamSimple(requestModel, context, streamOptions);
    }
    const contextWindow = model.contextWindow;
    const maxOutputTokens = Math.max(1, Math.min(model.maxTokens, Math.floor(contextWindow / 2)));
    const maxInputTokens = Math.floor((contextWindow - maxOutputTokens) * 0.9);
    const streamFn = withConfiguredSampling(baseStream, config, maxOutputTokens);
    this.runtime = { config, model, streamFn, maxInputTokens };
    return this.runtime;
  }

  private getOrCreateSession(
    sessionId: string,
    runtime: ResolvedRuntime,
  ): SessionEntry {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.closed) {
        throw new PiAgentError(
          "cancelled",
          `Agent session "${sessionId}" is being reset`,
        );
      }
      this.touchSession(sessionId, existing);
      return existing;
    }

    if (this.sessions.size >= runtime.config.maxSessions) {
      let evicted = false;
      for (const [candidateId, candidate] of this.sessions) {
        if (
          candidate.reservations === 0 &&
          !candidate.closed &&
          !candidate.agent.state.isStreaming
        ) {
          candidate.agent.reset();
          this.sessions.delete(candidateId);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        throw new PiAgentError(
          "session-limit",
          `All ${runtime.config.maxSessions} retained agent sessions are busy`,
        );
      }
    }

    const tools = runtime.config.tools
      ? [
          ...(this.options.tools ?? []),
          ...(this.options.toolsForSession?.(sessionId) ?? []),
        ]
      : [];
    const toolTokens = tools.length === 0 ? 0 : estimateTokens({
      role: "user",
      content: JSON.stringify(tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }))),
      timestamp: 0,
    });
    const agent: Agent = new Agent({
      initialState: {
        model: runtime.model,
        systemPrompt: runtime.config.systemPrompt,
        thinkingLevel: runtime.config.thinkingLevel,
        tools,
      },
      streamFn: runtime.streamFn,
      transformContext: async (messages, signal) => {
        signal?.throwIfAborted();
        return boundSessionContext(agent, messages, runtime.maxInputTokens, toolTokens);
      },
      ...(runtime.config.apiKey
        ? { getApiKey: () => runtime.config.apiKey }
        : {}),
      sessionId,
    });
    const entry: SessionEntry = {
      id: sessionId,
      agent,
      gate: Promise.resolve(),
      reservations: 0,
      closed: false,
    };
    this.sessions.set(sessionId, entry);
    return entry;
  }

  private async acquireSession(
    entry: SessionEntry,
    signal: AbortSignal | undefined,
  ): Promise<() => void> {
    const previous = entry.gate;
    let releaseGate = (): void => undefined;
    entry.gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    entry.reservations += 1;

    try {
      await waitForTurn(previous, signal);
    } catch (error) {
      void previous.then(releaseGate, releaseGate);
      entry.reservations -= 1;
      throw error;
    }
    if (entry.closed) {
      entry.reservations -= 1;
      releaseGate();
      throw new PiAgentError(
        "cancelled",
        `Agent session "${entry.id}" was reset before execution`,
      );
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.reservations -= 1;
      releaseGate();
      if (this.sessions.get(entry.id) === entry && !entry.closed) {
        this.touchSession(entry.id, entry);
      }
    };
  }

  private touchSession(id: string, entry: SessionEntry): void {
    this.sessions.delete(id);
    this.sessions.set(id, entry);
  }
}

export function createPiAgentExecutor(
  config: unknown,
  options: PiAgentExecutorOptions = {},
): PiAgentExecutor {
  return new PiAgentExecutor(config, options);
}

function contextMessageTokens(message: AgentMessage): number {
  // Include message framing even for empty text and tool results.
  return estimateTokens(message) + 8;
}

function boundSessionContext(
  agent: Agent,
  messages: AgentMessage[],
  maxInputTokens: number,
  toolTokens: number,
): AgentMessage[] {
  const prefixTokens = toolTokens + contextMessageTokens({
    role: "user",
    content: agent.state.systemPrompt,
    timestamp: 0,
  });
  const usage = estimateContextTokens(messages);
  let estimatedTokens = prefixTokens;
  let measuredPrefixTokens = prefixTokens;
  let currentTurnStart = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const tokens = contextMessageTokens(message);
    estimatedTokens += tokens;
    if (usage.lastUsageIndex !== null && index <= usage.lastUsageIndex) {
      measuredPrefixTokens += tokens;
    }
    if (message.role === "user") currentTurnStart = index;
  }
  // Provider usage calibrates Pi's heuristic for the active model/language.
  // After dropping history, old usage includes that prefix and cannot be
  // treated as the token count of the retained suffix.
  const ratio = Math.max(1, usage.usageTokens / measuredPrefixTokens);
  let start = 0;
  while (Math.ceil(estimatedTokens * ratio) > maxInputTokens && start < currentTurnStart) {
    do {
      estimatedTokens -= contextMessageTokens(messages[start++]!);
    } while (start < currentTurnStart && messages[start]!.role !== "user");
  }
  if (Math.ceil(estimatedTokens * ratio) > maxInputTokens) {
    throw new PiAgentError(
      "execution",
      `Agent context exceeds the ${maxInputTokens}-token input budget even without older turns; reduce the current input, system prompt, tools, or maximum output tokens`,
    );
  }
  if (start > 0) {
    // Cut complete user turns, never orphaning a tool result or truncating the
    // current request. Persist the cut so evicted history releases its memory.
    messages.splice(0, start);
    agent.state.messages = messages;
  }
  return messages;
}

function registerCompatibleProvider(
  models: MutableModels,
  config: ResolvedPiAgentConfig,
): Model<"openai-completions"> {
  const baseUrl =
    config.baseUrl ?? defaultPiCompatibleBaseUrl(config.provider);
  if (!baseUrl) {
    throw new PiAgentError(
      "configuration",
      `No base URL is configured for OpenAI-compatible provider "${config.provider}"`,
    );
  }
  const model: Model<"openai-completions"> = {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: config.provider,
    baseUrl,
    reasoning: config.reasoning,
    input: [...config.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    ...(config.headers ? { headers: { ...config.headers } } : {}),
  };
  const provider = createProvider({
    id: config.provider,
    name: `${config.provider} (OpenAI-compatible)`,
    baseUrl,
    auth: {
      apiKey: {
        name: `${config.provider} API key`,
        resolve: async ({ ctx, credential, signal }) => {
          signal.throwIfAborted();
          if (credential?.key) {
            return { auth: { apiKey: credential.key }, source: "configured API key" };
          }
          if (canUsePiEnvironmentCredential(config)) {
            for (const envName of piAgentEnvironmentKeys(config.credentialProvider)) {
              const key = await ctx.env(envName);
              signal.throwIfAborted();
              if (key) return { auth: { apiKey: key }, source: envName };
            }
          }
          if (config.allowKeyless || hasAuthorizationHeader(config.headers)) {
            return { auth: { apiKey: "unused" }, source: "keyless endpoint" };
          }
          return undefined;
        },
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
  models.setProvider(provider);
  return model;
}

function applyModelOverrides(
  model: Model<Api>,
  config: ResolvedPiAgentConfig,
): Model<Api> {
  const overrides = config.modelOverrides;
  if (
    !config.baseUrl &&
    !config.headers &&
    overrides.contextWindow === undefined &&
    overrides.maxTokens === undefined &&
    overrides.reasoning === undefined &&
    overrides.input === undefined
  ) {
    return model;
  }
  return {
    ...model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.headers
      ? { headers: { ...model.headers, ...config.headers } }
      : {}),
    ...(overrides.contextWindow === undefined
      ? {}
      : { contextWindow: overrides.contextWindow }),
    ...(overrides.maxTokens === undefined
      ? {}
      : { maxTokens: overrides.maxTokens }),
    ...(overrides.reasoning === undefined
      ? {}
      : { reasoning: overrides.reasoning }),
    ...(overrides.input === undefined
      ? {}
      : { input: [...overrides.input] }),
  };
}

function withConfiguredSampling(
  streamFn: StreamFn,
  config: ResolvedPiAgentConfig,
  maxOutputTokens: number,
): StreamFn {
  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => {
    const samplingParams =
      config.samplingParams || options?.samplingParams
        ? { ...config.samplingParams, ...options?.samplingParams }
        : undefined;
    return streamFn(model, context, {
      ...options,
      maxTokens: Math.min(options?.maxTokens ?? maxOutputTokens, maxOutputTokens),
      ...(samplingParams ? { samplingParams } : {}),
    });
  };
}

function hasAuthorizationHeader(
  headers: Readonly<Record<string, string>> | undefined,
): boolean {
  return Object.keys(headers ?? {}).some(isPiCredentialHeaderName);
}

function validateRequest(request: AgentRequest): void {
  if (request.sessionId.trim().length === 0) {
    throw new PiAgentError(
      "configuration",
      "Agent request sessionId must not be empty",
    );
  }
}

function textDelta(event: AgentEvent): string | undefined {
  if (
    event.type !== "message_update" ||
    event.assistantMessageEvent.type !== "text_delta"
  ) {
    return undefined;
  }
  return event.assistantMessageEvent.delta;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

function sumUsage(messages: readonly AssistantMessage[]): AgentUsage {
  const total = messages.reduce<Usage>(
    (usage, message) => ({
      input: usage.input + message.usage.input,
      output: usage.output + message.usage.output,
      cacheRead: usage.cacheRead + message.usage.cacheRead,
      cacheWrite: usage.cacheWrite + message.usage.cacheWrite,
      totalTokens: usage.totalTokens + message.usage.totalTokens,
      cost: {
        input: usage.cost.input + message.usage.cost.input,
        output: usage.cost.output + message.usage.cost.output,
        cacheRead: usage.cost.cacheRead + message.usage.cost.cacheRead,
        cacheWrite: usage.cost.cacheWrite + message.usage.cost.cacheWrite,
        total: usage.cost.total + message.usage.cost.total,
      },
    }),
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  );
  return {
    input: total.input,
    output: total.output,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite,
    totalTokens: total.totalTokens,
  };
}

function errorFromAssistant(message: AssistantMessage): PiAgentError {
  const detail = message.errorMessage ?? `Pi Agent stopped with ${message.stopReason}`;
  return new PiAgentError(classifyMessage(detail), detail);
}

function classifyMessage(message: string): PiAgentErrorCode {
  if (/abort|cancel/iu.test(message)) return "cancelled";
  if (
    /api[ -]?key|auth(?:entication|orization)?|credential|unauthorized|forbidden|\b401\b|\b403\b|not configured/iu.test(
      message,
    )
  ) {
    return "auth";
  }
  if (/unknown provider|provider .*no api|provider not found/iu.test(message)) {
    return "provider";
  }
  if (/unknown model|model .*not found|invalid model|unsupported model/iu.test(message)) {
    return "model";
  }
  return "execution";
}

function normalizeExecutorError(
  error: unknown,
  signal: AbortSignal | undefined,
): PiAgentError {
  if (error instanceof PiAgentError) return error;
  if (
    signal?.aborted ||
    (error instanceof DOMException && error.name === "AbortError")
  ) {
    return new PiAgentError("cancelled", "Agent request was cancelled", {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new PiAgentError(classifyMessage(message), message, { cause: error });
}

async function waitForTurn(
  previous: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }
  if (signal.aborted) {
    throw new PiAgentError("cancelled", "Agent request was cancelled", {
      cause: signal.reason,
    });
  }

  let onAbort = (): void => undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => {
        reject(
          new PiAgentError("cancelled", "Agent request was cancelled", {
            cause: signal.reason,
          }),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void previous.then(resolve, reject);
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  name: "maxStreamBufferBytes" | "maxStreamBufferChunks",
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new PiAgentError(
      "configuration",
      `Pi Agent executor ${name} must be a positive integer`,
    );
  }
  return resolved;
}

class DeltaQueue {
  private readonly values: Array<string | undefined> = [];
  private readonly byteLengths: number[] = [];
  private readonly maxBufferedBytes: number;
  private readonly maxBufferedChunks: number;
  private head = 0;
  private bufferedBytes = 0;
  private waiter: QueueWaiter | undefined;
  private failure: unknown;
  private hasFailure = false;
  private ended = false;

  constructor(maxBufferedBytes: number, maxBufferedChunks: number) {
    this.maxBufferedBytes = maxBufferedBytes;
    this.maxBufferedChunks = maxBufferedChunks;
  }

  push(value: string): PiAgentError | undefined {
    if (value.length === 0 || this.ended) return undefined;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter.resolve({ value, done: false });
      return undefined;
    }

    if (this.bufferedChunks >= this.maxBufferedChunks) {
      return this.overflow(
        "maxStreamBufferChunks",
        this.maxBufferedChunks,
      );
    }
    const byteLength = Buffer.byteLength(value, "utf8");
    if (byteLength > this.maxBufferedBytes - this.bufferedBytes) {
      return this.overflow("maxStreamBufferBytes", this.maxBufferedBytes);
    }

    this.values.push(value);
    this.byteLengths.push(byteLength);
    this.bufferedBytes += byteLength;
    return undefined;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.bufferedChunks === 0 && this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = error;
    this.hasFailure = true;
    this.ended = true;
    if (this.bufferedChunks === 0 && this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      this.failure = undefined;
      this.hasFailure = false;
      waiter.reject(error);
    }
  }

  next(): Promise<IteratorResult<string>> {
    const value = this.dequeue();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.hasFailure) {
      const failure = this.failure;
      this.failure = undefined;
      this.hasFailure = false;
      return Promise.reject(failure);
    }
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<string>>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  private get bufferedChunks(): number {
    return this.values.length - this.head;
  }

  private dequeue(): string | undefined {
    if (this.head === this.values.length) return undefined;

    const value = this.values[this.head];
    const byteLength = this.byteLengths[this.head] ?? 0;
    this.values[this.head] = undefined;
    this.byteLengths[this.head] = 0;
    this.head += 1;
    this.bufferedBytes -= byteLength;

    if (this.head === this.values.length) {
      this.discardBuffered();
    } else if (
      this.head >= DELTA_QUEUE_COMPACTION_THRESHOLD &&
      this.head >= this.bufferedChunks
    ) {
      this.compact();
    }
    return value;
  }

  private compact(): void {
    const remaining = this.bufferedChunks;
    this.values.copyWithin(0, this.head);
    this.values.length = remaining;
    this.byteLengths.copyWithin(0, this.head);
    this.byteLengths.length = remaining;
    this.head = 0;
  }

  private overflow(
    optionName: "maxStreamBufferBytes" | "maxStreamBufferChunks",
    limit: number,
  ): PiAgentError {
    const error = new PiAgentError(
      "execution",
      `Pi Agent stream buffer overflow: ${optionName} limit of ${limit} exceeded`,
    );
    this.discardBuffered();
    this.fail(error);
    return error;
  }

  private discardBuffered(): void {
    this.values.length = 0;
    this.byteLengths.length = 0;
    this.head = 0;
    this.bufferedBytes = 0;
  }
}
