import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Provider } from "@earendil-works/pi-ai";

import { PiAgentError } from "./errors.js";

type JsonRecord = Record<string, unknown>;
export type PiAgentModelInput = "text" | "image";
export type PiAgentMode = "llm" | "reread" | "disabled";

/** Whether a Pi provider exposes an API-key or ambient-credential auth path. */
export function isPiProviderApiKeyConfigurable(
  provider: Pick<Provider, "auth">,
): boolean {
  return provider.auth.apiKey !== undefined;
}

export const PI_AGENT_MODES = [
  { id: "llm", name: "LLM" },
  { id: "reread", name: "Reread" },
  { id: "disabled", name: "Disabled" },
] as const satisfies readonly {
  readonly id: PiAgentMode;
  readonly name: string;
}[];

export const PI_AGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

export const DEFAULT_PI_AGENT_MAX_SESSIONS = 100;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const DEFAULT_COMPATIBLE_BASE_URLS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  moonshotai: "https://api.moonshot.ai/v1",
  "moonshotai-cn": "https://api.moonshot.cn/v1",
  deepseek: "https://api.deepseek.com",
  openrouter: "https://openrouter.ai/api/v1",
};

const ENV_KEYS_BY_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  openai: ["OPENAI_API_KEY"],
  qwen: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

const OBSOLETE_LLM_ROOT_FIELDS: Readonly<Record<string, true>> = {
  chat_type: true,
  system_prompt: true,
  provider: true,
  openai: true,
  chatgpt: true,
  gpt4free: true,
  claude: true,
  claude2: true,
  chatglm: true,
  qwen: true,
  chat_with_file: true,
  chatterbot: true,
  text_generation_webui: true,
  sparkdesk: true,
  langchain_chatglm: true,
  langchain_chatchat: true,
  zhipu: true,
  bard: true,
  tongyixingchen: true,
  my_wenxinworkshop: true,
  gemini: true,
  qanything: true,
  koboldcpp: true,
  anythingllm: true,
  tongyi: true,
  dify: true,
  volcengine: true,
  custom_llm: true,
  llm_tpu: true,
};
const OBSOLETE_AGENT_FIELDS: Readonly<Record<string, string>> = {
  api_key: "apiKey",
  api_keys: "apiKey",
  base_url: "baseUrl",
  system_prompt: "systemPrompt",
  max_tokens: "maxTokens",
  context_window: "contextWindow",
  max_sessions: "maxSessions",
  thinking_level: "thinkingLevel",
  input_types: "input",
  vision: "input",
  sampling_params: "samplingParams",
  openai_compatible: "openAICompatible",
  api_type: "apiType",
};


export interface ResolvePiAgentConfigOptions {
  /** Overrides used when the caller injects a preselected pi model. */
  readonly provider?: string;
  readonly model?: string;
  readonly maxSessions?: number;
}

export interface PiAgentModelOverrides {
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly input?: readonly PiAgentModelInput[];
}

/** Normalized configuration used by the pi executor and exposed for diagnostics. */
export interface ResolvedPiAgentConfig {
  readonly provider: string;
  /** Provider identity that owns inherited/environment credentials for this endpoint. */
  readonly credentialProvider: string;
  /** True when the selected endpoint credential is still a WebUI redaction marker. */
  readonly credentialRedacted: boolean;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly systemPrompt: string;
  readonly openAICompatible: boolean;
  readonly allowKeyless: boolean;
  readonly maxSessions: number;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly input: readonly PiAgentModelInput[];
  readonly tools: boolean;
  readonly thinkingLevel: ThinkingLevel;
  readonly samplingParams?: Readonly<Record<string, unknown>>;
  /** Only fields explicitly selected by configuration; safe to apply to builtin metadata. */
  readonly modelOverrides: PiAgentModelOverrides;
}

function assertNoObsoleteLlmFields(root: JsonRecord): void {
  for (const field in OBSOLETE_LLM_ROOT_FIELDS) {
    if (!Object.hasOwn(root, field)) continue;
    throw new PiAgentError(
      "configuration",
      `${field} is no longer supported; configure root agent instead`,
    );
  }
  const agent = asRecord(root.agent);
  if (agent) {
    for (const field in OBSOLETE_AGENT_FIELDS) {
      const canonical = OBSOLETE_AGENT_FIELDS[field]!;
      if (!Object.hasOwn(agent, field)) continue;
      throw new PiAgentError(
        "configuration",
        `agent.${field} is no longer supported; use agent.${canonical} instead`,
      );
    }
    if (Object.hasOwn(agent, "temperature")) {
      throw new PiAgentError(
        "configuration",
        "agent.temperature has been removed; the selected provider and model now use their default temperature",
      );
    }
    const samplingParams = asRecord(agent.samplingParams);
    if (samplingParams && Object.hasOwn(samplingParams, "temperature")) {
      throw new PiAgentError(
        "configuration",
        "agent.samplingParams.temperature is not supported; the selected provider and model must control the default temperature",
      );
    }
  }
}


