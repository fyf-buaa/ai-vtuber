export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type IdleConfigPathSegment = string | number;

export class IdleConfigurationError extends Error {
  readonly path: readonly IdleConfigPathSegment[];

  constructor(path: readonly IdleConfigPathSegment[], message: string) {
    super(`${path.join(".")}：${message}`);
    this.name = "IdleConfigurationError";
    this.path = path;
  }
}

const IDLE_TYPES: Record<string, true> = {
  "直播间无消息更新闲时": true,
  "待合成消息队列更新闲时": true,
  "待播放音频队列更新闲时": true,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fail(path: readonly IdleConfigPathSegment[], message: string): never {
  throw new IdleConfigurationError(path, message);
}

function enabledMode(
  value: unknown,
  path: readonly IdleConfigPathSegment[],
): boolean {
  if (value === undefined) return false;
  const mode = record(value);
  if (mode === undefined) fail(path, "必须是对象");
  if (mode.enable === undefined || mode.enable === false) return false;
  if (mode.enable !== true) fail([...path, "enable"], "必须是布尔值");
  if (mode.random !== undefined && typeof mode.random !== "boolean") {
    fail([...path, "random"], "必须是布尔值");
  }
  if (!Array.isArray(mode.copy)) fail([...path, "copy"], "启用时必须是提示列表");
  if (!mode.copy.some((item) => typeof item === "string" && item.trim() !== "")) {
    fail([...path, "copy"], "启用时至少需要一条非空提示");
  }
  return true;
}

function seconds(
  value: unknown,
  path: readonly IdleConfigPathSegment[],
  { allowZero = false }: { readonly allowZero?: boolean } = {},
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < (allowZero ? 0 : 0.001) ||
    !Number.isSafeInteger(Math.round(value * 1_000)) ||
    Math.round(value * 1_000) > MAX_TIMER_DELAY_MS
  ) {
    fail(path, `必须是${allowZero ? "非负" : "大于等于 0.001 的"}有限秒数，且不超过 ${MAX_TIMER_DELAY_MS} 毫秒`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: readonly IdleConfigPathSegment[]): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
    fail(path, "必须是非负安全整数");
  }
}

/** Validates the `idle_time_task` configuration object shared by API, UI, and runtime. */
export function validateIdleConfig(value: unknown): void {
  if (value === undefined) return;
  const config = record(value);
  if (config === undefined) fail(["idle_time_task"], "必须是对象");
  if (config.enable === undefined || config.enable === false) return;
  if (config.enable !== true) {
    fail(["idle_time_task", "enable"], "必须是布尔值");
  }

  const root: readonly IdleConfigPathSegment[] = ["idle_time_task"];
  if (config.type !== undefined && (typeof config.type !== "string" || IDLE_TYPES[config.type] !== true)) {
    fail([...root, "type"], "必须是支持的闲时任务类型");
  }
  const minimum = seconds(config.idle_time_min, [...root, "idle_time_min"]);
  const maximum = seconds(config.idle_time_max, [...root, "idle_time_max"]);
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    fail([...root, "idle_time_max"], "不得小于 idle_time_min");
  }
  const reduceTo = seconds(config.idle_time_reduce_to, [...root, "idle_time_reduce_to"], { allowZero: true });
  if (reduceTo !== undefined && reduceTo > (maximum ?? 60)) {
    fail([...root, "idle_time_reduce_to"], "不得大于 idle_time_max");
  }
  nonNegativeInteger(config.wait_play_audio_num_threshold, [...root, "wait_play_audio_num_threshold"]);
  nonNegativeInteger(config.min_msg_queue_len_to_trigger, [...root, "min_msg_queue_len_to_trigger"]);
  nonNegativeInteger(config.min_audio_queue_len_to_trigger, [...root, "min_audio_queue_len_to_trigger"]);
  if (config.trigger_type !== undefined && (!Array.isArray(config.trigger_type) || !config.trigger_type.every((item) => typeof item === "string"))) {
    fail([...root, "trigger_type"], "必须是事件类型列表");
  }

  const hasCopywriting = enabledMode(config.copywriting, [...root, "copywriting"]);
  const hasComment = enabledMode(config.comment, [...root, "comment"]);
  if (!hasCopywriting && !hasComment) {
    fail(root, "启用时至少需要一组非空可用提示");
  }
}
