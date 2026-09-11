const MAX_LOG_ENTRIES = 200;
const MAX_CONTENT_LENGTH = 20_000;
const STATUS_POLL_MS = 5_000;
const MESSAGE_TIMEOUT_MS = 6_000;
const STOP_CONFIRM_MS = 5_000;
const STREAM_RETRY_MAX_MS = 15_000;
const SESSION_TOKEN_KEY = "ai-vtuber.operator-token";
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;

type JsonRecord = Record<string, unknown>;
type Tone = "error" | "success" | "warning";
type DisplayState = "ready" | "loading" | "error";

class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

const authForm = element<HTMLFormElement>("auth-form");
const tokenInput = element<HTMLInputElement>("token-input");
const connectButton = element<HTMLButtonElement>("connect-button");
const connectionMark = element<HTMLElement>("connection-mark");
const connectionLabel = element<HTMLElement>("connection-label");
const connectionDetail = element<HTMLElement>("connection-detail");
const announcement = element<HTMLElement>("announcement");
const refreshStatusButton = element<HTMLButtonElement>("refresh-status");
const reloadRuntimeButton = element<HTMLButtonElement>("reload-runtime");
const stopRuntimeButton = element<HTMLButtonElement>("stop-runtime");
const manualForm = element<HTMLFormElement>("manual-form");
const eventType = element<HTMLSelectElement>("event-type");
const eventUsername = element<HTMLInputElement>("event-username");
const eventContent = element<HTMLTextAreaElement>("event-content");
const contentCount = element<HTMLElement>("content-count");
const sendEventButton = element<HTMLButtonElement>("send-event");
const manualResult = element<HTMLElement>("manual-result");
const eventLog = element<HTMLOListElement>("event-log");
const logEmpty = element<HTMLLIElement>("log-empty");
const logCount = element<HTMLElement>("log-count");
const pauseLogButton = element<HTMLButtonElement>("pause-log");
const clearLogButton = element<HTMLButtonElement>("clear-log");
const configEditor = element<HTMLTextAreaElement>("config-editor");
const configValidation = element<HTMLElement>("config-validation");
const configRevision = element<HTMLElement>("config-revision");
const loadConfigButton = element<HTMLButtonElement>("load-config");
const saveConfigButton = element<HTMLButtonElement>("save-config");
const footerTime = element<HTMLElement>("footer-time");
const avatarStage = element<HTMLElement>("avatar-stage");
const avatarPreview = element<HTMLIFrameElement>("avatar-preview");
const avatarPlaceholder = element<HTMLElement>("avatar-placeholder");
const avatarPreviewTitle = element<HTMLElement>("avatar-preview-title");
const avatarPreviewDetail = element<HTMLElement>("avatar-preview-detail");
const avatarModelName = element<HTMLElement>("avatar-model-name");
const avatarCameraStatus = element<HTMLElement>("avatar-camera-status");
const avatarCameraState = element<HTMLElement>("avatar-camera-state");
const avatarCameraDetail = element<HTMLElement>("avatar-camera-detail");
const startAvatarCameraButton = element<HTMLButtonElement>("start-avatar-camera");
const stopAvatarCameraButton = element<HTMLButtonElement>("stop-avatar-camera");
const avatarTalkForm = element<HTMLFormElement>("avatar-talk-form");
const avatarTalkContent = element<HTMLTextAreaElement>("avatar-talk-content");
const avatarTalkResult = element<HTMLElement>("avatar-talk-result");
const sendAvatarTalkButton = element<HTMLButtonElement>("send-avatar-talk");

const stateElements = {
  runtime: {
    dot: element<HTMLElement>("runtime-dot"),
    label: element<HTMLElement>("runtime-state"),
  },
  agent: {
    dot: element<HTMLElement>("agent-dot"),
    label: element<HTMLElement>("agent-state"),
  },
  speech: {
    dot: element<HTMLElement>("speech-dot"),
    label: element<HTMLElement>("speech-state"),
  },
  stream: {
    dot: element<HTMLElement>("stream-dot"),
    label: element<HTMLElement>("stream-state"),
  },
};

const eventQueue = element<HTMLElement>("event-queue");
const speechQueue = element<HTMLElement>("speech-queue");
const playbackQueue = element<HTMLElement>("playback-queue");