/** Resolves the canonical root `agent` configuration for Pi execution. */
export function resolvePiAgentConfig(
  input: unknown,
  options: ResolvePiAgentConfigOptions = {},
): ResolvedPiAgentConfig {
  const root = asRecord(input);
  if (!root) {
    throw new PiAgentError(
      "configuration",
      "Agent configuration must be a JSON object",
    );
  }
  assertNoObsoleteLlmFields(root);

  const agent = asRecord(root.agent);
  if (!agent) {
    throw new PiAgentError(
      "configuration",
      "Agent configuration must include an agent object",
    );
  }

  const rawProvider =
    nonEmptyString(options.provider) ?? nonEmptyString(agent.provider);
  if (!rawProvider) {
    throw new PiAgentError(
      "configuration",
      "No agent provider is configured; set agent.provider and agent.model",
    );
  }

  const provider = normalizePiAgentProvider(rawProvider);
  const model =
    nonEmptyString(options.model) ?? nonEmptyString(agent.model);
  if (!model) {
    throw new PiAgentError(
      "configuration",
      `No model is configured for provider "${provider}"`,
    );
  }

  const configuredEndpoint = nonEmptyString(agent.baseUrl);
  const baseUrl = configuredEndpoint
    ? normalizeBaseUrl(configuredEndpoint)
    : provider === "qwen"
      ? defaultPiCompatibleBaseUrl(provider)
      : undefined;
  const explicitCompatibility =
    typeof agent.openAICompatible === "boolean"
      ? agent.openAICompatible
      : undefined;
  const apiKind = nonEmptyString(agent.apiType);
  const openAICompatible =
    explicitCompatibility ?? apiKind === "openai-completions";
  const inferredOpenAICompatibility =
    provider === "openai-compatible" || provider === "qwen";
  const useOpenAICompatibility = openAICompatible || inferredOpenAICompatibility;
  const credentialRedacted = hasRedactedCredential(agent);
  const apiKey = pickSecret(agent.apiKey);

  if (provider === "openai-compatible" && !baseUrl) {
    throw new PiAgentError(
      "configuration",
      "An OpenAI-compatible provider requires agent.baseUrl",
    );
  }

  const allowKeyless =
    useOpenAICompatibility &&
    baseUrl !== undefined &&
    isLoopbackUrl(baseUrl);
  const maxSessions = resolvePositiveInteger(
    options.maxSessions ?? agent.maxSessions,
    "agent.maxSessions",
    DEFAULT_PI_AGENT_MAX_SESSIONS,
  );
  const contextWindowValue = agent.contextWindow;
  const contextWindowConfigured = contextWindowValue !== undefined;
  const contextWindow = resolvePositiveInteger(
    contextWindowValue,
    "agent.contextWindow",
    DEFAULT_CONTEXT_WINDOW,
  );
  const maxTokensValue = agent.maxTokens;
  const maxTokensConfigured = maxTokensValue !== undefined;
  const maxTokens = resolvePositiveInteger(
    maxTokensValue,
    "agent.maxTokens",
    Math.min(DEFAULT_MAX_TOKENS, contextWindow),
  );
  const reasoningOverride =
    typeof agent.reasoning === "boolean" ? agent.reasoning : undefined;
  const reasoning = reasoningOverride ?? false;
  const tools = typeof agent.tools === "boolean" ? agent.tools : true;
  const inputValue = agent.input;
  const inputConfigured =
    Array.isArray(inputValue) &&
    inputValue.length > 0 &&
    inputValue.every((value) => value === "text" || value === "image");
  const inputTypes = resolveInputTypes(inputValue);
  const thinkingLevel = resolveThinkingLevel(agent.thinkingLevel);
  const systemPrompt =
    typeof agent.systemPrompt === "string" ? agent.systemPrompt : "";
  const headers = pickHeaders(agent.headers);
  const samplingParams = pickSamplingParams(agent.samplingParams);
  const modelOverrides: PiAgentModelOverrides = {
    ...(contextWindowConfigured ? { contextWindow } : {}),
    ...(maxTokensConfigured ? { maxTokens } : {}),
    ...(reasoningOverride === undefined ? {} : { reasoning }),
    ...(inputConfigured ? { input: inputTypes } : {}),
  };

  return {
    provider,
    credentialProvider: provider,
    credentialRedacted,
    model,
    systemPrompt,
    openAICompatible: useOpenAICompatibility,
    allowKeyless,
    maxSessions,
    contextWindow,
    maxTokens,
    reasoning,
    input: inputTypes,
    tools,
    thinkingLevel,
    modelOverrides,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(headers ? { headers } : {}),
    ...(samplingParams ? { samplingParams } : {}),
  };
}

