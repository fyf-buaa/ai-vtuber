import {
  type Api,
  type AuthContext,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  containsEmbeddedSecret,
  isSecretKey,
} from "../server/config-redaction.js";

import { PiAgentError } from "./errors.js";
import {
  DEFAULT_PI_AGENT_MAX_SESSIONS,
  PI_AGENT_MODES,
  PI_AGENT_THINKING_LEVELS,
  canUsePiEnvironmentCredential,
  defaultPiCompatibleBaseUrl,
  hasConfiguredPiAgentCredential,
  isPiCredentialHeaderName,
  isPiModelBaseUrlOverride,
  isPiProviderApiKeyConfigurable,
  piAgentEnvironmentKeys,
  resolveImagePiAgentConfig,
  resolvePiAgentConfig,
  resolvePiAgentMode,
  type PiAgentMode,
  type PiAgentModelInput,
  type ResolvedPiAgentConfig,
} from "./provider-resolution.js";

type JsonRecord = Record<string, unknown>;

const HEADER_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/u;
const TOOL_CAPABLE_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "azure-openai-responses",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
  "pi-messages",
]);


export type PiAgentConfigSource = "agent" | "default";

export interface CanonicalPiAgentConfig {
  readonly mode: PiAgentMode;
  readonly provider: string;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly systemPrompt: string;
  readonly maxTokens: number;
  readonly contextWindow: number;
  readonly maxSessions: number;
  readonly thinkingLevel: (typeof PI_AGENT_THINKING_LEVELS)[number];
  readonly reasoning: boolean;
  readonly input: readonly PiAgentModelInput[];
  readonly tools: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly samplingParams: Readonly<Record<string, unknown>>;
}

export interface PiAgentCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly api: Api;
  readonly reasoning: boolean;
  readonly input: readonly PiAgentModelInput[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly tools: boolean;
}

export interface PiAgentCatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly models: readonly PiAgentCatalogModel[];
}

export interface PiAgentCatalogPayload {
  readonly schemaVersion: 1;
  readonly modes: typeof PI_AGENT_MODES;
  readonly source: PiAgentConfigSource;
  readonly suggestedAgent: CanonicalPiAgentConfig;
  readonly apiKeyConfigured: boolean;
  readonly validationError?: string;
  readonly providers: readonly PiAgentCatalogProvider[];
}

