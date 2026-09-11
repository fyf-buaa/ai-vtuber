import {
  isPlatformAvailable,
  pendingPlatformForPath,
} from "../src/platforms/availability.js";
import {
  SCHEDULE_INTERVAL_UNITS,
  ScheduleConfigurationError,
  parseScheduleConfig,
  type ScheduleTask,
} from "../src/config/schedule.js";


import {
  IdleConfigurationError,
  validateIdleConfig,
} from "../src/config/idle.js";

import {
  AGENT_THINKING_LEVELS,
  agentCatalogModel,
  agentCatalogProvider,
  agentProviderAcceptsCustomModels,
  cloneJsonObject,
  cloneJsonValue,
  describeSettingsConfig,
  isAgentLlmParameterPath,
  isJsonObject,
  isReadOnlySettingsPath,
  isSecretSettingsPath,
  isSettingsPathDirty,
  materializeSettingsAgent,
  parseAgentCatalog,
  selectAgentModel,
  selectAgentProvider,
  setJsonValueAtPath,
  settingsFieldKind,
  type AgentCatalog,
  type JsonObject,
  type JsonValue,
  type SettingsFieldKind,
} from "./settings-model.js";
import {
  categorizeSettingsKeys,
  settingsPathLabel as localizedSettingsPathLabel,
  settingsPathOptions,
  type SettingsChoiceOption,
} from "./settings-catalog.js";

const SESSION_TOKEN_KEY = "ai-vtuber.operator-token";
const MESSAGE_TIMEOUT_MS = 6_000;
const REDACTED_API_KEY = "[REDACTED]";
const AGENT_CREDENTIAL_FIELDS = ["provider", "baseUrl", "apiKey", "headers"] as const;
const AGENT_CAPABILITY_FIELDS = ["reasoning", "input", "tools"] as const;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/u;
const AGENT_ROUTE_LABELS: Readonly<Record<string, string>> = {
  llm: "Pi Agent 生成回复",
  reread: "原文复读，不调用模型",
  disabled: "不生成回复",
};
const AGENT_SOURCE_LABELS: Readonly<Record<string, string>> = {
  agent: "根 agent · 当前主配置",
  default: "Pi 默认配置 · 待写入",
};
const THINKING_LEVEL_LABELS: Readonly<Record<string, string>> = {
  off: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
};

type Tone = "error" | "success" | "warning";
type FieldControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type FieldErrorSource = "local" | "parse" | "server";

interface EdgeVoiceOption {
  readonly shortName: string;
  readonly gender: string;
  readonly locale: string;
  readonly localeName: string;
}

interface EdgeVoiceCatalogResult {
  readonly voices: readonly EdgeVoiceOption[];
  readonly error?: string;
}

interface FieldView {
  readonly container: HTMLElement;
  readonly control: FieldControl;
  readonly error: HTMLElement;
  readonly kind: SettingsFieldKind;
  readonly path: readonly string[];
  readonly readOnly: boolean;
  errorSource?: FieldErrorSource;
}

interface SectionView {
  readonly container: HTMLDetailsElement;
  readonly navigation: HTMLButtonElement;
  readonly key: string;
}


interface PreservedFieldState {
  readonly checked: boolean;
  readonly error: string;
  readonly errorSource: FieldErrorSource;
  readonly path: readonly string[];
  readonly scheduleId: string | undefined;
  readonly value: string;
}

class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly detailsPath: readonly string[] | undefined;

  constructor(
    status: number,
    message: string,
    code?: string,
    detailsPath?: readonly string[],
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.detailsPath = detailsPath;
  }
}

const authForm = element<HTMLFormElement>("settings-auth-form");
const tokenInput = element<HTMLInputElement>("settings-token-input");
const connectButton = element<HTMLButtonElement>("settings-connect");
const connectionMark = element<HTMLElement>("settings-connection-mark");
const connectionLabel = element<HTMLElement>("settings-connection-label");
const connectionDetail = element<HTMLElement>("settings-connection-detail");
const announcement = element<HTMLElement>("settings-announcement");
const sectionNavigation = element<HTMLElement>("settings-section-nav");
const settingsForm = element<HTMLFormElement>("settings-form");
const settingsTree = element<HTMLElement>("settings-tree");
const emptyState = element<HTMLElement>("settings-empty");
const dirtyCount = element<HTMLElement>("settings-dirty-count");
const revisionLabel = element<HTMLElement>("settings-revision");
const reloadButton = element<HTMLButtonElement>("settings-reload");
const resetButton = element<HTMLButtonElement>("settings-reset");
const expandButton = element<HTMLButtonElement>("settings-expand-all");
const collapseButton = element<HTMLButtonElement>("settings-collapse-all");
const saveButton = element<HTMLButtonElement>("settings-save");
const footerTime = element<HTMLElement>("settings-footer-time");
const agentOverview = element<HTMLElement>("settings-agent-overview");
const agentSource = element<HTMLElement>("settings-agent-source");
const agentRoute = element<HTMLElement>("settings-agent-route");
const agentSelection = element<HTMLElement>("settings-agent-selection");
const agentCapability = element<HTMLElement>("settings-agent-capability");
const agentCredential = element<HTMLElement>("settings-agent-credential");
const agentCatalogState = element<HTMLElement>("settings-agent-catalog-state");

let accessToken = sessionStorage.getItem(SESSION_TOKEN_KEY) ?? "";
let loadedConfig: JsonObject | undefined;
let draftConfig: JsonObject | undefined;
let loadedRevision: number | undefined;
let readOnlyPaths: readonly (readonly string[])[] = [];
let agentCatalog: AgentCatalog | undefined;
let agentMaterializationPending = false;
let agentCatalogAuthoritative = false;
let agentCatalogRefreshError: string | undefined;
let agentSaveError: string | undefined;
let edgeVoices: readonly EdgeVoiceOption[] = [];
let edgeVoiceCatalogError: string | undefined;
let announcementTimer: number | undefined;
let revisionConflicted = false;
let loadController: AbortController | undefined;
let busy = false;
let fieldSequence = 0;
const fieldViews: FieldView[] = [];
const sectionViews: SectionView[] = [];

tokenInput.value = accessToken;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Missing required element #${id}`);
  }
  return found as T;
}


function valueAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function authHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("Accept", "application/json");
  if (accessToken !== "") result.set("Authorization", `Bearer ${accessToken}`);
  return result;
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = authHeaders(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...init, headers });
}

async function responseJson(response: Response): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new ApiRequestError(response.status, "服务返回了无法解析的响应");
  }
  if (!response.ok) {
    const detailsPath = stringValue(valueAt(payload, "error", "details", "path"));
    throw new ApiRequestError(
      response.status,
      stringValue(valueAt(payload, "error", "message")) ?? `请求失败（${response.status}）`,
      stringValue(valueAt(payload, "error", "code")),
      detailsPath === undefined ? undefined : detailsPath.split("."),
    );
  }
  return payload;
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 401) {
    return "认证失败，请检查访问令牌";
  }
  return error instanceof Error ? error.message : "发生未知错误";
}

function showAnnouncement(message: string, tone: Tone = "warning"): void {
  if (announcementTimer !== undefined) window.clearTimeout(announcementTimer);
  announcement.textContent = message;
  announcement.dataset.tone = tone;
  announcement.hidden = false;
  announcementTimer = window.setTimeout(() => {
    announcement.hidden = true;
    announcementTimer = undefined;
  }, MESSAGE_TIMEOUT_MS);
}

function setConnection(
  state: "error" | "loading" | "ready",
  label: string,
  detail: string,
): void {
  connectionMark.dataset.state = state;
  connectionLabel.textContent = label;
  connectionDetail.textContent = detail;
}

function parseReadOnlyPaths(value: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(value)) throw new Error("配置响应缺少 readOnlyPaths 数组");
  const result: string[][] = [];
  for (const path of value) {
    if (!Array.isArray(path) || path.length === 0 || path.some((part) => typeof part !== "string")) {
      throw new Error("配置响应包含无效的只读字段路径");
    }
    result.push(path.map((part) => part as string));
  }
  return result;
}

function parseConfigPayload(payload: unknown): {
  readonly config: JsonObject;
  readonly revision: number;
  readonly protectedPaths: readonly (readonly string[])[];
} {
  const config = valueAt(payload, "config");
  const revision = numberValue(valueAt(payload, "revision"));
  if (!isJsonObject(config)) throw new Error("配置响应缺少 config 对象");
  if (revision === undefined) throw new Error("配置响应缺少有效 revision");
  return {
    config: cloneJsonObject(config as JsonObject),
    revision,
    protectedPaths: parseReadOnlyPaths(valueAt(payload, "readOnlyPaths")),
  };
}

function parseEdgeVoiceCatalog(payload: unknown): readonly EdgeVoiceOption[] {
  const value = valueAt(payload, "voices");
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Edge TTS 语音列表响应缺少 voices");
  }
  const voices: EdgeVoiceOption[] = [];
  for (const candidate of value) {
    if (!isJsonObject(candidate)) {
      throw new Error("Edge TTS 语音列表包含无效条目");
    }
    const shortName = stringValue(candidate["shortName"]);
    const gender = stringValue(candidate["gender"]);
    const locale = stringValue(candidate["locale"]);
    const localeName = stringValue(candidate["localeName"]);
    if (
      shortName === undefined ||
      gender === undefined ||
      locale === undefined ||
      localeName === undefined
    ) {
      throw new Error("Edge TTS 语音列表包含字段不完整的条目");
    }
    voices.push({ shortName, gender, locale, localeName });
  }
  return voices;
}

async function fetchEdgeVoiceCatalog(
  signal: AbortSignal,
): Promise<EdgeVoiceCatalogResult> {
  try {
    const payload = await responseJson(
      await apiFetch("/api/speech/edge/voices", { signal }),
    );
    return { voices: parseEdgeVoiceCatalog(payload) };
  } catch (error) {
    if (signal.aborted) throw error;
    return { voices: [], error: describeError(error) };
  }
}

function edgeVoiceFieldHelp(path: readonly string[]): string | undefined {
  if (path.length !== 2 || path[0] !== "edge-tts" || path[1] !== "voice") {
    return undefined;
  }
  return edgeVoiceCatalogError === undefined
    ? `已自动同步 ${edgeVoices.length.toLocaleString("zh-CN")} 个 Edge TTS 语音。`
    : `语音列表同步失败：${edgeVoiceCatalogError}。当前配置仍会保留，重新载入后重试。`;
}

function badwordsFieldHelp(path: readonly string[]): string | undefined {
  if (path.length !== 3 || path[0] !== "filter" || path[1] !== "badwords") {
    return undefined;
  }
  switch (path[2]) {
    case "path":
      return "词库每行一个关键词，按字面包含匹配，不使用正则表达式。";
    case "discard":
      return "开启后命中关键词的消息会被丢弃；关闭时使用下方替换文本。";
    case "replace":
      return "仅在关闭“命中后丢弃消息”时使用。";
    default:
      return undefined;
  }
}