export const DEFAULT_IMAGE_TRANSCRIPTION_SYSTEM_PROMPT =
  "你是专用视觉转述模型。请仅根据输入图片，客观、准确、简洁地转述可见内容，不要臆测图片之外的信息。";

/** Builds the isolated Pi Agent input used by the fallback visual model. */
export function imagePiAgentConfigInput(input: unknown): JsonRecord | undefined {
  const root = asRecord(input);
  const imageRecognition = asRecord(root?.image_recognition);
  if (imageRecognition?.enable !== true) return undefined;

  return {
    agent: {
      ...imageRecognition,
      mode: "llm",
      systemPrompt:
        typeof imageRecognition.systemPrompt === "string"
          ? imageRecognition.systemPrompt
          : DEFAULT_IMAGE_TRANSCRIPTION_SYSTEM_PROMPT,
      input: ["text", "image"],
      tools: false,
    },
  };
}

/** Resolves the dedicated image-transcription model through Pi Agent. */
export function resolveImagePiAgentConfig(
  input: unknown,
): ResolvedPiAgentConfig | undefined {
  const dedicated = imagePiAgentConfigInput(input);
  if (dedicated === undefined) return undefined;

  try {
    return resolvePiAgentConfig(dedicated);
  } catch (error) {
    if (!(error instanceof PiAgentError)) throw error;
    throw new PiAgentError(
      error.code,
      error.message
        .replaceAll("agent.", "image_recognition.")
        .replaceAll("Agent configuration", "Image recognition configuration"),
      { cause: error },
    );
  }
}

/** Resolve the event-pipeline mode from the canonical `agent` section. */
export function resolvePiAgentMode(input: unknown): PiAgentMode {
  const root = asRecord(input);
  if (!root) {
    throw new PiAgentError(
      "configuration",
      "Agent configuration must be a JSON object",
    );
  }
  assertNoObsoleteLlmFields(root);

  const agent = asRecord(root.agent);
  if (!agent) {
    if (Object.hasOwn(root, "agent")) {
      throw new PiAgentError(
        "configuration",
        "agent must be a JSON object",
      );
    }
    return "disabled";
  }
  if (agent.mode === undefined) {
    return "disabled";
  }
  if (typeof agent.mode !== "string") {
    throw new PiAgentError(
      "configuration",
      "agent.mode must be llm, reread, or disabled",
    );
  }
  const mode = agent.mode.trim().toLowerCase();
  if (mode === "llm" || mode === "reread" || mode === "disabled") {
    return mode;
  }
  throw new PiAgentError(
    "configuration",
    "agent.mode must be llm, reread, or disabled",
  );
}

export function defaultPiCompatibleBaseUrl(
  provider: string,
): string | undefined {
  return DEFAULT_COMPATIBLE_BASE_URLS[normalizePiAgentProvider(provider)];
}

export function canUsePiEnvironmentCredential(
  config: Pick<
    ResolvedPiAgentConfig,
    "baseUrl" | "credentialProvider" | "openAICompatible" | "provider"
  >,
): boolean {
  if (!config.openAICompatible) return true;
  const credentialBaseUrl = defaultPiCompatibleBaseUrl(
    config.credentialProvider,
  );
  const effectiveBaseUrl =
    config.baseUrl ?? defaultPiCompatibleBaseUrl(config.provider);
  return (
    credentialBaseUrl !== undefined &&
    effectiveBaseUrl !== undefined &&
    normalizeBaseUrl(credentialBaseUrl) === normalizeBaseUrl(effectiveBaseUrl)
  );
}

export function isPiModelBaseUrlOverride(
  configuredBaseUrl: string | undefined,
  modelBaseUrl: string,
): boolean {
  if (configuredBaseUrl === undefined) return false;
  if (modelBaseUrl.trim() === "") return true;
  return normalizeBaseUrl(configuredBaseUrl) !== normalizeBaseUrl(modelBaseUrl);
}