export interface PiAgentConfigValidationOptions {
  /** Injectable ambient environment; omission uses Pi's normal process context. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class PiAgentConfigValidationError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "PiAgentConfigValidationError";
  }
}

interface InspectedAgentConfig {
  readonly path: "agent" | "image_recognition";
  readonly resolved: ResolvedPiAgentConfig;
  readonly model: PiAgentCatalogModel;
}

interface InspectedConfig {
  readonly mode: PiAgentMode;
  readonly resolved?: ResolvedPiAgentConfig;
  readonly model?: PiAgentCatalogModel;
  readonly image?: InspectedAgentConfig;
}

/** Current provider/model directory, projected directly from Pi's builtin Models collection. */
export function piAgentCatalogProviders(): readonly PiAgentCatalogProvider[] {
  return projectProviders(builtinModels());
}

/** Validate configuration and auth availability without refreshing models or sending requests. */
export async function validatePiAgentConfig(
  input: unknown,
  options: PiAgentConfigValidationOptions = {},
): Promise<void> {
  const models = modelsForEnvironment(options.env);
  const inspected = inspectConfig(input, models);
  const primary = inspected.resolved && inspected.model
    ? { path: "agent" as const, resolved: inspected.resolved, model: inspected.model }
    : undefined;
  for (const agent of [primary, inspected.image]) {
    if (agent !== undefined) {
      await assertAuthenticationConfigured(agent, models, options.env);
    }
  }
}

/** Build the authenticated HTTP endpoint payload without copying secrets into it. */
export async function createPiAgentCatalog(
  input: unknown,
  options: PiAgentConfigValidationOptions = {},
): Promise<PiAgentCatalogPayload> {
  const models = modelsForEnvironment(options.env);
  const providers = projectProviders(models);
  const source = configSource(input);
  let inspected: InspectedConfig | undefined;
  let validationError: string | undefined;

  try {
    inspected = inspectConfig(input, models);
    const primary = inspected.resolved && inspected.model
      ? { path: "agent" as const, resolved: inspected.resolved, model: inspected.model }
      : undefined;
    for (const agent of [primary, inspected.image]) {
      if (agent !== undefined) {
        await assertAuthenticationConfigured(agent, models, options.env);
      }
    }
  } catch (error) {
    validationError = safeValidationMessage(error);
  }

  const suggestedAgent = inspected
    ? suggestionFromInspection(input, inspected, providers)
    : defaultSuggestion(providers);
  const configuredAgent = asRecord(asRecord(input)?.agent);
  const configuredProvider = nonEmptyString(configuredAgent?.provider);
  const normalizesUncataloguedProvider =
    validationError === undefined &&
    configuredProvider !== undefined &&
    configuredProvider !== suggestedAgent.provider &&
    !providers.some(({ id }) => id === configuredProvider) &&
    configuredAgent?.model === suggestedAgent.model;
  const needsSuggestedCredentialCheck =
    normalizesUncataloguedProvider &&
    !hasConfiguredPiAgentCredential(input);
  const credentialInput =
    source === "agent" && !needsSuggestedCredentialCheck
      ? input
      : { ...(asRecord(input) ?? {}), agent: suggestedAgent };
  const apiKeyConfigured = await credentialConfigured(
    credentialInput,
    models,
    options.env,
  );

  return {
    schemaVersion: 1,
    modes: PI_AGENT_MODES,
    source,
    suggestedAgent,
    apiKeyConfigured,
    ...(validationError === undefined ? {} : { validationError }),
    providers,
  };
}

function inspectConfig(input: unknown, models: Models): InspectedConfig {
  const root = asRecord(input);
  if (!root) {
    throw invalid("Configuration must be a JSON object");
  }
  const agentPresent = Object.prototype.hasOwnProperty.call(root, "agent");
  const agent = asRecord(root.agent);
  if (agentPresent && !agent) {
    throw invalid("agent must be a JSON object");
  }
  assertNoRemovedTemperatureFields(agent, "agent");

  let mode: PiAgentMode;
  try {
    mode = resolvePiAgentMode(input);
  } catch (error) {
    throw fromResolutionError(error);
  }
  if (agent?.mode !== undefined && agent.mode !== mode) {
    throw invalid("agent.mode must be llm, reread, or disabled");
  }

  let primary: InspectedAgentConfig | undefined;
  if (mode === "llm") {
    if (agent) {
      assertCanonicalLlmFields(agent, "agent");
    }
    let resolved: ResolvedPiAgentConfig;
    try {
      resolved = resolvePiAgentConfig(input);
    } catch (error) {
      throw fromResolutionError(error);
    }
    primary = inspectResolvedAgent(resolved, models, "agent", false);
  }

  const imageRecognition = asRecord(root.image_recognition);
  assertNoLegacyImageRecognitionFields(imageRecognition);
  assertNoRemovedTemperatureFields(imageRecognition, "image_recognition");
  let image: InspectedAgentConfig | undefined;
  if (
    imageRecognition?.enable === true &&
    primary?.model.input.includes("image") !== true
  ) {
    assertCanonicalLlmFields(imageRecognition, "image_recognition");
    let resolvedImage: ResolvedPiAgentConfig | undefined;
    try {
      resolvedImage = resolveImagePiAgentConfig(input);
    } catch (error) {
      throw fromResolutionError(error);
    }
    if (resolvedImage === undefined) {
      throw invalid("image_recognition.enable requires a dedicated Pi visual model");
    }
    image = inspectResolvedAgent(
      resolvedImage,
      models,
      "image_recognition",
      true,
    );
  }

  return {
    mode,
    ...(primary === undefined
      ? {}
      : { resolved: primary.resolved, model: primary.model }),
    ...(image === undefined ? {} : { image }),
  };
}

function inspectResolvedAgent(
  resolved: ResolvedPiAgentConfig,
  models: Models,
  path: InspectedAgentConfig["path"],
  visionRequired: boolean,
): InspectedAgentConfig {
  assertResolvedLlmFields(resolved, path);
  const provider = models.getProvider(resolved.provider);
  if (provider && !isPiProviderApiKeyConfigurable(provider)) {
    throw invalid(
      `Pi provider "${provider.id}" is OAuth-only and cannot be configured with an API key`,
    );
  }

  let model: PiAgentCatalogModel;
  if (resolved.openAICompatible) {
    if (
      resolved.baseUrl === undefined &&
      defaultPiCompatibleBaseUrl(resolved.provider) === undefined
    ) {
      throw invalid(`An OpenAI-compatible provider requires ${path}.baseUrl`);
    }
    model = {
      id: resolved.model,
      name: resolved.model,
      api: "openai-completions",
      reasoning: resolved.reasoning,
      input: [...resolved.input],
      contextWindow: resolved.contextWindow,
      maxTokens: resolved.maxTokens,
      tools: resolved.tools,
    };
  } else {
    if (!provider) {
      throw invalid(`Unknown Pi provider "${resolved.provider}"`);
    }
    const builtin = models.getModel(resolved.provider, resolved.model);
    if (!builtin) {
      throw invalid(
        `Unknown model "${resolved.model}" for Pi provider "${resolved.provider}"`,
      );
    }
    const projected = projectModel(builtin);
    const overrides = resolved.modelOverrides;
    if (overrides.reasoning === true && !projected.reasoning) {
      throw invalid(
        `${path} model "${resolved.provider}/${resolved.model}" does not support reasoning`,
      );
    }
    if (
      overrides.input?.includes("image") === true &&
      !projected.input.includes("image")
    ) {
      throw invalid(
        path === "image_recognition"
          ? `image_recognition model "${resolved.provider}/${resolved.model}" must support image input`
          : `agent model "${resolved.provider}/${resolved.model}" does not support image input`,
      );
    }
    if (resolved.tools && !projected.tools) {
      throw invalid(
        `${path} model "${resolved.provider}/${resolved.model}" does not support tools`,
      );
    }
    model = {
      ...projected,
      tools: resolved.tools,
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

  if (visionRequired && !model.input.includes("image")) {
    throw invalid(
      `image_recognition model "${resolved.provider}/${resolved.model}" must support image input`,
    );
  }
  return { path, resolved, model };
}

function assertNoLegacyImageRecognitionFields(
  imageRecognition: JsonRecord | undefined,
): void {
  if (imageRecognition === undefined) return;
  const legacyFields = [
    "img_save_path",
    "screenshot_window_title",
    "screenshot_window_id",
    "screenshot_delay",
    "screenshot_ffmpeg_input_args",
    "loop_screenshot_enable",
    "loop_screenshot_delay",
    "cam_screenshot_enable",
    "cam_index",
    "cam_screenshot_delay",
    "camera_device",
    "camera_ffmpeg_input_args",
    "loop_cam_screenshot_enable",
    "loop_cam_screenshot_delay",
    "ffmpeg_path",
    "capture_timeout_ms",
    "max_image_bytes",
    "gemini",
    "zhipu",
    "blip",
  ];
  const obsolete = legacyFields.find((field) =>
    Object.hasOwn(imageRecognition, field)
  );
  if (obsolete !== undefined) {
    throw invalid(
      `image_recognition.${obsolete} is no longer supported; configure the dedicated Pi visual model instead`,
    );
  }
}

async function assertAuthenticationConfigured(
  inspected: InspectedAgentConfig,
  models: Models,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<void> {
  const { path, resolved: config } = inspected;

  if (config.openAICompatible) {
    if (
      config.apiKey !== undefined ||
      config.allowKeyless ||
      hasAuthorizationHeader(config.headers) ||
      (canUsePiEnvironmentCredential(config) &&
        configuredEnvironmentCredential(config.credentialProvider, env))
    ) {
      return;
    }
    throw invalid(
      `No usable ${path} credential is configured; set ${path}.apiKey or a supported environment variable`,
    );
  }

  const builtin = models.getModel(config.provider, config.model);
  if (!builtin) {
    throw invalid("The configured Pi model is unavailable");
  }
  if (
    isPiModelBaseUrlOverride(config.baseUrl, builtin.baseUrl) &&
    config.apiKey === undefined &&
    !hasAuthorizationHeader(config.headers)
  ) {
    throw invalid(
      `A custom ${path}.baseUrl requires an explicitly re-entered ${path}.apiKey or credential header`,
    );
  }
  try {
    const auth = config.apiKey
      ? await models.getAuth(builtin, { apiKey: config.apiKey })
      : await models.checkAuth(config.provider);
    if (auth) return;
  } catch (error) {
    throw invalid(`The configured ${path} provider credential is not usable`, error);
  }
  throw invalid(
    `No usable ${path} credential is configured; set ${path}.apiKey or a supported environment variable`,
  );
}

function assertNoRemovedTemperatureFields(
  config: JsonRecord | undefined,
  path: InspectedAgentConfig["path"],
): void {
  if (config === undefined) {
    return;
  }
  if (Object.hasOwn(config, "temperature")) {
    throw invalid(
      `${path}.temperature has been removed; the selected provider and model now use their default temperature`,
    );
  }
  const samplingParams = asRecord(config.samplingParams);
  if (samplingParams && Object.hasOwn(samplingParams, "temperature")) {
    throw invalid(
      `${path}.samplingParams.temperature is not supported; the selected provider and model must control the default temperature`,
    );
  }
}

function assertCanonicalLlmFields(
  agent: JsonRecord,
  path: InspectedAgentConfig["path"],
): void {
  for (const field of ["provider", "model", "apiKey", "baseUrl", "systemPrompt"] as const) {
    const value = agent[field];
    if (value !== undefined && typeof value !== "string") {
      throw invalid(`${path}.${field} must be a string`);
    }
  }

  for (const field of ["maxTokens", "contextWindow", "maxSessions"] as const) {
    const value = agent[field];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    ) {
      throw invalid(`${path}.${field} must be a positive integer`);
    }
  }

  if (
    agent.thinkingLevel !== undefined &&
    (typeof agent.thinkingLevel !== "string" ||
      !PI_AGENT_THINKING_LEVELS.includes(
        agent.thinkingLevel as (typeof PI_AGENT_THINKING_LEVELS)[number],
      ))
  ) {
    throw invalid(
      `${path}.thinkingLevel must be off, minimal, low, medium, high, xhigh, or max`,
    );
  }
  if (agent.reasoning !== undefined && typeof agent.reasoning !== "boolean") {
    throw invalid(`${path}.reasoning must be a boolean`);
  }

  if (agent.input !== undefined) {
    if (
      !Array.isArray(agent.input) ||
      agent.input.length === 0 ||
      agent.input.some((value) => value !== "text" && value !== "image")
    ) {
      throw invalid(`${path}.input must be a non-empty array containing text or image`);
    }
  }
  if (agent.tools !== undefined && typeof agent.tools !== "boolean") {
    throw invalid(`${path}.tools must be a boolean`);
  }

  if (agent.headers !== undefined) {
    const headers = asRecord(agent.headers);
    if (!headers) throw invalid(`${path}.headers must be a JSON object`);
    for (const [name, value] of Object.entries(headers)) {
      if (
        !HEADER_NAME.test(name) ||
        typeof value !== "string" ||
        /[\r\n]/u.test(value)
      ) {
        throw invalid(`${path}.headers must contain valid string header values`);
      }
    }
  }

  if (agent.samplingParams !== undefined && !asRecord(agent.samplingParams)) {
    throw invalid(`${path}.samplingParams must be a JSON object`);
  }
}

function assertResolvedLlmFields(
  config: ResolvedPiAgentConfig,
  path: InspectedAgentConfig["path"],
): void {
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (!HEADER_NAME.test(name) || /[\r\n]/u.test(value)) {
      throw invalid(`${path}.headers must contain valid string header values`);
    }
  }
}

function projectProviders(models: Models): readonly PiAgentCatalogProvider[] {
  const providers = models.getProviders()
    .filter((provider) => provider.id !== "openai-compatible")
    .filter(isPiProviderApiKeyConfigurable)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: models.getModels(provider.id).map(projectModel),
    }))
    .filter((provider) => provider.models.length > 0);
  providers.push({
    id: "openai-compatible",
    name: "OpenAI Compatible",
    models: [],
  });
  return providers;
}