function createText(tag: "small" | "span" | "strong", text: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function currentAgentConfig(): JsonObject | undefined {
  const value = draftConfig?.["agent"];
  return isJsonObject(value) ? value : undefined;
}

function currentImageRecognitionConfig(): JsonObject | undefined {
  const value = draftConfig?.["image_recognition"];
  return isJsonObject(value) ? value : undefined;
}

function imageRecognitionEnabled(): boolean {
  return currentImageRecognitionConfig()?.["enable"] === true;
}

function mainAgentSupportsVision(): boolean {
  const agent = currentAgentConfig();
  if (agent === undefined) return false;
  const configuredInput = agent["input"];
  const inputConfigured =
    Array.isArray(configuredInput) &&
    configuredInput.length > 0 &&
    configuredInput.every((value) => value === "text" || value === "image");
  const inputAllowsVision =
    inputConfigured && configuredInput.includes("image");
  const provider =
    typeof agent["provider"] === "string" ? agent["provider"] : "";
  if (agentProviderAcceptsCustomModels(provider)) return inputAllowsVision;
  const model = typeof agent["model"] === "string" ? agent["model"] : "";
  const selected = agentCatalog === undefined
    ? undefined
    : agentCatalogModel(agentCatalog, provider, model);
  return modelSupportsVision(selected) &&
    (!inputConfigured || inputAllowsVision);
}

function agentParametersActive(): boolean {
  return currentAgentConfig()?.["mode"] === "llm";
}

function modelSupportsVision(model: { readonly input: readonly string[] } | undefined): boolean {
  return model?.input.includes("image") === true;
}

function imageRecognitionFieldInactive(path: readonly string[]): boolean {
  return path.length >= 2
    && path[0] === "image_recognition"
    && path[1] !== "enable"
    && (!imageRecognitionEnabled() || mainAgentSupportsVision());
}

function isHistoricalSettingsPath(path: readonly string[]): boolean {
  if (
    path.length >= 2
    && path[0] === "gpt_sovits"
    && (path[1] === "gpt_model_path" || path[1] === "sovits_model_path")
  ) {
    return true;
  }
  if (
    path.length >= 2
    && path[0] === "vits"
    && path[1] === "gpt_sovits"
  ) {
    return true;
  }
  if (
    path.length >= 2
    && path[0] === "bert_vits2"
    && path[1] === "刘悦-中文特化API"
  ) {
    return true;
  }
  return path.length >= 2
    && path[0] === "webui"
    && path[1] !== "ip"
    && path[1] !== "port";
}

function isUiReadOnlySettingsPath(path: readonly string[]): boolean {
  return isReadOnlySettingsPath(path, readOnlyPaths) || isHistoricalSettingsPath(path);
}

function historicalSettingsHelp(path: readonly string[]): string | undefined {
  if (!isHistoricalSettingsPath(path)) return undefined;
  return "历史保留配置：当前运行时没有消费者，不会生效。为避免误配，此值仅供查看并会随配置原样保留。";
}


function agentFieldHelp(path: readonly string[]): string | undefined {
  if (path.length !== 2 || path[0] !== "agent") return undefined;
  const currentAgent = currentAgentConfig();
  const configuredProvider = currentAgent?.["provider"];
  const providerId = typeof configuredProvider === "string" ? configuredProvider : "";
  switch (path[1]) {
    case "mode":
      return "默认事件路由：llm 调用 Pi Agent，reread 原文复读，disabled 不生成回复。";
    case "provider":
      return "供应商选项来自服务端 Pi 模型目录，不会切换到旧版 provider 配置。";
    case "model":
      return agentProviderAcceptsCustomModels(providerId)
        ? "兼容接口允许直接输入 model ID；切回内置供应商后将恢复可选模型列表。"
        : "切换模型会同步目录中的上下文、输出以及推理、视觉和工具能力。";
    case "apiKey":
      return agentProviderAcceptsCustomModels(providerId)
        || (typeof currentAgent?.["baseUrl"] === "string"
          && currentAgent["baseUrl"].trim() !== "")
        ? `兼容或覆盖端点须显式填写密钥或在 headers 提供授权；回环端点可留空。${REDACTED_API_KEY} 会由服务端恢复。`
        : `官方端点可使用该 provider 的环境变量凭据；${REDACTED_API_KEY} 会在完整配置保存时由服务端恢复。`;
    case "baseUrl":
      return agentProviderAcceptsCustomModels(providerId)
        ? "openai-compatible 必须配置可访问的 Base URL。"
        : "内置供应商通常留空；仅在需要覆盖服务地址时填写。";
    case "systemPrompt":
      return "应用于 Pi Agent 的系统提示词，支持多行文本。";
    case "thinkingLevel":
      return "该等级会写入 Pi Agent state；模型仍须支持 reasoning。";
    case "reasoning":
      return "勾选后按推理模型处理；切换内置模型时根据目录能力自动同步。";
    case "input":
      return "勾选后允许主模型直接接收图片；关闭时可使用下方专用视觉模型进行转述。";
    case "tools":
      return "勾选后运行时向模型公开 Agent 工具；切换内置模型时自动同步。";
    case "contextWindow":
    case "maxTokens":
      return "这是当前模型的有效覆盖值；选择目录模型时会同步其能力元数据。";
    case "headers":
      return "JSON 对象；请勿在这里展示未脱敏的 Authorization 值。";
    case "samplingParams":
      return "JSON 对象；仅填写 Pi API 支持的附加采样参数。";
    default:
      return undefined;
  }
}

function idleTaskFieldHelp(path: readonly string[]): string | undefined {
  if (path[0] !== "idle_time_task") return undefined;
  if (path.length === 2 && path[1] === "enable") {
    return "与 LLM 答谢共用通知机制：空闲时将提示包裹在 <system-notice> 与 <\\system-notice> 中交给主 Agent 生成回复。须使用 LLM 模式并启用至少一组提示；不再直接朗读文案或播放本地音频。";
  }
  if (path.length === 3 && path[2] === "copy" && (path[1] === "copywriting" || path[1] === "comment")) {
    return "作为闲时通知内容交给 LLM，不作为普通弹幕或固定回复。支持 {time}、{user_num}、{last_username} 和 [选项1|选项2]；多组启用时轮流选取，组内按随机或顺序轮换。";
  }
  return undefined;
}

function searchFieldHelp(path: readonly string[]): string | undefined {
  if (path.length !== 2 || path[0] !== "search_online") return undefined;
  switch (path[1]) {
    case "enable":
      return "启用后向 Pi Agent 注册 online_search 工具，由 LLM 按需调用，不再通过关键词或每条消息自动搜索。须使用 LLM 模式并开启主模型的工具能力。";
    case "provider":
      return "使用服务商官方联网搜索 API；切换服务商会清空密钥、接口地址和模型，请重新填写。";
    case "api_key":
      return "必须填写当前搜索服务商的 API Key，不复用主模型密钥或环境变量。保存后脱敏显示；使用按服务商规则计费。";
    case "endpoint":
      return "通常留空使用官方地址；自定义时填写完整 API 路径（OpenAI 为 /v1/responses，Kimi 为 /v1/chat/completions），不要在 URL 中填写密钥。";
    case "model":
      return "仅 OpenAI / Kimi 使用。留空默认 gpt-5.4-mini / kimi-k2.6；自定义模型须支持官方联网搜索工具。其他服务商忽略此项。";
    case "count":
      return "1–20。Tavily / Exa / Z.ai 返回不超过此数的结果；OpenAI / Kimi 按此数请求来源，返回一份综合摘要，实际来源数由模型决定。";
    default:
      return undefined;
  }
}
function imageRecognitionFieldHelp(path: readonly string[]): string | undefined {
  if (path.length !== 2 || path[0] !== "image_recognition") return undefined;
  const standby = path[1] !== "enable" && mainAgentSupportsVision()
    ? "主模型已支持图片输入，此专用配置保持待机。"
    : "";
  switch (path[1]) {
    case "enable":
      return mainAgentSupportsVision()
        ? "当前主模型已支持图片输入，图片会直接交给主模型；专用视觉模型不会被调用。"
        : "开启后，图片先由此专用 Pi 视觉模型进行转述；仅在主模型不支持图片输入时调用。";
    case "provider":
      return `${standby}仅列出包含视觉模型的 Pi provider；兼容接口可填写自定义视觉模型。`;
    case "model":
      return `${standby}内置 provider 只列出支持 image 输入的模型。`;
    case "apiKey":
      return `${standby}可使用视觉 provider 的环境变量凭据；${REDACTED_API_KEY} 会由服务端恢复。`;
    case "baseUrl":
      return `${standby}内置 provider 通常留空；openai-compatible 必须填写可访问的 Base URL。`;
    case "systemPrompt":
      return `${standby}限定专用模型只做客观图片转述，不参与主对话工具调用。`;
    case "prompt":
      return `${standby}图片事件未附带文字指令时，作为视觉模型的默认转述要求。`;
    default:
      return standby || undefined;
  }
}


function agentFieldView(field: string): FieldView | undefined {
  return fieldViews.find(({ path }) =>
    path.length === 2 && path[0] === "agent" && path[1] === field
  );
}

function imageRecognitionFieldView(field: string): FieldView | undefined {
  return fieldViews.find(({ path }) =>
    path.length === 2 &&
    path[0] === "image_recognition" &&
    path[1] === field
  );
}

function agentCredentialDraftPending(): boolean {
  const loaded = loadedConfig;
  const draft = draftConfig;
  if (loaded === undefined || draft === undefined) return false;
  return AGENT_CREDENTIAL_FIELDS.some((field) => {
    const path = ["agent", field] as const;
    const view = agentFieldView(field);
    return isSettingsPathDirty(loaded, draft, path)
      || (view !== undefined && view.error.textContent !== "");
  });
}

function isLoopbackAgentBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const hostname = new URL(value).hostname.toLocaleLowerCase("en-US");
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function updateAgentOverview(): void {
  const catalog = agentCatalog;
  const agent = currentAgentConfig();
  if (catalog === undefined || agent === undefined) {
    agentOverview.hidden = true;
    return;
  }

  const modeId = typeof agent["mode"] === "string" ? agent["mode"] : "";
  const providerId = typeof agent["provider"] === "string" ? agent["provider"] : "";
  const modelId = typeof agent["model"] === "string" ? agent["model"] : "";
  const provider = agentCatalogProvider(catalog, providerId);
  const model = agentCatalogModel(catalog, providerId, modelId);
  const mode = catalog.modes.find(({ id }) => id === modeId);
  const customModel = agentProviderAcceptsCustomModels(providerId);

  agentOverview.hidden = false;
  agentSource.textContent = agentMaterializationPending
    ? AGENT_SOURCE_LABELS[catalog.source] ?? "Agent 配置待写入"
    : AGENT_SOURCE_LABELS["agent"] ?? "根 agent · 当前主配置";
  agentSource.dataset.materialized = String(agentMaterializationPending);
  agentRoute.textContent = `${(mode?.name ?? modeId) || "未知模式"} · ${AGENT_ROUTE_LABELS[modeId] ?? "路由不可用"}`;
  agentSelection.textContent = provider === undefined
    ? `${providerId || "未选择 provider"} / ${modelId || "未选择 model"}`
    : `${provider.name} / ${(model?.name ?? modelId) || "未选择 model"}`;

  const visualEnabled = Array.isArray(agent["input"]) && agent["input"].includes("image");
  const capabilities = [
    `推理${agent["reasoning"] === true ? "开启" : "关闭"}`,
    `视觉${visualEnabled ? "开启" : "关闭"}`,
    `工具${agent["tools"] === true ? "开启" : "关闭"}`,
  ].join(" / ");
  const contextWindow = typeof agent["contextWindow"] === "number"
    ? agent["contextWindow"].toLocaleString("zh-CN")
    : "—";
  const maxTokens = typeof agent["maxTokens"] === "number"
    ? agent["maxTokens"].toLocaleString("zh-CN")
    : "—";
  const api = model?.api ?? (customModel ? "OpenAI compatible" : "API 未知");
  agentCapability.textContent = `${api} · ${capabilities} · 窗口 ${contextWindow} / 输出 ${maxTokens}`;
  const draftApiKey = typeof agent["apiKey"] === "string" ? agent["apiKey"] : "";
  const apiKeyChanged = loadedConfig !== undefined
    && draftConfig !== undefined
    && isSettingsPathDirty(loadedConfig, draftConfig, ["agent", "apiKey"]);
  const newCredentialEntered = apiKeyChanged
    && draftApiKey.trim() !== ""
    && draftApiKey !== REDACTED_API_KEY;
  const missingCredentialStatus =
    (customModel ||
      (typeof agent["baseUrl"] === "string" && agent["baseUrl"].trim() !== ""))
      ? isLoopbackAgentBaseUrl(agent["baseUrl"])
        ? "回环端点允许无密钥运行，也可填写下方密钥字段"
        : "尚未配置；兼容或覆盖端点须填写密钥或授权请求头"
      : "尚未配置，可使用环境变量或下方密钥字段";
  agentCredential.textContent = newCredentialEntered
    ? "新凭据已填写，待保存校验"
    : agentCredentialDraftPending()
      ? "待保存校验"
      : !agentCatalogAuthoritative
        ? "配置已保存，凭据状态待目录刷新"
        : catalog.apiKeyConfigured
          ? "已配置（内容保持隐藏）"
          : missingCredentialStatus;

  const providerCount = catalog.providers.length.toLocaleString("zh-CN");
  const modelCount = catalog.providers
    .reduce((count, item) => count + item.models.length, 0)
    .toLocaleString("zh-CN");
  let catalogMessage = `Pi 模型目录已载入：${providerCount} 个 provider，${modelCount} 个内置模型。`;
  let catalogTone: Tone = "success";
  const localAgentError = fieldViews.find(({ path, error }) =>
    (path[0] === "agent" || path[0] === "image_recognition") &&
    error.textContent !== ""
  );
  if (agentSaveError !== undefined) {
    catalogMessage = `Agent 配置保存校验失败：${agentSaveError}`;
    catalogTone = "error";
  } else if (agentCatalogRefreshError !== undefined) {
    catalogMessage = `配置已保存，但 Pi 模型目录刷新失败：${agentCatalogRefreshError}`;
    catalogTone = "warning";
  } else if (catalog.validationError !== undefined) {
    catalogMessage = `当前 Agent 配置校验失败：${catalog.validationError}`;
    catalogTone = "error";
  } else if (localAgentError !== undefined) {
    catalogMessage = `请修正 ${localizedSettingsPathLabel(localAgentError.path)}：${localAgentError.error.textContent}`;
    catalogTone = "error";
  } else if (modeId !== "llm") {
    catalogMessage = imageRecognitionEnabled()
      ? `${catalogMessage} 主对话不调用 LLM；图片由专用 Pi 视觉模型转述。`
      : `${catalogMessage} 当前模式不调用 LLM，主模型参数已禁用但会原样保留。${agentMaterializationPending ? " 保存后将补全根 agent 配置。" : ""}`;
    catalogTone = "warning";
  } else if (provider === undefined) {
    catalogMessage = "当前 provider 不在 Pi 模型目录中，请从下方目录重新选择。";
    catalogTone = "error";
  } else if (!customModel && model === undefined) {
    catalogMessage = "当前 model 不属于所选 provider，请从下方目录重新选择。";
    catalogTone = "error";
  } else if (customModel && (typeof agent["baseUrl"] !== "string" || agent["baseUrl"].trim() === "")) {
    catalogMessage = "openai-compatible 需要填写下方 Base URL；model ID 可自由输入。";
    catalogTone = "warning";
  } else if (agentMaterializationPending) {
    catalogMessage = `${catalogMessage} 保存后将补全根 agent 配置。`;
    catalogTone = "warning";
  } else if (imageRecognitionEnabled()) {
    catalogMessage = mainAgentSupportsVision()
      ? `${catalogMessage} 主模型已支持图片输入，专用视觉模型保持待机。`
      : `${catalogMessage} 主模型不支持图片输入，图片将由专用 Pi 视觉模型转述。`;
  }
  agentCatalogState.textContent = catalogMessage;
  agentCatalogState.dataset.tone = catalogTone;
}
function scheduleDraft(): JsonValue[] {
  if (draftConfig === undefined) return [];
  const schedule = draftConfig["schedule"];
  if (Array.isArray(schedule)) return schedule;
  if (schedule === undefined) {
    const tasks: JsonValue[] = [];
    Object.defineProperty(draftConfig, "schedule", {
      configurable: true,
      enumerable: true,
      value: tasks,
      writable: true,
    });
    return tasks;
  }
  return [];
}

function rerenderSchedule(change: () => void, focusPath?: readonly string[]): void {
  const preserved = captureUnparsedFieldStates();
  change();
  renderConfig();
  restoreUnparsedFieldStates(preserved);
  if (focusPath !== undefined) {
    focusFieldView(fieldViews.find(({ path }) => samePath(path, focusPath)));
  }
}

function renderScheduleEditor(parent: HTMLElement): void {
  const schedule = draftConfig?.["schedule"];
  if (schedule !== undefined && !Array.isArray(schedule)) {
    const error = createText("small", "定时任务配置必须为任务列表；请修正后再编辑。");
    error.className = "settings-field-error";
    parent.append(error);
    return;
  }
  let tasks: readonly ScheduleTask[] = [];
  try {
    // Validate stored data, not the temporarily incomplete draft being edited.
    parseScheduleConfig(loadedConfig?.["schedule"]);
    tasks = (schedule ?? []) as unknown as readonly ScheduleTask[];
  } catch (error) {
    const message = error instanceof ScheduleConfigurationError ? error.message : describeError(error);
    const notice = createText("small", `定时任务配置格式无效，请通过高级 JSON 编辑器修正：${message}`);
    notice.className = "settings-field-error";
    parent.append(notice);
    return;
  }

  const description = createText("small", "");
  description.className = "schedule-editor-description";
  description.dataset.scheduleModeNotice = "";
  parent.append(description);
  const help = createText("small", "每次随机选取一条提示词。变量：{time} 当前时间、{user_num} 在线人数、{last_username} 最近活动用户；[选项1|选项2] 随机选择一个选项。间隔从上轮处理完成后计算。");
  help.className = "schedule-editor-description";
  parent.append(help);
  if (tasks.length === 0) {
    const empty = createText("strong", "暂无定时任务，添加后可在保存时启用。");
    empty.className = "schedule-editor-empty";
    parent.append(empty);
  }

  tasks.forEach((task, index) => {
    const card = document.createElement("article");
    card.className = "schedule-card";
    card.dataset.scheduleId = task.id;
    const header = document.createElement("header");
    const title = createText("strong", task.name || "未命名定时任务");
    header.append(title, createText("small", ""));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-secondary schedule-card-remove";
    remove.textContent = "删除任务";
    remove.dataset.scheduleMutationPath = `schedule.${index}`;
    remove.addEventListener("click", () => {
      rerenderSchedule(() => { scheduleDraft().splice(index, 1); });
    });
    header.append(remove);
    card.append(header);
    const body = document.createElement("div");
    body.className = "schedule-card-fields";
    for (const field of ["name", "enable", "run_on_start"] as const) {
      body.append(renderField(task[field] as JsonValue, ["schedule", String(index), field]));
    }
    body.append(renderField(task.interval.mode, ["schedule", String(index), "interval", "mode"]));
    body.append(renderField(task.interval.unit, ["schedule", String(index), "interval", "unit"]));
    if (task.interval.mode === "fixed") {
      body.append(renderField(task.interval.every, ["schedule", String(index), "interval", "every"]));
    } else {
      for (const field of ["min", "max"] as const) {
        body.append(renderField(
          task.interval[field] as JsonValue,
          ["schedule", String(index), "interval", field],
        ));
      }
    }
    const prompts = document.createElement("div");
    prompts.className = "schedule-prompts";
    prompts.append(createText("strong", "提示词"));
    task.prompts.forEach((prompt, promptIndex) => {
      const row = document.createElement("div");
      row.className = "schedule-prompt";
      row.append(renderField(prompt, ["schedule", String(index), "prompts", String(promptIndex)]));
      const removePrompt = document.createElement("button");
      removePrompt.type = "button";
      removePrompt.className = "button button-secondary";
      removePrompt.textContent = "删除提示词";
      removePrompt.dataset.scheduleMutationPath = `schedule.${index}.prompts`;
      removePrompt.addEventListener("click", () => {
        rerenderSchedule(() => {
          const current = scheduleDraft()[index] as JsonObject;
          (current["prompts"] as JsonValue[]).splice(promptIndex, 1);
        });
      });
      row.append(removePrompt);
      prompts.append(row);
    });
    const addPrompt = document.createElement("button");
    addPrompt.type = "button";
    addPrompt.className = "button button-secondary";
    addPrompt.textContent = "添加提示词";
    addPrompt.dataset.scheduleMutationPath = `schedule.${index}.prompts`;
    addPrompt.addEventListener("click", () => {
      const current = scheduleDraft()[index] as JsonObject;
      const prompts = current["prompts"] as JsonValue[];
      const promptIndex = prompts.length;
      rerenderSchedule(() => { prompts.push(""); }, ["schedule", String(index), "prompts", String(promptIndex)]);
    });
    prompts.append(addPrompt);
    body.append(prompts);
    card.append(body);
    parent.append(card);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "button button-secondary schedule-add";
  add.textContent = "添加定时任务";
  add.dataset.scheduleMutationPath = "schedule";
  add.addEventListener("click", () => {
    const index = scheduleDraft().length;
    rerenderSchedule(() => {
      scheduleDraft().push({
        id: crypto.randomUUID(),
        name: "新定时任务",
        enable: false,
        run_on_start: false,
        interval: { mode: "fixed", every: 10, unit: "minutes" },
        prompts: [""],
      });
    }, ["schedule", String(index), "name"]);
  });
  parent.append(add);
}


function renderConfig(): void {
  const expandedSections = new Set(sectionViews.filter(({ container }) => container.open).map(({ key }) => key));
  const restoreSectionExpansion = sectionViews.length > 0;
  const expandedNavigationCategories = new Set(
    Array.from(sectionNavigation.querySelectorAll<HTMLDetailsElement>(".settings-nav-category"))
      .filter(({ open }) => open)
      .map(({ dataset }) => dataset.category),
  );
  const restoreNavigationExpansion = sectionNavigation.children.length > 0;
  fieldViews.length = 0;
  sectionViews.length = 0;
  fieldSequence = 0;
  settingsTree.replaceChildren();
  sectionNavigation.replaceChildren();

  const config = draftConfig;
  if (config === undefined) {
    emptyState.hidden = false;
    agentOverview.hidden = true;
    updateSummary();
    return;
  }

  const descriptorsByKey = new Map(
    describeSettingsConfig(config, readOnlyPaths).map((section) => [section.key, section]),
  );
  const categories = categorizeSettingsKeys(
    Object.hasOwn(config, "schedule") ? Object.keys(config) : [...Object.keys(config), "schedule"],
  );
  let renderedSectionIndex = 0;
  let renderedCategoryIndex = 0;

  for (const category of categories) {
    const categoryContainer = document.createElement("section");
    categoryContainer.className = "settings-category";
    categoryContainer.dataset.category = category.id;

    const categoryHeader = document.createElement("header");
    categoryHeader.className = "settings-category-header";
    const categoryHeading = document.createElement("h3");
    categoryHeading.textContent = category.label;
    const categoryDescription = document.createElement("p");
    categoryDescription.textContent = category.description;
    categoryHeader.append(categoryHeading, categoryDescription);
    categoryContainer.append(categoryHeader);

    const navigationGroup = document.createElement("details");
    navigationGroup.className = "settings-nav-category";
    navigationGroup.dataset.category = category.id;
    navigationGroup.open = restoreNavigationExpansion
      ? expandedNavigationCategories.has(category.id)
      : renderedCategoryIndex === 0;
    const navigationHeading = document.createElement("summary");
    navigationHeading.className = "settings-nav-category-heading";
    navigationHeading.append(
      createText("strong", category.label),
      createText("small", `${category.sections.length.toLocaleString("zh-CN")} 个分区`),
    );
    const navigationItems = document.createElement("div");
    navigationItems.className = "settings-nav-category-items";
    navigationGroup.append(navigationHeading, navigationItems);
    sectionNavigation.append(navigationGroup);

    for (const catalogSection of category.sections) {
      const descriptors = catalogSection.keys
        .map((key) => descriptorsByKey.get(key))
        .filter((section) => section !== undefined);
      const fieldCount = descriptors.reduce((count, section) => count + section.fields.length, 0);
      const countLabel = catalogSection.id === "schedule"
        ? `${Array.isArray(config["schedule"]) ? config["schedule"].length : 0} 个任务`
        : `${fieldCount.toLocaleString("zh-CN")} 项`;
      const details = document.createElement("details");
      details.className = "settings-section";
      details.open = restoreSectionExpansion
        ? expandedSections.has(`${category.id}:${catalogSection.id}`)
        : renderedSectionIndex === 0;
      details.dataset.section = `${category.id}:${catalogSection.id}`;

      const summary = document.createElement("summary");
      const summaryLabel = createText("span", catalogSection.label);
      summaryLabel.className = "settings-section-label";
      summary.append(
        summaryLabel,
        createText("small", countLabel),
      );
      if (
        fieldCount > 0
        && descriptors.every((section) => section.fields.every((field) => field.readOnly))
      ) {
        const lock = createText("span", "只读");
        lock.className = "settings-lock";
        summary.append(lock);
      }
      details.append(summary);

      const body = document.createElement("div");
      const combinedAgentSection =
        category.id === "agent" && catalogSection.id === "pi-agent";
      for (const sectionKey of catalogSection.keys) {
        const sectionValue = config[sectionKey] as JsonValue;
        if (sectionKey === "schedule") {
          renderScheduleEditor(body);
        } else if (
          combinedAgentSection
          && sectionKey === "agent"
          && isJsonObject(sectionValue)
          && Object.keys(sectionValue).length > 0
        ) {
          let capabilitiesRendered = false;
          for (const key of Object.keys(sectionValue)) {
            if (AGENT_CAPABILITY_FIELDS.some((field) => field === key)) {
              if (!capabilitiesRendered) {
                renderAgentCapabilities(body, sectionValue);
                capabilitiesRendered = true;
              }
              continue;
            }
            renderValue(
              body,
              sectionValue[key] as JsonValue,
              [sectionKey, key],
              key,
              1,
            );
          }
        } else if (catalogSection.keys.length > 1) {
          renderValue(
            body,
            sectionValue,
            [sectionKey],
            sectionKey,
            combinedAgentSection && sectionKey === "image_recognition" ? 2 : 0,
          );
        } else if (isJsonObject(sectionValue) && Object.keys(sectionValue).length > 0) {
          for (const key of Object.keys(sectionValue)) {
            renderValue(
              body,
              sectionValue[key] as JsonValue,
              [sectionKey, key],
              key,
              1,
            );
          }
        } else {
          body.append(renderField(sectionValue, [sectionKey]));
        }
      }
      details.append(body);
      categoryContainer.append(details);

      const navigation = document.createElement("button");
      navigation.type = "button";
      const navigationLabel = createText("span", catalogSection.label);
      navigation.append(
        navigationLabel,
        createText("small", countLabel),
      );
      navigation.addEventListener("click", () => {
        details.open = true;
        details.scrollIntoView({ behavior: "smooth", block: "start" });
        for (const view of sectionViews) view.navigation.removeAttribute("aria-current");
        navigation.setAttribute("aria-current", "true");
      });
      navigationItems.append(navigation);
      sectionViews.push({
        container: details,
        navigation,
        key: `${category.id}:${catalogSection.id}`,
      });
      renderedSectionIndex += 1;
    }

    settingsTree.append(categoryContainer);
    renderedCategoryIndex += 1;
  }

  emptyState.hidden = categories.length > 0;
  setBusy(busy);
  applyPlatformLocalValidation();
  applyAgentLocalValidation();
  applyScheduleLocalValidation();
  applySearchLocalValidation();
  updateSummary();
  updateAgentOverview();
}

function renderAgentCapabilities(
  parent: HTMLElement,
  agent: JsonObject,
): void {
  const group = document.createElement("details");
  group.className = "settings-group settings-capability-group";
  group.open = true;
  group.dataset.settingsGroupPath = "agent.capabilities";
  const summary = document.createElement("summary");
  summary.append(
    createText("span", "模型能力"),
    createText("small", "切换内置模型时自动同步"),
  );
  group.append(summary);
  const body = document.createElement("div");
  body.className = "settings-capability-fields";
  for (const field of AGENT_CAPABILITY_FIELDS) {
    if (!Object.hasOwn(agent, field)) continue;
    renderValue(
      body,
      agent[field] as JsonValue,
      ["agent", field],
      field,
      2,
    );
  }
  group.append(body);
  parent.append(group);
}

function renderValue(
  parent: HTMLElement,
  value: JsonValue,
  path: string[],
  key: string,
  depth: number,
): void {
  const agentJsonControl = path.length === 2
    && path[0] === "agent"
    && (path[1] === "headers" || path[1] === "samplingParams");
  if (!agentJsonControl && isJsonObject(value) && Object.keys(value).length > 0) {
    if (path.length === 2 && path[0] === "filter" && path[1] === "badwords") {
      for (const childKey of Object.keys(value)) {
        renderValue(
          parent,
          value[childKey] as JsonValue,
          [...path, childKey],
          childKey,
          depth,
        );
      }
      return;
    }
    const group = document.createElement("details");
    group.className = "settings-group";
    group.open = depth < 2;
    group.dataset.settingsGroupPath = path.join(".");
    const summary = document.createElement("summary");
    summary.append(createText("span", localizedSettingsPathLabel(path)));
    const pendingPlatform = pendingPlatformForPath(path);
    if (pendingPlatform !== undefined) {
      const lock = createText("span", "待完善，暂不可配置或启用");
      lock.className = "settings-lock";
      summary.append(lock);
    } else if (isUiReadOnlySettingsPath(path)) {
      const lock = createText(
        "span",
        isHistoricalSettingsPath(path) ? "历史保留 · 不生效" : "只读",
      );
      lock.className = "settings-lock";
      summary.append(lock);
    }
    group.append(summary);
    const body = document.createElement("div");
    for (const childKey of Object.keys(value)) {
      renderValue(
        body,
        value[childKey] as JsonValue,
        [...path, childKey],
        childKey,
        depth + 1,
      );
    }
    group.append(body);
    parent.append(group);
    return;
  }
  parent.append(renderField(value, path));
}

function renderField(
  value: JsonValue,
  path: string[],
): HTMLElement {
  const kind = settingsFieldKind(value);
  const readOnly = isUiReadOnlySettingsPath(path);
  const secret = isSecretSettingsPath(path);
  const container = document.createElement("div");
  container.className = "settings-field";
  container.dataset.settingsPath = path.join(".");
  const currentProvider = currentAgentConfig()?.["provider"];
  if (
    path.length === 2
    && path[0] === "agent"
    && path[1] === "baseUrl"
    && currentProvider === "openai-compatible"
  ) {
    container.dataset.agentAttention = "true";
  }

  const copy = document.createElement("div");
  copy.className = "settings-field-copy";
  const id = `settings-field-${++fieldSequence}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = localizedSettingsPathLabel(path);
  const pendingPlatform = pendingPlatformForPath(path);
  const helpText = pendingPlatform === undefined
    ? historicalSettingsHelp(path) ?? badwordsFieldHelp(path) ?? idleTaskFieldHelp(path) ?? searchFieldHelp(path) ?? edgeVoiceFieldHelp(path) ?? imageRecognitionFieldHelp(path) ?? agentFieldHelp(path)
    : "待完善，暂不可配置或启用。";
  const help = helpText === undefined ? undefined : createText("small", helpText);
  if (help !== undefined) {
    help.className = "settings-field-help";
    help.id = `${id}-help`;
  }
  copy.append(label);
  if (help !== undefined) copy.append(help);
  container.append(copy);

  const controlWrap = document.createElement("div");
  controlWrap.className = "settings-field-control";
  const control = createControl(id, kind, value, secret, path);
  controlWrap.append(control);
  container.append(controlWrap);

  const meta = document.createElement("div");
  meta.className = "settings-field-meta";
  if (secret) meta.append(createText("span", "敏感字段"));
  if (pendingPlatform === undefined && readOnly) {
    const lock = createText(
      "span",
      isHistoricalSettingsPath(path) ? "历史保留 · 不生效" : "本机策略 · 只读",
    );
    lock.className = "settings-lock";
    meta.append(lock);
  }
  const error = document.createElement("span");
  error.className = "settings-field-error";
  error.id = `${id}-error`;
  error.setAttribute("role", "alert");
  meta.append(error);
  control.setAttribute(
    "aria-describedby",
    help === undefined ? error.id : `${help.id} ${error.id}`,
  );
  container.append(meta);

  const view: FieldView = {
    container,
    control,
    error,
    kind,
    path: [...path],
    readOnly,
  };
  fieldViews.push(view);

  const onEdit = (): void => handleFieldEdit(view);
  const checkbox = control instanceof HTMLInputElement && control.type === "checkbox";
  control.addEventListener(
    checkbox || control instanceof HTMLSelectElement ? "change" : "input",
    onEdit,
  );
  applyReadOnly(view);
  return container;
}

function createSelectControl(
  id: string,
  value: JsonValue,
  options: readonly SettingsChoiceOption[],
  path: readonly string[],
): HTMLSelectElement {
  const select = document.createElement("select");
  select.id = id;
  const currentValue = typeof value === "string" ? value : "";
  if (
    currentValue !== ""
    && !options.some(({ value: optionValue }) => optionValue === currentValue)
  ) {
    const current = document.createElement("option");
    current.value = currentValue;
    current.textContent = `${currentValue}（当前配置，未识别）`;
    current.disabled = path.length === 1 && path[0] === "platform";
    select.append(current);
  }
  for (const { value: optionValue, label, disabled } of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    option.disabled = disabled === true;
    select.append(option);
  }
  select.value = currentValue;
  return select;
}

function createControl(
  id: string,
  kind: SettingsFieldKind,
  value: JsonValue,
  secret: boolean,
  path: readonly string[],
): FieldControl {
  if (
    path.length === 4
    && path[0] === "schedule"
    && path[2] === "interval"
    && path[3] === "unit"
  ) {
    return createSelectControl(
      id,
      value,
      Object.entries(SCHEDULE_INTERVAL_UNITS).map(([optionValue, unit]) => ({
        value: optionValue,
        label: unit.label,
      })),
      path,
    );
  }
  if (path.length === 4 && path[0] === "schedule" && path[2] === "interval" && path[3] === "mode") {
    return createSelectControl(id, value, [
      { value: "fixed", label: "固定间隔" },
      { value: "random", label: "随机间隔" },
    ], path);
  }
  const configuredOptions = settingsPathOptions(path, draftConfig);
  if (configuredOptions !== undefined) {
    return createSelectControl(id, value, configuredOptions, path);
  }

  if (
    path.length === 2 &&
    path[0] === "edge-tts" &&
    path[1] === "voice"
  ) {
    const select = document.createElement("select");
    select.id = id;
    const currentVoice = typeof value === "string" ? value : "";
    if (
      currentVoice !== "" &&
      !edgeVoices.some(({ shortName }) => shortName === currentVoice)
    ) {
      const current = document.createElement("option");
      current.value = currentVoice;
      current.textContent = `${currentVoice}（当前配置）`;
      select.append(current);
    }
    for (const voice of edgeVoices) {
      const option = document.createElement("option");
      option.value = voice.shortName;
      const gender = voice.gender === "Female"
        ? "女声"
        : voice.gender === "Male"
          ? "男声"
          : voice.gender;
      option.textContent =
        `${voice.shortName} · ${voice.localeName} · ${gender}`;
      select.append(option);
    }
    select.value = currentVoice;
    return select;
  }

  const catalog = agentCatalog;
  if (path.length === 2 && path[0] === "agent" && catalog !== undefined) {
    const field = path[1];
    const selectOptions = field === "mode"
      ? catalog.modes.map(({ id: optionValue, name }) => ({ value: optionValue, label: name }))
      : field === "provider"
        ? catalog.providers.map(({ id: optionValue, name }) => ({
          value: optionValue,
          label: `${name} (${optionValue})`,
        }))
        : field === "thinkingLevel"
          ? AGENT_THINKING_LEVELS.map((optionValue) => ({
            value: optionValue,
            label: `${THINKING_LEVEL_LABELS[optionValue] ?? optionValue} (${optionValue})`,
          }))
          : undefined;
    if (selectOptions !== undefined) {
      const select = document.createElement("select");
      select.id = id;
      for (const { value: optionValue, label: optionLabel } of selectOptions) {
        const option = document.createElement("option");
        option.value = optionValue;
        option.textContent = optionLabel;
        select.append(option);
      }
      select.value = typeof value === "string" ? value : "";
      return select;
    }

    if (field === "model") {
      const agent = currentAgentConfig();
      const configuredProvider = agent?.["provider"];
      const providerId = typeof configuredProvider === "string" ? configuredProvider : "";
      if (!agentProviderAcceptsCustomModels(providerId)) {
        const select = document.createElement("select");
        select.id = id;
        const provider = agentCatalogProvider(catalog, providerId);
        const models = provider?.models ?? [];
        for (const model of models) {
          const option = document.createElement("option");
          option.value = model.id;
          option.textContent = `${model.name} (${model.id})`;
          select.append(option);
        }
        select.value = typeof value === "string" ? value : "";
        return select;
      }
    }

    if (field === "systemPrompt") {
      const control = document.createElement("textarea");
      control.id = id;
      control.rows = 6;
      control.value = typeof value === "string" ? value : "";
      return control;
    }
  }

  if (
    path.length === 2 &&
    path[0] === "image_recognition" &&
    catalog !== undefined
  ) {
    const field = path[1];
    if (field === "provider" || field === "thinkingLevel") {
      const options = field === "provider"
        ? catalog.providers
            .filter(({ id: providerId, models }) =>
              agentProviderAcceptsCustomModels(providerId) ||
              models.some(modelSupportsVision)
            )
            .map(({ id: optionValue, name }) => ({
              value: optionValue,
              label: `${name} (${optionValue})`,
            }))
        : AGENT_THINKING_LEVELS.map((optionValue) => ({
          value: optionValue,
          label: `${THINKING_LEVEL_LABELS[optionValue] ?? optionValue} (${optionValue})`,
        }));
      const select = document.createElement("select");
      select.id = id;
      for (const { value: optionValue, label: optionLabel } of options) {
        const option = document.createElement("option");
        option.value = optionValue;
        option.textContent = optionLabel;
        select.append(option);
      }
      select.value = typeof value === "string" ? value : "";
      return select;
    }

    if (field === "model") {
      const imageRecognition = currentImageRecognitionConfig();
      const configuredProvider = imageRecognition?.["provider"];
      const providerId =
        typeof configuredProvider === "string" ? configuredProvider : "";
      if (!agentProviderAcceptsCustomModels(providerId)) {
        const select = document.createElement("select");
        select.id = id;
        const models = (agentCatalogProvider(catalog, providerId)?.models ?? [])
          .filter(modelSupportsVision);
        for (const model of models) {
          const option = document.createElement("option");
          option.value = model.id;
          option.textContent = `${model.name} (${model.id})`;
          select.append(option);
        }
        select.value = typeof value === "string" ? value : "";
        return select;
      }
    }

    if (field === "systemPrompt") {
      const control = document.createElement("textarea");
      control.id = id;
      control.rows = 5;
      control.value = typeof value === "string" ? value : "";
      return control;
    }
  }

  if (path.length === 2 && path[0] === "agent" && path[1] === "input") {
    const control = document.createElement("input");
    control.id = id;
    control.type = "checkbox";
    control.className = "settings-capability-checkbox";
    control.checked = Array.isArray(value) && value.includes("image");
    control.setAttribute("aria-label", "启用视觉能力");
    return control;
  }

  if (
    path.length === 4
    && path[0] === "schedule"
    && path[2] === "prompts"
  ) {
    const control = document.createElement("textarea");
    control.id = id;
    control.rows = 4;
    control.value = typeof value === "string" ? value : "";
    return control;
  }

  if (kind === "array" || kind === "object" || kind === "null") {
    const control = document.createElement("textarea");
    control.id = id;
    control.rows = kind === "null" ? 3 : 6;
    control.spellcheck = false;
    control.value = JSON.stringify(value, null, 2);
    return control;
  }
  const control = document.createElement("input");
  control.id = id;
  if (kind === "boolean") {
    control.type = "checkbox";
    if (path.length === 2 && path[0] === "image_recognition" && path[1] === "enable") {
      control.className = "settings-switch";
      control.setAttribute("role", "switch");
      control.setAttribute("aria-label", "启用专用视觉模型");
    }
    if (path.length === 3 && path[0] === "schedule") {
      control.className = "settings-switch";
      control.setAttribute("role", "switch");
    }
    if (
      path.length === 2
      && path[0] === "agent"
      && (path[1] === "reasoning" || path[1] === "tools")
    ) {
      control.className = "settings-capability-checkbox";
    }
    control.checked = value as boolean;
  } else if (kind === "number") {
    control.type = "number";
    control.step = "any";
    if (
      path.length === 2
      && (path[0] === "agent" || path[0] === "image_recognition")
      && (path[1] === "maxTokens" || path[1] === "contextWindow" || path[1] === "maxSessions")
    ) {
      control.min = "1";
    }
    if (path[0] === "search_online" && path[1] === "count") {
      control.min = "1";
      control.max = "20";
      control.step = "1";
    }
    control.value = String(value);
  } else {
    control.type =
      (path[0] === "agent" || path[0] === "image_recognition")
        && path[1] === "baseUrl"
        ? "url"
        : secret
          ? "password"
          : "text";
    control.autocomplete = secret ? "new-password" : "off";
    control.value = value as string;
  }
  return control;
}

function parseControl(view: FieldView): JsonValue {
  if (
    view.path.length === 2
    && view.path[0] === "agent"
    && view.path[1] === "input"
  ) {
    return (view.control as HTMLInputElement).checked
      ? ["text", "image"]
      : ["text"];
  }
  if (view.kind === "boolean") return (view.control as HTMLInputElement).checked;
  if (view.kind === "number") {
    const source = view.control.value.trim();
    const value = source === "" ? Number.NaN : Number(source);
    if (!Number.isFinite(value)) throw new TypeError("请输入有限数字");
    return value;
  }
  if (view.kind === "string") return view.control.value;

  let value: unknown;
  try {
    value = JSON.parse(view.control.value) as unknown;
  } catch (error) {
    throw new SyntaxError(error instanceof Error ? `JSON 格式错误：${error.message}` : "JSON 格式错误");
  }
  if (view.kind === "array" && !Array.isArray(value)) throw new TypeError("此字段必须保持为 JSON 数组");
  if (view.kind === "object" && !isJsonObject(value)) throw new TypeError("此字段必须保持为 JSON 对象");
  assertJsonValue(value);
  return value;
}

function assertJsonValue(value: unknown, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON 数字必须为有限值");
    return;
  }
  if (typeof value !== "object") throw new TypeError("字段必须是有效 JSON 值");
  if (ancestors.has(value)) throw new TypeError("字段不能包含循环引用");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJsonValue(item, ancestors);
    } else {
      for (const child of Object.values(value)) assertJsonValue(child, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function setFieldError(view: FieldView, message: string, source: FieldErrorSource): void {
  view.error.textContent = message;
  view.errorSource = source;
  view.control.setAttribute("aria-invalid", "true");
}

function clearFieldError(view: FieldView, source?: FieldErrorSource): void {
  if (source !== undefined && view.errorSource !== source) return;
  view.error.textContent = "";
  delete view.errorSource;
  view.control.removeAttribute("aria-invalid");
}

function agentValidationErrors(agent: JsonObject): ReadonlyMap<string, string> {
  const errors = new Map<string, string>();
  const catalog = agentCatalog;
  const mode = agent["mode"];
  if (
    typeof mode !== "string"
    || catalog === undefined
    || !catalog.modes.some(({ id }) => id === mode)
  ) {
    errors.set("mode", "请选择有效的 Agent 运行模式");
  }
  if (mode !== "llm") return errors;

  const provider = agent["provider"];
  const providerId = typeof provider === "string" ? provider.trim() : "";
  const catalogProvider = catalog === undefined
    ? undefined
    : agentCatalogProvider(catalog, providerId);
  if (providerId === "") {
    errors.set("provider", "请选择有效的 provider");
  } else if (catalog !== undefined && catalogProvider === undefined) {
    errors.set("provider", "所选 provider 不在 Pi 模型目录中");
  }

  const selectedModel = catalog === undefined
    ? undefined
    : agentCatalogModel(catalog, providerId, typeof agent["model"] === "string" ? agent["model"].trim() : "");
  const model = agent["model"];
  const modelId = typeof model === "string" ? model.trim() : "";
  if (typeof model !== "string") {
    errors.set("model", "model ID 必须是字符串");
  } else if (agentProviderAcceptsCustomModels(providerId) && modelId === "") {
    errors.set("model", "openai-compatible 必须填写 model ID");
  } else if (
    catalogProvider !== undefined
    && !agentProviderAcceptsCustomModels(providerId)
    && agentCatalogModel(catalog!, providerId, modelId) === undefined
  ) {
    errors.set("model", "所选 model 不属于当前 provider");
  }
  const inputAllowsVision =
    Array.isArray(agent["input"]) && agent["input"].includes("image");
  if (
    selectedModel !== undefined
    && agent["reasoning"] === true
    && !selectedModel.reasoning
  ) {
    errors.set("reasoning", "所选内置模型不支持推理能力");
  }
  if (
    selectedModel !== undefined
    && inputAllowsVision
    && !modelSupportsVision(selectedModel)
  ) {
    errors.set("input", "所选内置模型不支持视觉能力");
  }
  if (
    selectedModel !== undefined
    && agent["tools"] === true
    && !selectedModel.tools
  ) {
    errors.set("tools", "所选内置模型不支持工具能力");
  }

  for (const field of ["apiKey", "baseUrl", "systemPrompt"] as const) {
    if (typeof agent[field] !== "string") {
      errors.set(field, `${field} 必须是字符串`);
    }
  }

  const baseUrl = agent["baseUrl"];
  if (typeof baseUrl === "string") {
    const source = baseUrl.trim();
    if (agentProviderAcceptsCustomModels(providerId) && source === "") {
      errors.set("baseUrl", "openai-compatible 必须填写 Base URL");
    } else if (source !== "") {
      try {
        const parsed = new URL(source);
        if (
          (parsed.protocol !== "http:" && parsed.protocol !== "https:")
          || parsed.username !== ""
          || parsed.password !== ""
          || parsed.search !== ""
          || parsed.hash !== ""
        ) {
          throw new TypeError("unsafe URL");
        }
      } catch {
        errors.set("baseUrl", "请输入不含凭据、查询参数或片段的绝对 http(s) URL");
      }
    }
  }


  for (const field of ["maxTokens", "contextWindow", "maxSessions"] as const) {
    const value = agent[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      errors.set(field, "请输入大于 0 的整数");
    }
  }

  const thinkingLevel = agent["thinkingLevel"];
  if (
    typeof thinkingLevel !== "string"
    || !AGENT_THINKING_LEVELS.some((candidate) => candidate === thinkingLevel)
  ) {
    errors.set("thinkingLevel", "请选择有效的推理等级");
  }
  if (typeof agent["reasoning"] !== "boolean") {
    errors.set("reasoning", "reasoning 必须是布尔值");
  }

  const input = agent["input"];
  if (
    !Array.isArray(input)
    || input.length === 0
    || input.some((value) => value !== "text" && value !== "image")
  ) {
    errors.set("input", "至少选择 text 或 image，且只能包含这两种输入类型");
  }
  if (typeof agent["tools"] !== "boolean") {
    errors.set("tools", "tools 必须是布尔值");
  }

  const headers = agent["headers"];
  if (!isJsonObject(headers)) {
    errors.set("headers", "headers 必须是 JSON 对象");
  } else if (
    Object.entries(headers).some(([name, value]) =>
      !HTTP_HEADER_NAME.test(name)
      || typeof value !== "string"
      || /[\r\n]/u.test(value)
    )
  ) {
    errors.set("headers", "请求头名称必须合法，且每个值必须是不含换行的字符串");
  }

  const samplingParams = agent["samplingParams"];
  if (!isJsonObject(samplingParams)) {
    errors.set("samplingParams", "samplingParams 必须是 JSON 对象");
  } else if (Object.hasOwn(samplingParams, "temperature")) {
    errors.set(
      "samplingParams",
      "请删除 temperature；模型服务将使用默认温度",
    );
  }
  return errors;
}

function imageRecognitionValidationErrors(
  imageRecognition: JsonObject | undefined,
): ReadonlyMap<string, string> {
  if (
    imageRecognition === undefined ||
    imageRecognition["enable"] !== true ||
    mainAgentSupportsVision()
  ) {
    return new Map();
  }
  const candidate = cloneJsonObject(imageRecognition);
  candidate["mode"] = "llm";
  candidate["input"] = ["text", "image"];
  candidate["tools"] = false;
  const errors = new Map(agentValidationErrors(candidate));
  errors.delete("mode");
  errors.delete("input");
  errors.delete("tools");

  const provider =
    typeof candidate["provider"] === "string" ? candidate["provider"] : "";
  const model = typeof candidate["model"] === "string" ? candidate["model"] : "";
  const selected = agentCatalog === undefined
    ? undefined
    : agentCatalogModel(agentCatalog, provider, model);
  if (
    !agentProviderAcceptsCustomModels(provider) &&
    selected !== undefined &&
    !modelSupportsVision(selected)
  ) {
    errors.set("model", "专用视觉模型必须支持 image 输入");
  }
  if (
    typeof imageRecognition["prompt"] !== "string" ||
    imageRecognition["prompt"].trim() === ""
  ) {
    errors.set("prompt", "图片转述指令不能为空");
  }
  return errors;
}

function applyAgentLocalValidation(): void {
  const agent = currentAgentConfig();
  const agentErrors = agent === undefined
    ? new Map<string, string>()
    : agentValidationErrors(agent);
  const imageErrors = imageRecognitionValidationErrors(
    currentImageRecognitionConfig(),
  );
  for (const view of fieldViews) {
    if (
      view.path.length !== 2 ||
      (view.path[0] !== "agent" && view.path[0] !== "image_recognition")
    ) {
      continue;
    }
    if (view.errorSource === "parse" || view.errorSource === "server") continue;
    const errors = view.path[0] === "agent" ? agentErrors : imageErrors;
    const message = errors.get(view.path[1] as string);

    if (message === undefined) {
      clearFieldError(view, "local");
    } else {
      setFieldError(view, message, "local");
    }
  }
}
function applyScheduleLocalValidation(): void {
  for (const view of fieldViews) {
    if (view.path[0] === "schedule") clearFieldError(view, "local");
  }
  if (draftConfig === undefined) return;
  try {
    parseScheduleConfig(draftConfig["schedule"]);
  } catch (error) {
    if (!(error instanceof ScheduleConfigurationError)) return;
    const target = fieldViews.find(({ path }) => samePath(path, error.path))
      ?? fieldViews.find(({ path }) =>
        path.length === 3
        && path[0] === "schedule"
        && path[1] === error.path[1]
        && path[2] === "enable"
      );
    if (target !== undefined && target.errorSource !== "parse" && target.errorSource !== "server") {
      setFieldError(target, error.message, "local");
    }
  }
}

function applyIdleLocalValidation(): void {
  for (const view of fieldViews) {
    if (view.path[0] === "idle_time_task") clearFieldError(view, "local");
  }
  if (draftConfig === undefined) return;
  try {
    validateIdleConfig(draftConfig["idle_time_task"]);
  } catch (error) {
    if (!(error instanceof IdleConfigurationError)) return;
    const path = error.path.map(String);
    const target = fieldViews.find(({ path: candidate }) => samePath(candidate, path))
      ?? fieldViews.find(({ path: candidate }) =>
        candidate[0] === "idle_time_task" && candidate[1] === path[1] && candidate[2] === "enable"
      );
    if (target !== undefined && target.errorSource !== "parse" && target.errorSource !== "server") {
      setFieldError(target, error.message, "local");
    }
  }
}

function applySearchLocalValidation(): void {
  const search = draftConfig?.["search_online"];
  if (!isJsonObject(search)) return;
  const errors = new Map<string, string>();
  const key = search["api_key"];
  if (search["enable"] === true) {
    if (typeof key !== "string" || key.trim() === "") {
      errors.set("api_key", "启用联网搜索必须填写所选服务商的 API Key");
    } else if (/[\r\n]/u.test(key)) {

      errors.set("api_key", "API Key 不得包含换行符");
    }
    const count = search["count"];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 20) {
      errors.set("count", "请输入 1–20 的整数");
    }
  }
  const previous = loadedConfig?.["search_online"];
  if (isJsonObject(previous) && key === REDACTED_API_KEY &&
    (search["provider"] !== previous["provider"] || search["endpoint"] !== previous["endpoint"])) {
    errors.set("api_key", "服务商或接口地址已更改，必须重新输入 API Key");
  }
  for (const view of fieldViews) {
    if (view.path[0] !== "search_online" || view.path.length !== 2 ||
      view.errorSource === "parse" || view.errorSource === "server") continue;
    const message = errors.get(view.path[1]!);
    if (message === undefined) clearFieldError(view, "local");
    else setFieldError(view, message, "local");
  }
}
function applyPlatformLocalValidation(): void {
  const platform = draftConfig?.["platform"];
  for (const view of fieldViews) {
    if (view.path.length !== 1 || view.path[0] !== "platform" ||
      view.errorSource === "parse" || view.errorSource === "server") continue;
    if (typeof platform === "string" && isPlatformAvailable(platform)) {
      clearFieldError(view, "local");
    } else {
      setFieldError(view, "当前平台待完善或未识别；请改选哔哩哔哩或本地 talk 后保存。", "local");
    }
  }
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function scheduleIdForPath(path: readonly string[]): string | undefined {
  if (path.length < 2 || path[0] !== "schedule" || draftConfig === undefined) return undefined;
  const schedule = draftConfig["schedule"];
  const index = Number(path[1]);
  if (!Array.isArray(schedule) || !Number.isSafeInteger(index) || index < 0) return undefined;
  const task = schedule[index];
  return isJsonObject(task) && typeof task["id"] === "string" ? task["id"] : undefined;
}

function captureUnparsedFieldStates(): readonly PreservedFieldState[] {
  return fieldViews
    .filter(({ errorSource }) => errorSource === "parse")
    .map<PreservedFieldState>((view) => ({
      checked: view.control instanceof HTMLInputElement && view.control.type === "checkbox"
        ? view.control.checked
        : false,
      error: view.error.textContent,
      errorSource: "parse",
      path: [...view.path],
      scheduleId: scheduleIdForPath(view.path),
      value: view.control.value,
    }));
}

function restoreUnparsedFieldStates(states: readonly PreservedFieldState[]): void {
  for (const state of states) {
    let path = state.path;
    if (state.scheduleId !== undefined) {
      const schedule = draftConfig?.["schedule"];
      if (Array.isArray(schedule)) {
        const index = schedule.findIndex((task) =>
          isJsonObject(task) && task["id"] === state.scheduleId
        );
        if (index >= 0) path = ["schedule", String(index), ...state.path.slice(2)];
        else continue;
      }
    }
    const view = fieldViews.find(({ path: candidate }) => samePath(candidate, path));
    if (view === undefined) continue;
    view.control.value = state.value;
    if (view.control instanceof HTMLInputElement && view.control.type === "checkbox") {
      view.control.checked = state.checked;
    }
    setFieldError(view, state.error, state.errorSource);
  }
  updateSummary();
  updateAgentOverview();
}

function focusFieldView(view: FieldView | undefined): void {
  if (view === undefined) return;
  for (const section of sectionViews) {
    if (Array.from(section.container.querySelectorAll(".settings-field")).includes(view.container)) {
      section.container.open = true;
    }
  }
  for (const group of settingsTree.querySelectorAll<HTMLDetailsElement>(".settings-group")) {
    if (Array.from(group.querySelectorAll(".settings-field")).includes(view.container)) group.open = true;
  }
  view.container.scrollIntoView({ block: "nearest" });
  view.control.focus();
}

function replaceAgentAndRender(
  nextAgent: JsonObject,
  focusField: string,
): void {
  if (draftConfig === undefined) return;
  const preserved = captureUnparsedFieldStates();
  setJsonValueAtPath(draftConfig, ["agent"], nextAgent);
  renderConfig();
  restoreUnparsedFieldStates(preserved);
  focusFieldView(agentFieldView(focusField));
}

function replaceImageRecognitionAndRender(
  nextImageRecognition: JsonObject,
  focusField: string,
): void {
  if (draftConfig === undefined) return;
  const preserved = captureUnparsedFieldStates();
  setJsonValueAtPath(
    draftConfig,
    ["image_recognition"],
    nextImageRecognition,
  );
  renderConfig();
  restoreUnparsedFieldStates(preserved);
  focusFieldView(imageRecognitionFieldView(focusField));
}

function selectImageRecognitionModel(
  imageRecognition: JsonObject,
  catalog: AgentCatalog,
  field: "provider" | "model",
  selectedValue: string,
): JsonObject {
  const selected = cloneJsonObject(imageRecognition);
  if (field === "provider") {
    const provider = agentCatalogProvider(catalog, selectedValue);
    if (
      provider === undefined ||
      (!agentProviderAcceptsCustomModels(provider.id) &&
        !provider.models.some(modelSupportsVision))
    ) {
      throw new TypeError("所选 provider 没有可用的视觉模型");
    }
    selected["provider"] = provider.id;
    if (agentProviderAcceptsCustomModels(provider.id)) return selected;
    const currentModel =
      typeof selected["model"] === "string" ? selected["model"] : "";
    const model = provider.models.find(({ id, input }) =>
      id === currentModel && input.includes("image")
    ) ?? provider.models.find(modelSupportsVision);
    if (model === undefined) {
      throw new TypeError("所选 provider 没有可用的视觉模型");
    }
    selected["model"] = model.id;
    selected["maxTokens"] = model.maxTokens;
    selected["contextWindow"] = model.contextWindow;
    selected["reasoning"] = model.reasoning;
    return selected;
  }

  const providerId =
    typeof selected["provider"] === "string" ? selected["provider"] : "";
  const model = agentCatalogModel(catalog, providerId, selectedValue);
  if (model === undefined || !modelSupportsVision(model)) {
    throw new TypeError("请选择支持 image 输入的视觉模型");
  }
  selected["model"] = model.id;
  selected["maxTokens"] = model.maxTokens;
  selected["contextWindow"] = model.contextWindow;
  selected["reasoning"] = model.reasoning;
  return selected;
}

function updateField(view: FieldView): boolean {
  if (
    view.readOnly
    || pendingPlatformForPath(view.path) !== undefined
    || draftConfig === undefined
  ) return false;
  let valid = false;
  try {
    const value = parseControl(view);
    setJsonValueAtPath(draftConfig, view.path, cloneJsonValue(value));
    clearFieldError(view);
    valid = true;
  } catch (error) {
    setFieldError(view, describeError(error), "parse");
  }
  applyPlatformLocalValidation();
  applyAgentLocalValidation();
  applyScheduleLocalValidation();
  applyIdleLocalValidation();
  applySearchLocalValidation();
  updateSummary();
  updateAgentOverview();
  return valid;
}

function handleFieldEdit(view: FieldView): void {
  if (view.path[0] === "schedule" && view.path[2] === "interval" && view.path[3] === "mode") {
    rerenderSchedule(() => {
      const current = scheduleDraft()[Number(view.path[1])] as JsonObject;
      const previous = current["interval"] as JsonObject;
      const unit = previous["unit"] as JsonValue;
      current["interval"] = view.control.value === "fixed"
        ? { mode: "fixed", every: previous["min"] as JsonValue, unit }
        : { mode: "random", min: previous["every"] as JsonValue, max: previous["every"] as JsonValue, unit };
    }, view.path);
    return;
  }
  if (view.path[0] === "search_online" && view.path[1] === "provider" && draftConfig !== undefined) {
    const preserved = captureUnparsedFieldStates();
    if (!updateField(view)) return;
    for (const field of ["api_key", "endpoint", "model"]) {
      setJsonValueAtPath(draftConfig, ["search_online", field], "");
    }
    renderConfig();
    restoreUnparsedFieldStates(preserved);
    focusFieldView(fieldViews.find(({ path }) => path[0] === "search_online" && path[1] === "api_key"));
    return;
  }
  const catalog = agentCatalog;
  const agent = currentAgentConfig();
  const provider = agent?.["provider"];
  const agentCatalogSelection = view.path.length === 2
    && view.path[0] === "agent"
    && (
      view.path[1] === "provider"
      || (
        view.path[1] === "model"
        && typeof provider === "string"
        && !agentProviderAcceptsCustomModels(provider)
      )
    );
  if (agentCatalogSelection && catalog !== undefined && agent !== undefined) {
    try {
      const selectedValue = parseControl(view);
      if (typeof selectedValue !== "string") {
        throw new TypeError("模型目录选项必须是字符串");
      }
      const selected = view.path[1] === "provider"
        ? selectAgentProvider(agent, catalog, selectedValue)
        : selectAgentModel(agent, catalog, selectedValue);
      replaceAgentAndRender(selected, view.path[1] as "provider" | "model");
    } catch (error) {
      setFieldError(view, describeError(error), "local");
      refreshFieldState(view);
      updateSummary();
      updateAgentOverview();
    }
    return;
  }

  const imageRecognition = currentImageRecognitionConfig();
  const imageProvider = imageRecognition?.["provider"];
  const imageCatalogSelection = view.path.length === 2
    && view.path[0] === "image_recognition"
    && (
      view.path[1] === "provider" ||
      (
        view.path[1] === "model" &&
        typeof imageProvider === "string" &&
        !agentProviderAcceptsCustomModels(imageProvider)
      )
    );
  if (
    imageCatalogSelection &&
    catalog !== undefined &&
    imageRecognition !== undefined
  ) {
    try {
      const selectedValue = parseControl(view);
      if (typeof selectedValue !== "string") {
        throw new TypeError("视觉模型目录选项必须是字符串");
      }
      const field = view.path[1] as "provider" | "model";
      const selected = selectImageRecognitionModel(
        imageRecognition,
        catalog,
        field,
        selectedValue,
      );
      replaceImageRecognitionAndRender(selected, field);
    } catch (error) {
      setFieldError(view, describeError(error), "local");
      refreshFieldState(view);
      updateSummary();
      updateAgentOverview();
    }
    return;
  }

  if (!updateField(view)) return;
  const rerenderForVisionRouting =
    view.path.length === 2 &&
    (
      (view.path[0] === "agent" && view.path[1] === "input") ||
      (view.path[0] === "image_recognition" && view.path[1] === "enable")
    );
  if (rerenderForVisionRouting) {
    const preserved = captureUnparsedFieldStates();
    renderConfig();
    restoreUnparsedFieldStates(preserved);
    focusFieldView(fieldViews.find((candidate) => samePath(candidate.path, view.path)));
  } else if (
    view.path.length === 2 &&
    view.path[0] === "agent" &&
    view.path[1] === "mode"
  ) {
    for (const field of fieldViews) applyReadOnly(field);
  }
  updateAgentOverview();
}

function refreshFieldState(view: FieldView): void {
  const dirty = loadedConfig !== undefined
    && draftConfig !== undefined
    && isSettingsPathDirty(loadedConfig, draftConfig, view.path);
  const invalid = view.error.textContent !== "";
  const agentInactive = isAgentLlmParameterPath(view.path)
    && !agentParametersActive();
  const featureInactive = imageRecognitionFieldInactive(view.path);
  view.container.dataset.agentInactive = String(agentInactive);
  view.container.dataset.featureInactive = String(featureInactive);
  view.container.dataset.dirty = String(dirty || invalid);
}


function invalidField(): FieldView | undefined {
  return fieldViews.find((view) => view.error.textContent !== "");
}

function dirtyFieldCount(): number {
  const loaded = loadedConfig;
  const draft = draftConfig;
  if (loaded === undefined || draft === undefined) return 0;
  return fieldViews.reduce(
    (count, view) => count + (view.path[0] !== "schedule" && isSettingsPathDirty(loaded, draft, view.path) ? 1 : 0),
    isSettingsPathDirty(loaded, draft, ["schedule"]) ? 1 : 0,
  );
}

function pendingFieldCount(): number {
  const loaded = loadedConfig;
  const draft = draftConfig;
  if (loaded === undefined || draft === undefined) return 0;
  return fieldViews.reduce((count, view) => {
    if (view.path[0] === "schedule") return count;
    const pending = view.error.textContent !== ""
      || isSettingsPathDirty(loaded, draft, view.path);
    return count + (pending ? 1 : 0);
  }, isSettingsPathDirty(loaded, draft, ["schedule"]) || fieldViews.some(view =>
    view.path[0] === "schedule" && view.error.textContent !== ""
  ) ? 1 : 0);
}

function updateSummary(): void {
  const fieldCount = pendingFieldCount();
  const count = fieldCount + (agentMaterializationPending ? 1 : 0);
  dirtyCount.textContent = agentMaterializationPending
    ? fieldCount === 0
      ? "Pi Agent 待写入"
      : `Pi Agent 待写入 · ${fieldCount.toLocaleString("zh-CN")} 项待处理`
    : `${fieldCount.toLocaleString("zh-CN")} 项待处理`;
  dirtyCount.dataset.dirty = String(count > 0);
  revisionLabel.textContent = revisionConflicted
    ? "修订：版本冲突，需重新载入"
    : loadedRevision === undefined
      ? "修订：尚未载入"
      : `修订：${loadedRevision}`;
  for (const view of fieldViews) refreshFieldState(view);
  const tasks = draftConfig?.["schedule"];
  if (Array.isArray(tasks)) {
    for (const card of settingsTree.querySelectorAll<HTMLElement>(".schedule-card")) {
      const task = tasks.find(task => isJsonObject(task) && task["id"] === card.dataset.scheduleId);
      if (!isJsonObject(task) || !isJsonObject(task["interval"])) continue;
      const title = card.querySelector("header > strong");
      const summary = card.querySelector("header > small");
      const interval = task["interval"];
      const unit = SCHEDULE_INTERVAL_UNITS[interval["unit"] as keyof typeof SCHEDULE_INTERVAL_UNITS].label;
      const frequency = interval["mode"] === "fixed"
        ? `每 ${interval["every"]} ${unit}`
        : `每 ${interval["min"]}–${interval["max"]} ${unit} 随机`;
      if (title !== null) title.textContent = String(task["name"] || "未命名定时任务");
      if (summary !== null) summary.textContent = `${task["enable"] ? agentParametersActive() ? "已启用" : "已启用 · 等待 LLM 模式" : "已停用"} · ${frequency} · ${task["run_on_start"] ? "启动或重载时立即执行" : "首次等待间隔"}`;
    }
  }
  const scheduleNotice = settingsTree.querySelector("[data-schedule-mode-notice]");
  if (scheduleNotice !== null) {
    scheduleNotice.textContent = agentParametersActive()
      ? "定时提示通过 system-notice 注入 LLM 上下文，仅播报模型回复，不直接朗读提示词。同一任务共享历次触发的上下文，不同任务相互独立。"
      : "主模式不是 LLM，定时任务目前暂停；配置仍可编辑，切回 LLM 后执行。提示词通过 system-notice 交给模型，不会直接复读。";
  }
  resetButton.disabled = busy || fieldCount === 0;
  saveButton.disabled = busy || loadedRevision === undefined || draftConfig === undefined || count === 0;
}

function applyReadOnly(view: FieldView): void {
  const agentInactive = isAgentLlmParameterPath(view.path)
    && !agentParametersActive();
  const featureInactive = imageRecognitionFieldInactive(view.path);
  const pendingPlatform = pendingPlatformForPath(view.path) !== undefined;
  const inactive = agentInactive || featureInactive || pendingPlatform;
  view.container.dataset.agentInactive = String(agentInactive);
  view.container.dataset.featureInactive = String(featureInactive);
  view.container.dataset.platformPending = String(pendingPlatform);
  if (
    view.control instanceof HTMLSelectElement
    || (view.control instanceof HTMLInputElement && view.control.type === "checkbox")
  ) {
    view.control.disabled = busy || view.readOnly || inactive;
  } else {
    view.control.disabled = busy || inactive;
    view.control.readOnly = view.readOnly;
    view.control.setAttribute("aria-readonly", String(view.readOnly));
  }
}

function setBusy(next: boolean): void {
  busy = next;
  connectButton.disabled = next;
  reloadButton.disabled = next;
  expandButton.disabled = next || draftConfig === undefined;
  collapseButton.disabled = next || draftConfig === undefined;
  for (const view of fieldViews) applyReadOnly(view);
  for (const control of settingsTree.querySelectorAll<HTMLButtonElement>("[data-schedule-mutation-path]")) {
    const path = control.dataset.scheduleMutationPath!.split(".");
    control.disabled = next || isUiReadOnlySettingsPath(path)
      || readOnlyPaths.some(protectedPath => path.every((segment, index) => protectedPath[index] === segment));
  }
  updateSummary();
}


async function loadConfig(options: { readonly silent?: boolean; readonly discardDirty?: boolean } = {}): Promise<void> {
  if (!options.discardDirty && pendingFieldCount() > 0 && !window.confirm("重新载入会丢弃尚未保存的更改，是否继续？")) {
    return;
  }
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  setBusy(true);
  setConnection("loading", "正在连接", "读取配置并同步模型与 Edge TTS 语音目录");
  try {
    const configPayload = await responseJson(
      await apiFetch("/api/config", { signal: controller.signal }),
    );
    if (loadController !== controller) return;
    const parsed = parseConfigPayload(configPayload);
    const edgeVoiceCatalogPromise = isJsonObject(parsed.config["edge-tts"])
      ? fetchEdgeVoiceCatalog(controller.signal)
      : Promise.resolve<EdgeVoiceCatalogResult>({ voices: [] });
    const [catalogPayload, voiceCatalog] = await Promise.all([
      apiFetch("/api/agent/catalog", { signal: controller.signal })
        .then((response) => responseJson(response)),
      edgeVoiceCatalogPromise,
    ]);
    if (loadController !== controller) return;
    const parsedCatalog = parseAgentCatalog(catalogPayload);
    const materialized = materializeSettingsAgent(parsed.config, parsedCatalog);
    agentCatalog = parsedCatalog;
    agentMaterializationPending = materialized.agentSynthesized;
    agentCatalogAuthoritative = true;
    agentCatalogRefreshError = undefined;
    agentSaveError = undefined;
    edgeVoices = voiceCatalog.voices;
    edgeVoiceCatalogError = voiceCatalog.error;
    loadedConfig = cloneJsonObject(materialized.config);
    draftConfig = cloneJsonObject(materialized.config);
    loadedRevision = parsed.revision;
    readOnlyPaths = parsed.protectedPaths;
    revisionConflicted = false;
    renderConfig();
    const edgeStatus = voiceCatalog.error === undefined
      ? `${voiceCatalog.voices.length.toLocaleString("zh-CN")} 个 Edge TTS 语音`
      : "Edge TTS 语音目录待重试";
    setConnection(
      "ready",
      "已连接",
      `配置修订 ${parsed.revision} · ${parsedCatalog.providers.length.toLocaleString("zh-CN")} 个 provider · ${edgeStatus}`,
    );
    if (!options.silent) {
      showAnnouncement(
        voiceCatalog.error === undefined
          ? "已载入配置，并同步 Pi 模型与 Edge TTS 语音目录。"
          : `配置已载入，但 Edge TTS 语音目录同步失败：${voiceCatalog.error}。`,
        voiceCatalog.error === undefined ? "success" : "warning",
      );
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    setConnection("error", "连接失败", describeError(error));
    if (!options.silent) showAnnouncement(describeError(error), "error");
    throw error;
  } finally {
    if (loadController === controller) {
      loadController = undefined;
      setBusy(false);
    }
  }
}

function fieldForAgentServerError(message: string): FieldView | undefined {
  if (/凭据|credential|api[\s_-]*key|authorization/iu.test(message)) {
    const credential = agentFieldView("apiKey");
    if (credential !== undefined) return credential;
  }
  for (const match of message.matchAll(/\bagent\.([A-Za-z][\w]*)/gu)) {
    const field = match[1];
    if (field === undefined) continue;
    const view = agentFieldView(field);
    if (view !== undefined) return view;
  }
  return fieldViews.find(({ path }) =>
    path.length === 2
    && path[0] === "agent"
    && message.toLocaleLowerCase("en-US").includes(path[1]!.toLocaleLowerCase("en-US"))
  );
}

async function saveConfig(): Promise<void> {
  if (busy) return;
  const config = draftConfig;
  const revision = loadedRevision;
  if (config === undefined || revision === undefined) {
    showAnnouncement("请先重新载入配置以获取当前修订版本。", "error");
    return;
  }
  applyPlatformLocalValidation();
  applyAgentLocalValidation();
  applyScheduleLocalValidation();
  applyIdleLocalValidation();
  applySearchLocalValidation();
  updateSummary();
  updateAgentOverview();
  const invalid = invalidField();
  if (invalid !== undefined) {
    showAnnouncement("请先修正标记为错误的字段。", "error");
    focusFieldView(invalid);
    return;
  }
  if (dirtyFieldCount() === 0 && !agentMaterializationPending) {
    showAnnouncement("当前没有需要保存的更改。", "warning");
    return;
  }
  const catalog = agentCatalog;
  if (catalog === undefined) {
    showAnnouncement("Pi 模型目录尚未载入，请重新载入配置。", "error");
    return;
  }

  setBusy(true);
  try {
    const payload = await responseJson(await apiFetch("/api/config", {
      method: "PUT",
      headers: { "If-Match": `"${revision}"` },
      body: JSON.stringify(config),
    }));
    const parsed = parseConfigPayload(payload);
    const materialized = materializeSettingsAgent(parsed.config, catalog);
    agentMaterializationPending = materialized.agentSynthesized;
    agentCatalogAuthoritative = false;
    agentCatalogRefreshError = undefined;
    agentSaveError = undefined;
    loadedConfig = cloneJsonObject(materialized.config);
    draftConfig = cloneJsonObject(materialized.config);
    loadedRevision = parsed.revision;
    readOnlyPaths = parsed.protectedPaths;
    revisionConflicted = false;
    renderConfig();
    setConnection("ready", "已保存", `配置修订 ${parsed.revision} · 正在刷新 Pi 模型目录`);

    try {
      const catalogPayload = await responseJson(await apiFetch("/api/agent/catalog"));
      agentCatalog = parseAgentCatalog(catalogPayload);
      agentCatalogAuthoritative = true;
      agentCatalogRefreshError = undefined;
      renderConfig();
      setConnection("ready", "已连接", `配置修订 ${parsed.revision} · Pi Agent 主配置`);
      showAnnouncement("完整配置已原子保存，并已刷新 Pi 模型目录。", "success");
    } catch (error) {
      agentCatalogAuthoritative = false;
      agentCatalogRefreshError = describeError(error);
      updateAgentOverview();
      setConnection("ready", "已保存", `配置修订 ${parsed.revision} · Pi 模型目录待刷新`);
      showAnnouncement(
        `配置已保存，但 Pi 模型目录刷新失败：${describeError(error)}。可重新载入以重试。`,
        "warning",
      );
    }
  } catch (error) {
    if (
      error instanceof ApiRequestError
      && error.status === 409
      && error.code === "operator_bind_restart_required"
    ) {
      showAnnouncement("服务绑定地址只能在本机配置后重启生效；当前草稿和修订版本已保留。", "error");
      return;
    }
    if (error instanceof ApiRequestError && (error.status === 409 || error.status === 412 || error.status === 428)) {
      loadedRevision = undefined;
      revisionConflicted = true;
      showAnnouncement("配置已被其他操作修改。当前编辑已保留，请重新载入后处理冲突。", "error");
      return;
    }
    if (error instanceof ApiRequestError && error.status === 422 && error.code === "invalid_search_config") {
      const target = fieldViews.find(({ path }) =>
        path[0] === "search_online" && path.length === 2 && error.message.includes(path[1]!)
      );
      if (target !== undefined) {
        setFieldError(target, error.message, "server");
        focusFieldView(target);
      }
      updateSummary();
      showAnnouncement(error.message, "error");
      return;
    }
    if (error instanceof ApiRequestError && error.status === 422 && error.code === "invalid_idle_config") {
      const target = error.detailsPath === undefined ? undefined
        : fieldViews.find(({ path }) => samePath(path, error.detailsPath!));
      if (target !== undefined) {
        setFieldError(target, error.message, "server");
        refreshFieldState(target);
        focusFieldView(target);
      }
      updateSummary();
      showAnnouncement(error.message, "error");
      return;
    }
    if (
      error instanceof ApiRequestError
      && error.status === 422
      && error.code === "invalid_schedule_config"
    ) {
      const path = error.detailsPath;
      const target = path === undefined ? undefined
        : fieldViews.find(({ path: candidate }) => samePath(candidate, path))
          ?? fieldViews.find(({ path: candidate }) =>
            candidate.length === 3
            && candidate[0] === "schedule"
            && candidate[1] === path[1]
            && candidate[2] === "enable"
          );
      if (target !== undefined) {
        setFieldError(target, error.message, "server");
        refreshFieldState(target);
        focusFieldView(target);
      }
      updateSummary();
      showAnnouncement(error.message, "error");
      return;
    }
    if (
      error instanceof ApiRequestError
      && error.status === 422
      && error.code === "invalid_agent_config"
    ) {
      agentSaveError = error.message;
      const target = fieldForAgentServerError(error.message);
      if (target !== undefined) {
        setFieldError(target, error.message, "server");
        refreshFieldState(target);
      }
      updateSummary();
      updateAgentOverview();
      showAnnouncement("Agent 配置未通过服务端校验；详情已保留在模型运行状态区。", "error");
      focusFieldView(target);
      return;
    }
    showAnnouncement(describeError(error), "error");
  } finally {
    setBusy(false);
  }
}

function resetAll(): void {
  if (loadedConfig === undefined || pendingFieldCount() === 0) return;
  if (!window.confirm("确定撤销全部尚未保存的更改？")) return;
  draftConfig = cloneJsonObject(loadedConfig);
  agentSaveError = undefined;
  renderConfig();
  showAnnouncement("已撤销全部未保存更改。", "success");
}

function setAllSections(open: boolean): void {
  for (const details of settingsTree.querySelectorAll<HTMLDetailsElement>("details")) {
    details.open = open;
  }
}

function updateClock(): void {
  footerTime.textContent = new Date().toLocaleString("zh-CN", { hour12: false });
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  accessToken = tokenInput.value.trim();
  if (accessToken === "") sessionStorage.removeItem(SESSION_TOKEN_KEY);
  else sessionStorage.setItem(SESSION_TOKEN_KEY, accessToken);
  void loadConfig({ discardDirty: false }).catch(() => undefined);
});
settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveConfig();
});
reloadButton.addEventListener("click", () => {
  void loadConfig().catch(() => undefined);
});
resetButton.addEventListener("click", resetAll);
expandButton.addEventListener("click", () => setAllSections(true));
collapseButton.addEventListener("click", () => setAllSections(false));
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase("en-US") === "s") {
    event.preventDefault();
    if (event.repeat || saveButton.disabled) return;
    void saveConfig();
  }
});
window.addEventListener("beforeunload", (event) => {
  loadController?.abort();
  if (pendingFieldCount() > 0) {
    event.preventDefault();
  }
});

updateClock();
window.setInterval(updateClock, 30_000);
setBusy(false);
void loadConfig({ silent: true, discardDirty: true }).catch(() => undefined);
