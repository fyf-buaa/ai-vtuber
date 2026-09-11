import { isSecretKey } from "../src/server/config-redaction.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type SettingsFieldKind =
  | "array"
  | "boolean"
  | "null"
  | "number"
  | "object"
  | "string";

export interface SettingsFieldDescriptor {
  readonly key: string;
  readonly kind: SettingsFieldKind;
  readonly path: string[];
  readonly readOnly: boolean;
  readonly secret: boolean;
  readonly value: JsonValue;
}

export interface SettingsSectionDescriptor {
  readonly fields: SettingsFieldDescriptor[];
  readonly key: string;
  readonly path: string[];
}

export const AGENT_MODE_IDS = ["llm", "reread", "disabled"] as const;
export const AGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AgentModeId = typeof AGENT_MODE_IDS[number];
export type AgentThinkingLevel = typeof AGENT_THINKING_LEVELS[number];
export type AgentCatalogSource = "agent" | "default";

export interface AgentCatalogMode {
  readonly id: AgentModeId;
  readonly name: string;
}

export interface AgentCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly tools: boolean;
}

export interface AgentCatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly models: readonly AgentCatalogModel[];
}

export interface AgentCatalog {
  readonly schemaVersion: 1;
  readonly modes: readonly AgentCatalogMode[];
  readonly source: AgentCatalogSource;
  readonly suggestedAgent: JsonObject;
  readonly apiKeyConfigured: boolean;
  readonly validationError?: string;
  readonly providers: readonly AgentCatalogProvider[];
}

export interface MaterializedSettingsConfig {
  readonly config: JsonObject;
  readonly agentSynthesized: boolean;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defineJsonProperty(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }
  if (isJsonObject(value)) {
    const clone = Object.create(null) as JsonObject;
    for (const key of Object.keys(value)) {
      defineJsonProperty(clone, key, cloneJsonValue(value[key] as JsonValue));
    }
    return clone;
  }
  return value;
}

export function cloneJsonObject(value: JsonObject): JsonObject {
  return cloneJsonValue(value) as JsonObject;
}

function arrayIndex(segment: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
  const index = Number(segment);
  return Number.isSafeInteger(index) ? index : undefined;
}

export function jsonValueAtPath(
  root: JsonObject,
  path: readonly string[],
): JsonValue | undefined {
  let current: JsonValue = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = arrayIndex(segment);
      if (index === undefined || index >= current.length) return undefined;
      current = current[index] as JsonValue;
    } else if (isJsonObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment] as JsonValue;
    } else {
      return undefined;
    }
  }
  return current;
}

export function setJsonValueAtPath(
  root: JsonObject,
  path: readonly string[],
  value: JsonValue,
): void {
  if (path.length === 0) throw new TypeError("A settings field path cannot be empty");

  let parent: JsonValue = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index] as string;
    if (Array.isArray(parent)) {
      const arrayPosition = arrayIndex(segment);
      if (arrayPosition === undefined || arrayPosition >= parent.length) {
        throw new TypeError(`Settings path segment does not exist: ${segment}`);
      }
      parent = parent[arrayPosition] as JsonValue;
    } else if (isJsonObject(parent) && Object.hasOwn(parent, segment)) {
      parent = parent[segment] as JsonValue;
    } else {
      throw new TypeError(`Settings path segment does not exist: ${segment}`);
    }
  }

  const finalSegment = path[path.length - 1] as string;
  if (Array.isArray(parent)) {
    const arrayPosition = arrayIndex(finalSegment);
    if (arrayPosition === undefined || arrayPosition >= parent.length) {
      throw new TypeError(`Settings path segment does not exist: ${finalSegment}`);
    }
    parent[arrayPosition] = value;
  } else if (isJsonObject(parent)) {
    defineJsonProperty(parent, finalSegment, value);
  } else {
    throw new TypeError(`Settings path segment is not an object: ${finalSegment}`);
  }
}

export function isReadOnlySettingsPath(
  path: readonly string[],
  readOnlyPaths: readonly (readonly string[])[],
): boolean {
  return readOnlyPaths.some((prefix) =>
    prefix.length <= path.length
    && prefix.every((segment, index) => path[index] === segment)
  );
}