function projectModel(model: Model<Api>): PiAgentCatalogModel {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    tools: modelSupportsTools(model),
  };
}

function suggestionFromInspection(
  input: unknown,
  inspected: InspectedConfig,
  providers: readonly PiAgentCatalogProvider[],
): CanonicalPiAgentConfig {
  if (inspected.mode !== "llm") {
    return inactiveSuggestion(input, inspected.mode, providers);
  }
  if (!inspected.resolved || !inspected.model) {
    throw new Error("Validated LLM configuration is missing model metadata");
  }
  const config = inspected.resolved;
  const model = inspected.model;
  return {
    mode: "llm",
    provider: config.openAICompatible ? "openai-compatible" : config.provider,
    model: config.model,
    apiKey: "",
    baseUrl:
      config.baseUrl ??
      (config.openAICompatible
        ? defaultPiCompatibleBaseUrl(config.provider) ?? ""
        : ""),
    systemPrompt: config.systemPrompt,
    maxTokens: model.maxTokens,
    contextWindow: model.contextWindow,
    maxSessions: config.maxSessions,
    thinkingLevel: config.thinkingLevel,
    reasoning: model.reasoning,
    input: [...model.input],
    tools: model.tools,
    headers: sanitizeHeaders(config.headers),
    samplingParams: sanitizeSamplingParams(config.samplingParams),
  };
}