export function piAgentEnvironmentKeys(
  provider: string,
): readonly string[] {
  return ENV_KEYS_BY_PROVIDER[normalizePiAgentProvider(provider)] ?? [];
}

/** Selected canonical provider before model validation, useful for safe credential status. */
export function configuredPiAgentProvider(input: unknown): string | undefined {
  const root = asRecord(input);
  if (!root) return undefined;
  assertNoObsoleteLlmFields(root);

  const agent = asRecord(root.agent);
  const configured = agent === undefined
    ? undefined
    : nonEmptyString(agent.provider);
  if (!configured) return undefined;
  return normalizePiAgentProvider(configured);
}

/** Checks the resolved endpoint-bound configuration without returning a secret. */
export function hasConfiguredPiAgentCredential(input: unknown): boolean {
  try {
    const config = resolvePiAgentConfig(input);
    return (
      config.apiKey !== undefined ||
      Object.keys(config.headers ?? {}).some(isPiCredentialHeaderName)
    );
  } catch {
    return false;
  }
}

export function isPiCredentialHeaderName(name: string): boolean {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z\d]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return (
    normalized === "authorization" ||
    normalized === "proxy-authorization" ||
    normalized === "api-key" ||
    normalized === "x-api-key" ||
    /(?:^|-)(?:access|api|auth|secret|subscription)-key$/u.test(normalized)
  );
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}


export function normalizePiAgentProvider(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/gu, "-");
}


function hasRedactedCredential(agent: JsonRecord): boolean {
  return (
    containsRedactedMarker(agent.apiKey) ||
    containsRedactedMarker(agent.headers)
  );
}

function containsRedactedMarker(value: unknown): boolean {
  if (value === "[REDACTED]") return true;
  if (Array.isArray(value)) return value.some(containsRedactedMarker);
  const record = asRecord(value);
  return record !== undefined &&
    Object.values(record).some(containsRedactedMarker);
}

function pickSecret(value: unknown): string | undefined {
  const secret = nonEmptyString(value);
  return secret && !isPlaceholderSecret(secret) ? secret : undefined;
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "api-key" ||
    normalized === "api_key" ||
    normalized === "sk-xxx" ||
    normalized === "your-api-key" ||
    normalized === "your api key" ||
    normalized.includes("你的api key") ||
    normalized.includes("your openai api key")
  );
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PiAgentError(
      "configuration",
      "Invalid agent base URL; use an absolute HTTP or HTTPS URL",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PiAgentError(
      "configuration",
      "Agent base URL must use HTTP or HTTPS",
    );
  }
  if (url.username || url.password) {
    throw new PiAgentError(
      "configuration",
      "Agent base URL must not contain URL credentials; configure authentication separately",
    );
  }
  if (url.search || url.hash) {
    throw new PiAgentError(
      "configuration",
      "Agent base URL must not contain a query or fragment",
    );
  }

  url.pathname = url.pathname
    .replace(/\/(?:chat\/completions|responses)\/?$/iu, "")
    .replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function resolvePositiveInteger(
  value: unknown,
  label: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new PiAgentError(
      "configuration",
      `${label} must be a positive integer`,
    );
  }
  return value;
}

function resolveThinkingLevel(value: unknown): ThinkingLevel {
  if (value === undefined) return "off";
  if (
    typeof value === "string" &&
    PI_AGENT_THINKING_LEVELS.includes(
      value as (typeof PI_AGENT_THINKING_LEVELS)[number],
    )
  ) {
    return value as ThinkingLevel;
  }
  throw new PiAgentError(
    "configuration",
    "agent.thinkingLevel must be off, minimal, low, medium, high, xhigh, or max",
  );
}

function resolveInputTypes(value: unknown): readonly PiAgentModelInput[] {
  if (!Array.isArray(value)) return ["text"];
  let hasText = false;
  let hasImage = false;
  for (const input of value) {
    if (input === "text") hasText = true;
    if (input === "image") hasImage = true;
  }
  if (hasImage && hasText) return ["text", "image"];
  if (hasImage) return ["image"];
  return ["text"];
}

function pickHeaders(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(record)) {
    const valueString = nonEmptyString(headerValue);
    if (valueString) headers[name] = valueString;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function pickSamplingParams(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const configured = asRecord(value);
  return configured && Object.keys(configured).length > 0
    ? { ...configured }
    : undefined;
}