let accessToken = sessionStorage.getItem(SESSION_TOKEN_KEY) ?? "";
let announcementTimer: number | undefined;
let statusPollTimer: number | undefined;
let statusRefreshController: AbortController | undefined;
let stopConfirmTimer: number | undefined;
let configValidationTimer: number | undefined;
let avatarRefreshController: AbortController | undefined;
let avatarCameraBusy = false;
let avatarEnabled = false;
let avatarCameraStateValue = "stopped";
let loadedConfigRevision: number | undefined;
let streamController: AbortController | undefined;
let streamGeneration = 0;
let streamRetryMs = 1_000;
let lastEventId: string | undefined;
let logPaused = false;
let renderedLogCount = 0;
const pausedEvents: unknown[] = [];

tokenInput.value = accessToken;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Missing required element #${id}`);
  }
  return found as T;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  if (typeof value === "boolean") {
    return value ? "running" : "stopped";
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function eventTimestamp(value: unknown): number {
  const timestamp = numberValue(value);
  if (timestamp === undefined) {
    return Date.now();
  }
  return Math.max(-MAX_DATE_TIMESTAMP, Math.min(MAX_DATE_TIMESTAMP, timestamp));
}

function revisionFromPayload(payload: unknown): number | undefined {
  const revision = numberValue(valueAt(payload, "revision"));
  return revision !== undefined && Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : undefined;
}

function stateTone(value: string | undefined): DisplayState {
  if (value === undefined) {
    return "loading";
  }
  const normalized = value.toLowerCase();
  if (["ready", "running", "idle", "active", "connected", "ok"].includes(normalized)) {
    return "ready";
  }
  if (["error", "failed", "degraded", "offline"].includes(normalized)) {
    return "error";
  }
  return "loading";
}

function stateLabel(value: string | undefined, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  const labels: Record<string, string> = {
    active: "工作中",
    connected: "已连接",
    degraded: "降级",
    error: "错误",
    failed: "失败",
    idle: "空闲",
    offline: "离线",
    ready: "就绪",
    running: "运行中",
    starting: "启动中",
    stopped: "已停止",
    stopping: "停止中",
  };
  return labels[value.toLowerCase()] ?? value;
}

function updateState(
  target: { dot: HTMLElement; label: HTMLElement },
  value: string | undefined,
  fallback: string,
): void {
  target.dot.dataset.state = stateTone(value);
  target.label.textContent = stateLabel(value, fallback);
}

function authHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("Accept", "application/json");
  if (accessToken !== "") {
    result.set("Authorization", `Bearer ${accessToken}`);
  }
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
    const code = stringValue(valueAt(payload, "error", "code"));
    const message = stringValue(valueAt(payload, "error", "message")) ?? `请求失败（${response.status}）`;
    throw new ApiRequestError(response.status, message, code);
  }
  return payload;
}

function showAnnouncement(message: string, tone: Tone = "warning"): void {
  if (announcementTimer !== undefined) {
    window.clearTimeout(announcementTimer);
  }
  announcement.textContent = message;
  announcement.dataset.tone = tone;
  announcement.hidden = false;
  announcementTimer = window.setTimeout(() => {
    announcement.hidden = true;
    announcementTimer = undefined;
  }, MESSAGE_TIMEOUT_MS);
}

function setConnection(state: DisplayState, label: string, detail: string): void {
  connectionMark.dataset.state = state;
  connectionLabel.textContent = label;
  connectionDetail.textContent = detail;
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) {
      return "认证失败，请检查访问令牌";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "发生未知错误";
}
function setAvatarPreview(state: DisplayState | "disabled", title: string, detail: string): void {
  avatarStage.dataset.state = state;
  avatarPreviewTitle.textContent = title;
  avatarPreviewDetail.textContent = detail;
  avatarPlaceholder.hidden = false;
  if (state !== "ready") {
    avatarPreview.hidden = true;
  }
}

function avatarPreviewUrl(value: unknown): string | undefined {
  const path = stringValue(value);
  if (path === undefined) {
    return undefined;
  }
  try {
    const url = new URL(path, window.location.origin);
    return url.origin === window.location.origin && url.pathname === "/avatar/Live2D/" && url.search === "" && url.hash === ""
      ? url.pathname
      : undefined;
  } catch {
    return undefined;
  }
}