function inactiveSuggestion(
  input: unknown,
  mode: Exclude<PiAgentMode, "llm">,
  providers: readonly PiAgentCatalogProvider[],
): CanonicalPiAgentConfig {
  const fallback = { ...defaultSuggestion(providers), mode };
  const agent = asRecord(asRecord(input)?.agent);
  if (!agent) return fallback;

  const provider = nonEmptyString(agent.provider) ?? fallback.provider;
  const model = nonEmptyString(agent.model) ?? fallback.model;
  const baseUrl = safeBaseUrl(agent.baseUrl) ?? "";
  const systemPrompt =
    typeof agent.systemPrompt === "string"
      ? agent.systemPrompt
      : fallback.systemPrompt;
  const maxTokens = positiveInteger(agent.maxTokens) ?? fallback.maxTokens;
  const contextWindow = positiveInteger(agent.contextWindow) ?? fallback.contextWindow;
  const maxSessions = positiveInteger(agent.maxSessions) ?? fallback.maxSessions;
  const thinkingLevel =
    typeof agent.thinkingLevel === "string" &&
    PI_AGENT_THINKING_LEVELS.includes(
      agent.thinkingLevel as (typeof PI_AGENT_THINKING_LEVELS)[number],
    )
      ? (agent.thinkingLevel as CanonicalPiAgentConfig["thinkingLevel"])
      : fallback.thinkingLevel;
  const reasoning =
    typeof agent.reasoning === "boolean" ? agent.reasoning : fallback.reasoning;
  const inputTypes = canonicalInput(agent.input) ?? fallback.input;
  const tools = typeof agent.tools === "boolean" ? agent.tools : fallback.tools;
  return {
    mode,
    provider,
    model,
    apiKey: "",
    baseUrl,
    systemPrompt,
    maxTokens,
    contextWindow,
    maxSessions,
    thinkingLevel,
    reasoning,
    input: inputTypes,
    tools,
    headers: sanitizeHeaders(asRecord(agent.headers)),
    samplingParams: sanitizeSamplingParams(asRecord(agent.samplingParams)),
  };
}