export function isSecretSettingsPath(path: readonly string[]): boolean {
  const key = path[path.length - 1];
  return key !== undefined && isSecretKey(key);
}

export function settingsFieldKind(value: JsonValue): SettingsFieldKind {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (isJsonObject(value)) {
    return "object";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Settings numbers must be finite");
    }
    return "number";
  }
  return "string";
}

export function describeSettingsConfig(
  config: JsonObject,
  readOnlyPaths: readonly (readonly string[])[] = [],
): SettingsSectionDescriptor[] {
  const sections: SettingsSectionDescriptor[] = [];

  for (const sectionKey of Object.keys(config)) {
    const sectionPath = [sectionKey];
    const fields: SettingsFieldDescriptor[] = [];

    const visit = (value: JsonValue, path: string[], key: string): void => {
      if (isJsonObject(value) && Object.keys(value).length > 0) {
        for (const childKey of Object.keys(value)) {
          visit(value[childKey] as JsonValue, [...path, childKey], childKey);
        }
        return;
      }

      fields.push({
        key,
        kind: settingsFieldKind(value),
        path,
        readOnly: isReadOnlySettingsPath(path, readOnlyPaths),
        secret: isSecretSettingsPath(path),
        value,
      });
    };

    visit(config[sectionKey] as JsonValue, sectionPath, sectionKey);
    sections.push({ fields, key: sectionKey, path: sectionPath });
  }

  return sections;
}

export function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) =>
      jsonValuesEqual(value, right[index] as JsonValue)
    );
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) {
      return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key) =>
      Object.hasOwn(right, key)
      && jsonValuesEqual(left[key] as JsonValue, right[key] as JsonValue)
    );
  }
  return false;
}

export function isSettingsPathDirty(
  original: JsonObject,
  draft: JsonObject,
  path: readonly string[],
): boolean {
  const originalValue = jsonValueAtPath(original, path);
  const draftValue = jsonValueAtPath(draft, path);
  if (originalValue === undefined || draftValue === undefined) {
    return originalValue !== draftValue;
  }
  return !jsonValuesEqual(originalValue, draftValue);
}

function catalogObject(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new TypeError(`${label} 必须是对象`);
  return value;
}

function catalogArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} 必须是数组`);
  return value;
}

function catalogString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} 必须是非空字符串`);
  }
  return value;
}

function catalogNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} 必须是有限数字`);
  }
  return value;
}

function catalogPositiveInteger(value: unknown, label: string): number {
  const parsed = catalogNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} 必须是正整数`);
  }
  return parsed;
}