function applyAvatarStatus(payload: unknown): void {
  const enabled = valueAt(payload, "enabled") === true;
  const modelName = stringValue(valueAt(payload, "modelName")) ?? "未选择模型";
  const previewUrl = avatarPreviewUrl(valueAt(payload, "previewUrl"));
  const camera = valueAt(payload, "camera");
  const cameraState = stringValue(valueAt(camera, "state")) ?? "stopped";
  const cameraError = stringValue(valueAt(camera, "error"));
  const deviceName = stringValue(valueAt(camera, "deviceName"));
  const width = numberValue(valueAt(camera, "width"));
  const height = numberValue(valueAt(camera, "height"));
  const fps = numberValue(valueAt(camera, "fps"));
  avatarEnabled = enabled;
  avatarCameraStateValue = cameraState;

  avatarModelName.textContent = enabled ? modelName : "未启用";
  if (!enabled) {
    avatarPreview.removeAttribute("src");
    setAvatarPreview("disabled", "Live2D 预览未启用", "请在设置中启用 Live2D 并选择模型。");
  } else if (previewUrl === undefined) {
    avatarPreview.removeAttribute("src");
    setAvatarPreview("error", "角色预览不可用", "服务未提供可用的同源 Live2D 预览地址。");
  } else if (avatarPreview.getAttribute("src") !== previewUrl) {
    setAvatarPreview("loading", "正在加载角色", "渲染器正在初始化；就绪后会显示模型。");
    avatarPreview.src = previewUrl;
  }

  const isCameraError = cameraState === "error" || cameraError !== undefined;
  avatarCameraStatus.dataset.state = isCameraError ? "error" : stateTone(cameraState);
  avatarCameraState.textContent = `虚拟摄像头${stateLabel(cameraState, "未知")}`;
  avatarCameraDetail.textContent = isCameraError
    ? cameraError ?? "OBS 未能连接或启动虚拟摄像头。"
    : `${deviceName ?? "OBS 虚拟摄像头"}${width !== undefined && height !== undefined ? ` · ${width}×${height}` : ""}${fps !== undefined ? ` · ${fps} fps` : ""}`;
  startAvatarCameraButton.disabled = avatarCameraBusy || !enabled || ["running", "starting", "stopping"].includes(cameraState);
  stopAvatarCameraButton.disabled = avatarCameraBusy || !enabled || !["running", "starting", "stopping", "error"].includes(cameraState);
}

async function refreshAvatarStatus(): Promise<void> {
  avatarRefreshController?.abort();
  const controller = new AbortController();
  avatarRefreshController = controller;
  try {
    const response = await apiFetch("/api/avatar", { signal: controller.signal });
    const payload = await responseJson(response);
    if (avatarRefreshController === controller) {
      applyAvatarStatus(payload);
    }
  } catch (error) {
    if (!controller.signal.aborted && avatarRefreshController === controller) {
      avatarPreview.removeAttribute("src");
      setAvatarPreview("error", "角色预览不可用", describeError(error));
      avatarCameraStatus.dataset.state = "error";
      avatarCameraState.textContent = "虚拟摄像头不可用";
      avatarCameraDetail.textContent = describeError(error);
      startAvatarCameraButton.disabled = avatarCameraBusy || !avatarEnabled || ["running", "starting", "stopping"].includes(avatarCameraStateValue);
      stopAvatarCameraButton.disabled = avatarCameraBusy || !avatarEnabled || !["running", "starting", "stopping", "error"].includes(avatarCameraStateValue);
    }
  } finally {
    if (avatarRefreshController === controller) {
      avatarRefreshController = undefined;
    }
  }
}