function defaultSuggestion(
  providers: readonly PiAgentCatalogProvider[],
): CanonicalPiAgentConfig {
  const preferred = providers.find(
    (provider) => provider.id === "openai" && provider.models.length > 0,
  );
  const provider = preferred ?? providers.find((entry) => entry.models.length > 0);
  const model = provider?.models[0];
  if (!provider || !model) {
    throw new Error("Pi builtin model catalog is empty");
  }
  return {
    mode: "disabled",
    provider: provider.id,
    model: model.id,
    apiKey: "",
    baseUrl: "",
    systemPrompt: "",
    maxTokens: model.maxTokens,
    contextWindow: model.contextWindow,
    maxSessions: DEFAULT_PI_AGENT_MAX_SESSIONS,
    thinkingLevel: model.reasoning ? "medium" : "off",
    reasoning: model.reasoning,
    input: [...model.input],
    tools: model.tools,
    headers: {},
    samplingParams: {},
  };
}

function modelSupportsTools(model: Pick<Model<Api>, "api">): boolean {
  return TOOL_CAPABLE_APIS.has(model.api);
}

async function credentialConfigured(
  input: unknown,
  models: Models,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<boolean> {
  let config: ResolvedPiAgentConfig;
  try {
    config = resolvePiAgentConfig(input);
  } catch {
    return false;
  }
  if (config.apiKey !== undefined || hasAuthorizationHeader(config.headers)) {
    return true;
  }
  if (!canUsePiEnvironmentCredential(config)) return false;
  const provider = config.credentialProvider;
  if (configuredEnvironmentCredential(provider, env)) return true;
  if (!models.getProvider(provider)) return false;
  try {
    return (await models.checkAuth(provider)) !== undefined;
  } catch {
    return false;
  }
}

function configuredEnvironmentCredential(
  provider: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  const source = env ?? process.env;
  return piAgentEnvironmentKeys(provider).some((name) => {
    const value = source[name];
    return typeof value === "string" && value.trim() !== "";
  });
}

function modelsForEnvironment(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Models {
  if (env === undefined) return builtinModels();
  const authContext: AuthContext = {
    async env(name) {
      const value = env[name];
      return typeof value === "string" && value.trim() !== ""
        ? value
        : undefined;
    },
    async fileExists() {
      return false;
    },
  };
  return builtinModels({ authContext });
}

function configSource(input: unknown): PiAgentConfigSource {
  const root = asRecord(input);
  return root && Object.prototype.hasOwnProperty.call(root, "agent")
    ? "agent"
    : "default";
}

function sanitizeHeaders(
  headers: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string>> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (
      typeof value === "string" &&
      !isPiCredentialHeaderName(name) &&
      !isSecretKey(name) &&
      !containsEmbeddedSecret(value)
    ) {
      safe[name] = value;
    }
  }
  return safe;
}

function sanitizeSamplingParams(
  params: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const safe: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    if (isSecretKey(name)) continue;
    safe[name] = sanitizeUnknown(value);
  }
  return safe;
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return containsEmbeddedSecret(value) ? "" : value;
  }
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  const record = asRecord(value);
  if (!record) return value;
  const safe: Record<string, unknown> = {};
  for (const [name, nested] of Object.entries(record)) {
    if (!isSecretKey(name)) safe[name] = sanitizeUnknown(nested);
  }
  return safe;
}


function hasAuthorizationHeader(
  headers: Readonly<Record<string, string>> | undefined,
): boolean {
  return Object.keys(headers ?? {}).some(isPiCredentialHeaderName);
}

function safeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return value.trim();
  } catch {
    return undefined;
  }
}

function canonicalInput(value: unknown): readonly PiAgentModelInput[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => entry !== "text" && entry !== "image")
  ) {
    return undefined;
  }
  return [...new Set(value as PiAgentModelInput[])];
}


function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function safeValidationMessage(error: unknown): string {
  return error instanceof PiAgentConfigValidationError
    ? error.message
    : "Agent configuration is invalid";
}

function fromResolutionError(error: unknown): PiAgentConfigValidationError {
  return error instanceof PiAgentError
    ? invalid(error.message, error)
    : invalid("Agent configuration is invalid", error);
}

function invalid(
  message: string,
  cause?: unknown,
): PiAgentConfigValidationError {
  return new PiAgentConfigValidationError(
    message,
    cause === undefined ? {} : { cause },
  );
}