function catalogJsonValue(value: unknown, label: string, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return catalogNumber(value, label);
  if (typeof value !== "object") throw new TypeError(`${label} 必须是 JSON 值`);
  if (ancestors.has(value)) throw new TypeError(`${label} 不能包含循环引用`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => catalogJsonValue(item, `${label}[${index}]`, ancestors));
    }
    const result = Object.create(null) as JsonObject;
    for (const [key, child] of Object.entries(value)) {
      defineJsonProperty(result, key, catalogJsonValue(child, `${label}.${key}`, ancestors));
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function parseAgentModeId(value: unknown, label: string): AgentModeId {
  const id = catalogString(value, label);
  if (!AGENT_MODE_IDS.some((candidate) => candidate === id)) {
    throw new TypeError(`${label} 不是受支持的 Agent 模式`);
  }
  return id as AgentModeId;
}

function parseAgentThinkingLevel(value: unknown, label: string): AgentThinkingLevel {
  const level = catalogString(value, label);
  if (!AGENT_THINKING_LEVELS.some((candidate) => candidate === level)) {
    throw new TypeError(`${label} 不是受支持的思考等级`);
  }
  return level as AgentThinkingLevel;
}

function parseAgentInput(value: unknown, label: string): readonly ("text" | "image")[] {
  return catalogArray(value, label).map((entry, index) => {
    if (entry !== "text" && entry !== "image") {
      throw new TypeError(`${label}[${index}] 必须是 text 或 image`);
    }
    return entry;
  });
}

function parseCatalogModel(value: unknown, providerIndex: number, modelIndex: number): AgentCatalogModel {
  const label = `providers[${providerIndex}].models[${modelIndex}]`;
  const model = catalogObject(value, label);
  if (typeof model["reasoning"] !== "boolean") {
    throw new TypeError(`${label}.reasoning 必须是布尔值`);
  }
  if (typeof model["tools"] !== "boolean") {
    throw new TypeError(`${label}.tools 必须是布尔值`);
  }
  return {
    id: catalogString(model["id"], `${label}.id`),
    name: catalogString(model["name"], `${label}.name`),
    api: catalogString(model["api"], `${label}.api`),
    reasoning: model["reasoning"],
    input: parseAgentInput(model["input"], `${label}.input`),
    contextWindow: catalogPositiveInteger(model["contextWindow"], `${label}.contextWindow`),
    maxTokens: catalogPositiveInteger(model["maxTokens"], `${label}.maxTokens`),
    tools: model["tools"],
  };
}

function parseCatalogProvider(value: unknown, index: number): AgentCatalogProvider {
  const label = `providers[${index}]`;
  const provider = catalogObject(value, label);
  const id = catalogString(provider["id"], `${label}.id`);
  const models = catalogArray(provider["models"], `${label}.models`).map((model, modelIndex) =>
    parseCatalogModel(model, index, modelIndex)
  );
  const modelIds = new Set(models.map(({ id: modelId }) => modelId));
  if (modelIds.size !== models.length) throw new TypeError(`${label}.models 包含重复 id`);
  if (id !== "openai-compatible" && models.length === 0) {
    throw new TypeError(`${label}.models 必须提供至少一个模型`);
  }
  return {
    id,
    name: catalogString(provider["name"], `${label}.name`),
    models,
  };
}

const CANONICAL_AGENT_KEYS = [
  "mode",
  "provider",
  "model",
  "apiKey",
  "baseUrl",
  "systemPrompt",
  "maxTokens",
  "contextWindow",
  "maxSessions",
  "thinkingLevel",
  "reasoning",
  "input",
  "tools",
  "headers",
  "samplingParams",
] as const;

function parseSuggestedAgent(value: unknown): JsonObject {
  const parsed = catalogJsonValue(value, "suggestedAgent");
  if (!isJsonObject(parsed)) throw new TypeError("suggestedAgent 必须是对象");
  const actualKeys = Object.keys(parsed);
  for (const key of CANONICAL_AGENT_KEYS) {
    if (!Object.hasOwn(parsed, key)) throw new TypeError(`suggestedAgent 缺少 ${key}`);
  }
  if (actualKeys.some((key) => !CANONICAL_AGENT_KEYS.some((candidate) => candidate === key))) {
    throw new TypeError("suggestedAgent 包含非规范字段");
  }
  parseAgentModeId(parsed["mode"], "suggestedAgent.mode");
  catalogString(parsed["provider"], "suggestedAgent.provider");
  catalogString(parsed["model"], "suggestedAgent.model");
  if (parsed["apiKey"] !== "") throw new TypeError("suggestedAgent.apiKey 必须为空");
  if (typeof parsed["baseUrl"] !== "string") throw new TypeError("suggestedAgent.baseUrl 必须是字符串");
  if (typeof parsed["systemPrompt"] !== "string") {
    throw new TypeError("suggestedAgent.systemPrompt 必须是字符串");
  }
  catalogPositiveInteger(parsed["maxTokens"], "suggestedAgent.maxTokens");
  catalogPositiveInteger(parsed["contextWindow"], "suggestedAgent.contextWindow");
  catalogPositiveInteger(parsed["maxSessions"], "suggestedAgent.maxSessions");
  parseAgentThinkingLevel(parsed["thinkingLevel"], "suggestedAgent.thinkingLevel");
  if (typeof parsed["reasoning"] !== "boolean") {
    throw new TypeError("suggestedAgent.reasoning 必须是布尔值");
  }
  parseAgentInput(parsed["input"], "suggestedAgent.input");
  if (typeof parsed["tools"] !== "boolean") {
    throw new TypeError("suggestedAgent.tools 必须是布尔值");
  }
  if (!isJsonObject(parsed["headers"])) throw new TypeError("suggestedAgent.headers 必须是对象");
  if (
    Object.keys(parsed["headers"]).some((key) => key.toLocaleLowerCase("en-US") === "authorization")
  ) {
    throw new TypeError("suggestedAgent.headers 不能包含 Authorization");
  }
  if (!isJsonObject(parsed["samplingParams"])) {
    throw new TypeError("suggestedAgent.samplingParams 必须是对象");
  }
  return parsed;
}

export function parseAgentCatalog(value: unknown): AgentCatalog {
  const payload = catalogObject(value, "Agent 模型目录");
  if (payload["schemaVersion"] !== 1) throw new TypeError("Agent 模型目录版本不受支持");

  const modes = catalogArray(payload["modes"], "modes").map((value, index) => {
    const mode = catalogObject(value, `modes[${index}]`);
    return {
      id: parseAgentModeId(mode["id"], `modes[${index}].id`),
      name: catalogString(mode["name"], `modes[${index}].name`),
    };
  });
  const modeIds = new Set(modes.map(({ id }) => id));
  if (
    modes.length !== AGENT_MODE_IDS.length
    || AGENT_MODE_IDS.some((id) => !modeIds.has(id))
  ) {
    throw new TypeError("Agent 模型目录必须完整提供 llm、reread、disabled 模式");
  }

  const source = catalogString(payload["source"], "source");
  if (source !== "agent" && source !== "default") {
    throw new TypeError("Agent 模型目录包含无效配置来源");
  }
  if (typeof payload["apiKeyConfigured"] !== "boolean") {
    throw new TypeError("apiKeyConfigured 必须是布尔值");
  }
  const providers = catalogArray(payload["providers"], "providers").map((provider, index) =>
    parseCatalogProvider(provider, index)
  );
  const providerIds = new Set(providers.map(({ id }) => id));
  if (providerIds.size !== providers.length) throw new TypeError("providers 包含重复 id");
  if (!providerIds.has("openai-compatible")) {
    throw new TypeError("Agent 模型目录缺少 openai-compatible provider");
  }

  const suggestedAgent = parseSuggestedAgent(payload["suggestedAgent"]);
  if (suggestedAgent["mode"] === "llm") {
    const suggestedProviderId = suggestedAgent["provider"] as string;
    const suggestedModelId = suggestedAgent["model"] as string;
    const suggestedProvider = providers.find(({ id }) => id === suggestedProviderId);
    if (suggestedProvider === undefined) {
      throw new TypeError("suggestedAgent.provider 不在模型目录中");
    }
    if (
      suggestedProvider.id !== "openai-compatible"
      && !suggestedProvider.models.some(({ id }) => id === suggestedModelId)
    ) {
      throw new TypeError("suggestedAgent.model 不属于 suggestedAgent.provider");
    }
  }

  const validationError = payload["validationError"] === undefined
    ? undefined
    : catalogString(payload["validationError"], "validationError");
  return {
    schemaVersion: 1,
    modes,
    source,
    suggestedAgent,
    apiKeyConfigured: payload["apiKeyConfigured"],
    ...(validationError === undefined ? {} : { validationError }),
    providers,
  };
}

export function materializeSettingsAgent(
  config: JsonObject,
  catalog: AgentCatalog,
): MaterializedSettingsConfig {
  const materialized = cloneJsonObject(config);
  const existing = materialized["agent"];
  if (!isJsonObject(existing)) {
    defineJsonProperty(materialized, "agent", cloneJsonObject(catalog.suggestedAgent));
    return { config: materialized, agentSynthesized: true };
  }

  const completed = cloneJsonObject(catalog.suggestedAgent);
  let supplemented = false;
  for (const key of CANONICAL_AGENT_KEYS) {
    if (Object.hasOwn(existing, key)) {
      defineJsonProperty(completed, key, cloneJsonValue(existing[key] as JsonValue));
    } else {
      supplemented = true;
    }
  }
  const existingProvider =
    typeof existing["provider"] === "string" ? existing["provider"] : "";
  const suggestedProvider =
    typeof catalog.suggestedAgent["provider"] === "string"
      ? catalog.suggestedAgent["provider"]
      : "";
  const normalizesProviderAlias =
    catalog.validationError === undefined &&
    suggestedProvider !== "" &&
    existingProvider !== suggestedProvider &&
    !catalog.providers.some(({ id }) => id === existingProvider) &&
    existing["model"] === catalog.suggestedAgent["model"];
  if (normalizesProviderAlias) {
    defineJsonProperty(completed, "provider", suggestedProvider);
    defineJsonProperty(
      completed,
      "baseUrl",
      cloneJsonValue(catalog.suggestedAgent["baseUrl"] as JsonValue),
    );
    supplemented = true;
  }
  for (const [key, value] of Object.entries(existing)) {
    if (!Object.hasOwn(completed, key)) {
      defineJsonProperty(completed, key, cloneJsonValue(value));
    }
  }
  if (!supplemented) return { config: materialized, agentSynthesized: false };
  defineJsonProperty(materialized, "agent", completed);
  return { config: materialized, agentSynthesized: true };
}

export function agentCatalogProvider(
  catalog: AgentCatalog,
  providerId: string,
): AgentCatalogProvider | undefined {
  return catalog.providers.find(({ id }) => id === providerId);
}

export function agentCatalogModel(
  catalog: AgentCatalog,
  providerId: string,
  modelId: string,
): AgentCatalogModel | undefined {
  return agentCatalogProvider(catalog, providerId)?.models.find(({ id }) => id === modelId);
}

export function agentProviderAcceptsCustomModels(providerId: string): boolean {
  return providerId === "openai-compatible";
}

function synchronizeAgentModel(agent: JsonObject, model: AgentCatalogModel): void {
  defineJsonProperty(agent, "model", model.id);
  defineJsonProperty(agent, "maxTokens", model.maxTokens);
  defineJsonProperty(agent, "contextWindow", model.contextWindow);
  defineJsonProperty(agent, "reasoning", model.reasoning);
  defineJsonProperty(agent, "input", [...model.input]);
  defineJsonProperty(agent, "tools", model.tools);
}

export function selectAgentProvider(
  agent: JsonObject,
  catalog: AgentCatalog,
  providerId: string,
): JsonObject {
  const provider = agentCatalogProvider(catalog, providerId);
  const previousProviderId =
    typeof agent["provider"] === "string" ? agent["provider"] : "";
  if (provider === undefined) throw new TypeError("所选 provider 不在模型目录中");
  const selected = cloneJsonObject(agent);
  defineJsonProperty(selected, "provider", provider.id);
  if (agentProviderAcceptsCustomModels(provider.id)) return selected;

  const currentModelId = typeof selected["model"] === "string" ? selected["model"] : "";
  const model =
    provider.models.find(({ id }) => id === currentModelId) ??
    provider.models[0];
  if (model === undefined) throw new TypeError("所选 provider 没有可用模型");
  if (previousProviderId === provider.id && model.id === currentModelId) {
    return selected;
  }
  synchronizeAgentModel(selected, model);
  return selected;
}

export function selectAgentModel(
  agent: JsonObject,
  catalog: AgentCatalog,
  modelId: string,
): JsonObject {
  const providerId = typeof agent["provider"] === "string" ? agent["provider"] : "";
  const provider = agentCatalogProvider(catalog, providerId);
  if (provider === undefined) throw new TypeError("当前 provider 不在模型目录中");
  if (agentProviderAcceptsCustomModels(provider.id)) {
    if (modelId.trim() === "") throw new TypeError("请输入兼容接口的 model ID");
    const selected = cloneJsonObject(agent);
    defineJsonProperty(selected, "model", modelId);
    return selected;
  }
  const model = provider.models.find(({ id }) => id === modelId);
  if (model === undefined) throw new TypeError("所选 model 不属于当前 provider");
  const selected = cloneJsonObject(agent);
  synchronizeAgentModel(selected, model);
  return selected;
}

export function isAgentLlmParameterPath(path: readonly string[]): boolean {
  return path.length >= 2 && path[0] === "agent" && path[1] !== "mode";
}