async function setAvatarCamera(action: "start" | "stop"): Promise<void> {
  if (avatarCameraBusy) {
    return;
  }
  avatarCameraBusy = true;
  startAvatarCameraButton.disabled = true;
  stopAvatarCameraButton.disabled = true;
  avatarCameraState.textContent = action === "start" ? "正在启动虚拟摄像头" : "正在停止虚拟摄像头";
  try {
    const response = await apiFetch("/api/avatar/camera", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    applyAvatarStatus(await responseJson(response));
  } catch (error) {
    avatarCameraStatus.dataset.state = "error";
    avatarCameraState.textContent = action === "start" ? "虚拟摄像头未启动" : "虚拟摄像头未停止";
    avatarCameraDetail.textContent = describeError(error);
    showAnnouncement(describeError(error), "error");
  } finally {
    avatarCameraBusy = false;
    void refreshAvatarStatus();
  }
}

async function sendAvatarTalk(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (sendAvatarTalkButton.disabled) return;
  const content = avatarTalkContent.value.trim();
  if (content === "") {
    avatarTalkResult.textContent = "请输入要发送的内容";
    avatarTalkContent.focus();
    return;
  }
  sendAvatarTalkButton.disabled = true;
  avatarTalkResult.textContent = "处理中…";
  try {
    const response = await apiFetch("/api/events/manual", {
      method: "POST",
      body: JSON.stringify({ type: "talk", username: "操作员", content }),
    });
    const payload = await responseJson(response);
    const reply = stringValue(valueAt(payload, "reply", "text"));
    avatarTalkResult.textContent = reply === undefined
      ? "消息已处理，但未生成回复。请在配置中心启用 Pi Agent 对话或复读模式。"
      : `角色：${reply}`;
    if (avatarTalkContent.value.trim() === content) avatarTalkContent.value = "";
    void refreshStatus(true).catch(() => undefined);
  } catch (error) {
    avatarTalkResult.textContent = describeError(error);
  } finally {
    sendAvatarTalkButton.disabled = false;
  }
}


async function refreshStatus(silent = false): Promise<void> {
  statusRefreshController?.abort();
  const controller = new AbortController();
  statusRefreshController = controller;
  refreshStatusButton.disabled = true;
  try {
    const response = await apiFetch("/api/status", { signal: controller.signal });
    const status = await responseJson(response);
    if (statusRefreshController !== controller) {
      return;
    }
    await refreshAvatarStatus();
    applyStatus(status);
    setConnection("ready", "已连接", accessToken === "" ? "服务在线" : "服务在线 · 令牌已接受");
  } catch (error) {
    if (controller.signal.aborted || statusRefreshController !== controller) {
      return;
    }
    setConnection("error", "连接失败", describeError(error));
    markStatusOffline();
    if (!silent) {
      showAnnouncement(describeError(error), "error");
    }
    throw error;
  } finally {
    if (statusRefreshController === controller) {
      statusRefreshController = undefined;
      refreshStatusButton.disabled = false;
    }
  }
}

function applyStatus(status: unknown): void {
  const runtime = valueAt(status, "runtime");
  const runtimeState = stringValue(firstValue(
    valueAt(runtime, "state"),
    valueAt(runtime, "status"),
    valueAt(runtime, "lifecycle"),
    valueAt(runtime, "running"),
  ));
  const agentState = stringValue(firstValue(
    valueAt(runtime, "agent", "state"),
    valueAt(runtime, "agent", "status"),
    valueAt(runtime, "agentState"),
    runtimeState,
  ));
  const speechState = stringValue(firstValue(
    valueAt(status, "speech", "state"),
    valueAt(runtime, "speech", "state"),
  ));

  updateState(stateElements.runtime, runtimeState, "未知");
  updateState(stateElements.agent, agentState, "未知");
  updateState(stateElements.speech, speechState, "未知");

  const pendingEvents = numberValue(firstValue(
    valueAt(runtime, "queue", "pending"),
    valueAt(runtime, "queue", "queued"),
    valueAt(runtime, "eventQueue", "queued"),
    valueAt(runtime, "queued"),
  ));
  const queuedSpeech = numberValue(firstValue(
    valueAt(status, "speech", "queued"),
    valueAt(runtime, "speech", "queued"),
  ));
  const waitingPlayback = numberValue(firstValue(
    valueAt(status, "playback", "waitPlayAudio"),
    valueAt(runtime, "playback", "queued"),
  ));
  eventQueue.textContent = pendingEvents?.toLocaleString("zh-CN") ?? "—";
  speechQueue.textContent = queuedSpeech?.toLocaleString("zh-CN") ?? "—";
  playbackQueue.textContent = waitingPlayback?.toLocaleString("zh-CN") ?? "—";
}

function markStatusOffline(): void {
  updateState(stateElements.runtime, "offline", "不可用");
  updateState(stateElements.agent, "offline", "不可用");
  updateState(stateElements.speech, "offline", "不可用");
  eventQueue.textContent = "—";
  speechQueue.textContent = "—";
  playbackQueue.textContent = "—";
}

async function loadConfig(silent = false): Promise<void> {
  setConfigBusy(true);
  configValidation.textContent = "正在载入…";
  try {
    const response = await apiFetch("/api/config");
    const payload = await responseJson(response);
    const config = valueAt(payload, "config");
    const revision = revisionFromPayload(payload);
    if (!isRecord(config)) {
      throw new Error("配置响应缺少 config 对象");
    }
    if (revision === undefined) {
      throw new Error("配置响应缺少有效 revision");
    }
    configEditor.value = `${JSON.stringify(config, null, 2)}\n`;
    loadedConfigRevision = revision;
    configRevision.textContent = `修订 ${revision}`;
    validateConfigEditor();
  } catch (error) {
    configValidation.textContent = describeError(error);
    if (!silent) {
      showAnnouncement(describeError(error), "error");
    }
    throw error;
  } finally {
    setConfigBusy(false);
  }
}

function setConfigBusy(busy: boolean): void {
  loadConfigButton.disabled = busy;
  saveConfigButton.disabled = busy;
  configEditor.disabled = busy;
}

function parsedConfig(): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configEditor.value) as unknown;
  } catch (error) {
    const location = jsonErrorLocation(error, configEditor.value);
    throw new Error(`JSON 格式错误${location}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("配置根节点必须是 JSON 对象");
  }
  return parsed;
}

function validateConfigEditor(): boolean {
  try {
    parsedConfig();
    const lineCount = configEditor.value.split("\n").length;
    configValidation.textContent = `JSON 有效 · ${lineCount} 行`;
    return true;
  } catch (error) {
    configValidation.textContent = describeError(error);
    return false;
  }
}

function jsonErrorLocation(error: unknown, source: string): string {
  if (!(error instanceof Error)) {
    return "";
  }
  const match = error.message.match(/position\s+(\d+)/i);
  if (match === null) {
    return `：${error.message}`;
  }
  const position = Number(match[1]);
  const before = source.slice(0, position);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = position - lastNewline;
  return `（第 ${line} 行，第 ${column} 列）`;
}

async function saveConfig(): Promise<void> {
  const revision = loadedConfigRevision;
  if (revision === undefined) {
    const message = "请先重新载入配置以获取当前修订版本";
    configValidation.textContent = message;
    showAnnouncement(message, "error");
    return;
  }

  let config: JsonRecord;
  try {
    config = parsedConfig();
  } catch (error) {
    configValidation.textContent = describeError(error);
    showAnnouncement(describeError(error), "error");
    configEditor.focus();
    return;
  }

  setConfigBusy(true);
  configValidation.textContent = "正在原子保存…";
  try {
    const response = await apiFetch("/api/config", {
      method: "PUT",
      headers: { "If-Match": `"${revision}"` },
      body: JSON.stringify(config),
    });
    const payload = await responseJson(response);
    const saved = valueAt(payload, "config");
    const nextRevision = revisionFromPayload(payload);
    if (!isRecord(saved) || nextRevision === undefined) {
      loadedConfigRevision = undefined;
      configRevision.textContent = "修订未知 · 需重新载入";
      throw new Error("保存响应缺少有效 config 或 revision，请重新载入配置");
    }
    configEditor.value = `${JSON.stringify(saved, null, 2)}\n`;
    loadedConfigRevision = nextRevision;
    configRevision.textContent = `修订 ${nextRevision}`;
    validateConfigEditor();
    showAnnouncement("配置已原子保存并重新载入；运行模块可按需执行重新载入。", "success");
  } catch (error) {
    if (
      error instanceof ApiRequestError
      && error.status === 409
      && error.code === "operator_bind_restart_required"
    ) {
      const message = "服务绑定地址只能在本机配置后重启生效；当前编辑和修订版本已保留。";
      configValidation.textContent = message;
      showAnnouncement(message, "error");
      return;
    }
    const conflict = error instanceof ApiRequestError
      && (error.status === 409 || error.status === 412);
    const preconditionRequired = error instanceof ApiRequestError && error.status === 428;
    if (conflict || preconditionRequired) {
      loadedConfigRevision = undefined;
      const message = conflict
        ? "配置版本冲突。当前编辑内容已保留，请重新载入后再保存。"
        : "缺少当前配置版本。当前编辑内容已保留，请重新载入后再保存。";
      configRevision.textContent = conflict
        ? "版本冲突 · 需重新载入"
        : "修订未知 · 需重新载入";
      configValidation.textContent = message;
      showAnnouncement(message, "error");
      return;
    }
    configValidation.textContent = describeError(error);
    showAnnouncement(describeError(error), "error");
  } finally {
    setConfigBusy(false);
  }
}

async function sendManualEvent(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const content = eventContent.value.trim();
  if (content === "") {
    manualResult.textContent = "请输入事件内容";
    eventContent.focus();
    return;
  }

  sendEventButton.disabled = true;
  manualResult.textContent = "处理中…";
  try {
    const response = await apiFetch("/api/events/manual", {
      method: "POST",
      body: JSON.stringify({
        type: eventType.value,
        username: eventUsername.value.trim() || "操作员",
        content,
        platform: "operator",
      }),
    });
    const payload = await responseJson(response);
    const processed = valueAt(payload, "processed") === true;
    const reply = stringValue(valueAt(payload, "reply", "text"));
    manualResult.textContent = processed
      ? reply === undefined ? "处理完成" : `回复：${truncate(reply, 80)}`
      : "已接收，事件未生成回复";
    eventContent.value = "";
    updateContentCount();
    showAnnouncement(processed ? "手动事件处理完成。" : "手动事件已接收。", "success");
    void refreshStatus(true).catch(() => undefined);
  } catch (error) {
    manualResult.textContent = describeError(error);
    showAnnouncement(describeError(error), "error");
  } finally {
    sendEventButton.disabled = false;
  }
}

async function requestRuntimeReload(): Promise<void> {
  reloadRuntimeButton.disabled = true;
  try {
    const response = await apiFetch("/api/actions", {
      method: "POST",
      body: JSON.stringify({ action: "reload" }),
    });
    await responseJson(response);
    showAnnouncement("运行时已重新载入。", "success");
    await refreshStatus(true);
  } catch (error) {
    showAnnouncement(describeError(error), "error");
  } finally {
    reloadRuntimeButton.disabled = false;
  }
}

function resetStopConfirmation(): void {
  if (stopConfirmTimer !== undefined) {
    window.clearTimeout(stopConfirmTimer);
    stopConfirmTimer = undefined;
  }
  stopRuntimeButton.dataset.confirm = "false";
  stopRuntimeButton.textContent = "停止运行";
}

async function requestRuntimeStop(): Promise<void> {
  if (stopRuntimeButton.dataset.confirm !== "true") {
    stopRuntimeButton.dataset.confirm = "true";
    stopRuntimeButton.textContent = "再次点击确认停止";
    stopConfirmTimer = window.setTimeout(resetStopConfirmation, STOP_CONFIRM_MS);
    return;
  }

  resetStopConfirmation();
  stopRuntimeButton.disabled = true;
  try {
    const response = await apiFetch("/api/actions", {
      method: "POST",
      body: JSON.stringify({ action: "stop" }),
    });
    await responseJson(response);
    showAnnouncement("停止请求已提交，值守台会继续报告执行结果。", "success");
  } catch (error) {
    showAnnouncement(describeError(error), "error");
  } finally {
    stopRuntimeButton.disabled = false;
  }
}

function updateContentCount(): void {
  contentCount.textContent = `${eventContent.value.length} / ${MAX_CONTENT_LENGTH}`;
}

function clearLog(): void {
  eventLog.replaceChildren(logEmpty);
  logEmpty.hidden = false;
  pausedEvents.length = 0;
  renderedLogCount = 0;
  updateLogCount();
}

function toggleLogPause(): void {
  logPaused = !logPaused;
  pauseLogButton.textContent = logPaused ? "继续" : "暂停";
  pauseLogButton.setAttribute("aria-pressed", String(logPaused));
  if (!logPaused) {
    const queued = pausedEvents.splice(0);
    for (const event of queued) {
      appendLogEvent(event);
    }
  }
}

function receiveEvent(event: unknown): void {
  if (logPaused) {
    pausedEvents.push(event);
    if (pausedEvents.length > MAX_LOG_ENTRIES) {
      pausedEvents.shift();
    }
    updateLogCount();
    return;
  }
  appendLogEvent(event);
}

function appendLogEvent(event: unknown): void {
  logEmpty.hidden = true;
  const summary = summarizeEvent(event);
  const entry = document.createElement("li");
  entry.className = "log-entry";
  entry.dataset.tone = summary.tone;

  const time = document.createElement("time");
  time.className = "log-time";
  time.dateTime = new Date(summary.timestamp).toISOString();
  time.textContent = new Date(summary.timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
  });

  const kind = document.createElement("span");
  kind.className = "log-kind";
  kind.textContent = summary.kind;

  const message = document.createElement("span");
  message.className = "log-message";
  message.textContent = summary.message;

  entry.append(time, kind, message);
  eventLog.append(entry);
  renderedLogCount += 1;
  while (renderedLogCount > MAX_LOG_ENTRIES) {
    const first = eventLog.querySelector<HTMLElement>(".log-entry");
    if (first === null) {
      break;
    }
    first.remove();
    renderedLogCount -= 1;
  }
  eventLog.scrollTop = eventLog.scrollHeight;
  updateLogCount();
}

function summarizeEvent(event: unknown): {
  kind: string;
  message: string;
  timestamp: number;
  tone: Tone;
} {
  const type = stringValue(valueAt(event, "type")) ?? "event";
  const timestamp = eventTimestamp(valueAt(event, "timestamp"));
  let message: string;
  let tone: Tone = "warning";

  if (type === "inbound") {
    const username = stringValue(valueAt(event, "event", "username")) ?? "匿名用户";
    const content = stringValue(valueAt(event, "event", "content")) ?? "（无内容）";
    message = `${username}：${content}`;
  } else if (type === "agent.delta") {
    message = stringValue(valueAt(event, "text")) ?? "智能体正在生成";
  } else if (type === "agent.completed") {
    message = stringValue(valueAt(event, "response", "text")) ?? "智能体回复完成";
    tone = "success";
  } else if (type === "agent.error" || type === "speech.error") {
    message = stringValue(valueAt(event, "error")) ?? "处理失败";
    tone = "error";
  } else if (type.startsWith("speech.")) {
    message = stringValue(valueAt(event, "request", "text")) ?? type;
    tone = type === "speech.completed" ? "success" : "warning";
  } else if (type === "system.status") {
    const component = stringValue(valueAt(event, "component")) ?? "system";
    const status = stringValue(valueAt(event, "status"))?.toLowerCase();
    message = `${component} · ${stringValue(valueAt(event, "message")) ?? stateLabel(status, "状态更新")}`;
    tone = status === "error" ? "error" : status === "degraded" ? "warning" : "success";
  } else {
    message = truncate(safeStringify(event), 300);
  }

  return { kind: type, message, timestamp, tone };
}

function updateLogCount(): void {
  const pending = logPaused && pausedEvents.length > 0 ? ` · 暂存 ${pausedEvents.length}` : "";
  logCount.textContent = `${renderedLogCount} / ${MAX_LOG_ENTRIES}${pending}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "无法序列化的事件";
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function startEventStream(): void {
  streamController?.abort();
  streamGeneration += 1;
  streamRetryMs = 1_000;
  void consumeEventStream(streamGeneration);
}

async function consumeEventStream(generation: number): Promise<void> {
  if (generation !== streamGeneration) {
    return;
  }
  const controller = new AbortController();
  streamController = controller;
  updateState(stateElements.stream, "starting", "连接中");

  try {
    const headers = authHeaders({ Accept: "text/event-stream" });
    if (lastEventId !== undefined) {
      headers.set("Last-Event-ID", lastEventId);
    }
    const response = await fetch("/api/events", {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      await responseJson(response);
    }
    if (response.body === null) {
      throw new Error("浏览器未提供事件流读取能力");
    }

    updateState(stateElements.stream, "connected", "已连接");
    streamRetryMs = 1_000;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (generation === streamGeneration) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleSseFrame(frame);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      updateState(stateElements.stream, "offline", describeError(error));
    }
  } finally {
    if (!controller.signal.aborted && generation === streamGeneration) {
      const delay = streamRetryMs;
      streamRetryMs = Math.min(streamRetryMs * 2, STREAM_RETRY_MAX_MS);
      window.setTimeout(() => {
        void consumeEventStream(generation);
      }, delay);
    }
  }
}

function handleSseFrame(frame: string): void {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) {
      lastEventId = line.slice(3).trim();
    } else if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (eventName === "connected") {
    updateState(stateElements.stream, "connected", "已连接");
    return;
  }
  if (eventName !== "app-event" || dataLines.length === 0) {
    return;
  }
  try {
    receiveEvent(JSON.parse(dataLines.join("\n")) as unknown);
  } catch {
    receiveEvent({
      type: "stream.error",
      error: "收到无法解析的实时事件",
      timestamp: Date.now(),
    });
  }
}

async function connectOperator(): Promise<void> {
  accessToken = tokenInput.value.trim();
  if (accessToken === "") {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } else {
    sessionStorage.setItem(SESSION_TOKEN_KEY, accessToken);
  }
  connectButton.disabled = true;
  setConnection("loading", "正在连接", "检查认证与运行状态");
  streamController?.abort();
  try {
    await refreshStatus();
    await loadConfig(true);
    startEventStream();
  } catch {
    updateState(stateElements.stream, "offline", "未连接");
  } finally {
    connectButton.disabled = false;
  }
}

function updateClock(): void {
  footerTime.textContent = new Date().toLocaleString("zh-CN", {
    hour12: false,
  });
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void connectOperator();
});
refreshStatusButton.addEventListener("click", () => {
  void refreshStatus().catch(() => undefined);
});
startAvatarCameraButton.addEventListener("click", () => {
  void setAvatarCamera("start");
});
stopAvatarCameraButton.addEventListener("click", () => {
  void setAvatarCamera("stop");
});
avatarTalkForm.addEventListener("submit", (event) => {
  void sendAvatarTalk(event);
});
avatarTalkContent.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!sendAvatarTalkButton.disabled) {
      avatarTalkForm.requestSubmit();
    }
  }
});
avatarPreview.addEventListener("error", () => {
  setAvatarPreview("error", "角色预览加载失败", "无法加载 Live2D 渲染器，请检查服务状态。");
});
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.source !== avatarPreview.contentWindow || !isRecord(event.data)) {
    return;
  }
  if (event.data.type === "live2d-ready") {
    avatarStage.dataset.state = "ready";
    avatarPlaceholder.hidden = true;
    avatarPreview.hidden = false;
  } else if (event.data.type === "live2d-error") {
    setAvatarPreview("error", "角色渲染失败", stringValue(valueAt(event.data, "detail", "message")) ?? "渲染器未提供错误详情。");
  }
});
loadConfigButton.addEventListener("click", () => {
  void loadConfig().catch(() => undefined);
});
saveConfigButton.addEventListener("click", () => {
  void saveConfig();
});
manualForm.addEventListener("submit", (event) => {
  void sendManualEvent(event);
});
eventContent.addEventListener("input", updateContentCount);
configEditor.addEventListener("input", () => {
  if (configValidationTimer !== undefined) {
    window.clearTimeout(configValidationTimer);
  }
  configValidationTimer = window.setTimeout(validateConfigEditor, 220);
});
configEditor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = configEditor.selectionStart;
    const end = configEditor.selectionEnd;
    configEditor.setRangeText("  ", start, end, "end");
    validateConfigEditor();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveConfig();
  }
});
reloadRuntimeButton.addEventListener("click", () => {
  void requestRuntimeReload();
});
stopRuntimeButton.addEventListener("click", () => {
  void requestRuntimeStop();
});
pauseLogButton.addEventListener("click", toggleLogPause);
clearLogButton.addEventListener("click", clearLog);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refreshStatus(true).catch(() => undefined);
  }
});
window.addEventListener("beforeunload", () => {
  statusRefreshController?.abort();
  avatarRefreshController?.abort();
  avatarRefreshController = undefined;
  statusRefreshController = undefined;
  streamGeneration += 1;
  streamController?.abort();
});

updateContentCount();
updateLogCount();
updateClock();
window.setInterval(updateClock, 30_000);
statusPollTimer = window.setInterval(() => {
  if (document.visibilityState === "visible") {
    void refreshStatus(true).catch(() => undefined);
  }
}, STATUS_POLL_MS);
void statusPollTimer;
void connectOperator();
