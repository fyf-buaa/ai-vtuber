export const SCHEDULE_INTERVAL_UNITS = {
  seconds: { label: "秒", milliseconds: 1_000 },
  minutes: { label: "分钟", milliseconds: 60_000 },
  hours: { label: "小时", milliseconds: 3_600_000 },
} as const;

export type ScheduleIntervalUnit = keyof typeof SCHEDULE_INTERVAL_UNITS;

export type ScheduleInterval =
  | { readonly mode: "fixed"; readonly every: number; readonly unit: ScheduleIntervalUnit }
  | { readonly mode: "random"; readonly min: number; readonly max: number; readonly unit: ScheduleIntervalUnit };

export interface ScheduleTask {
  readonly id: string;
  readonly name: string;
  readonly enable: boolean;
  readonly run_on_start: boolean;
  readonly interval: ScheduleInterval;
  readonly prompts: readonly string[];
}

export class ScheduleConfigurationError extends Error {
  readonly path: readonly string[];

  constructor(path: readonly string[], message: string) {
    super(`${path.join(".")}：${message}`);
    this.name = "ScheduleConfigurationError";
    this.path = path;
  }
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function intervalValue(value: unknown, unit: ScheduleIntervalUnit, path: readonly string[]): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ScheduleConfigurationError(path, "请填写大于 0 的间隔");
  }
  const milliseconds = value * SCHEDULE_INTERVAL_UNITS[unit].milliseconds;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > MAX_TIMER_DELAY_MS) {
    throw new ScheduleConfigurationError(path, "间隔须精确到毫秒，且不超过 2147483647 毫秒（约 24.8 天）");
  }
  return value;
}

export function parseScheduleConfig(value: unknown): readonly ScheduleTask[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ScheduleConfigurationError(["schedule"], "定时任务必须是任务列表");
  }
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const path = ["schedule", String(index)];
    if (!record(item)) {
      throw new ScheduleConfigurationError(path, "任务必须是对象");
    }
    for (const obsolete of ["time_min", "time_max", "copy"]) {
      if (Object.hasOwn(item, obsolete)) {
        throw new ScheduleConfigurationError([...path, obsolete], "旧定时配置已停用，请改用 id、name、interval、prompts 和 run_on_start");
      }
    }
    if (typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id)) {
      throw new ScheduleConfigurationError([...path, "id"], "任务标识须为 1–64 位字母、数字、下划线或连字符");
    }
    if (ids.has(item.id)) {
      throw new ScheduleConfigurationError([...path, "id"], "任务标识不能重复，否则会混用会话上下文");
    }
    ids.add(item.id);
    if (typeof item.name !== "string" || item.name.trim() === "") {
      throw new ScheduleConfigurationError([...path, "name"], "请填写任务名称");
    }
    for (const field of ["enable", "run_on_start"] as const) {
      if (typeof item[field] !== "boolean") {
        throw new ScheduleConfigurationError([...path, field], "此项必须为开关值");
      }
    }
    const interval = item.interval;
    if (!record(interval)) {
      throw new ScheduleConfigurationError([...path, "interval"], "请选择执行间隔");
    }
    if (typeof interval.unit !== "string" || !Object.hasOwn(SCHEDULE_INTERVAL_UNITS, interval.unit)) {
      throw new ScheduleConfigurationError([...path, "interval", "unit"], "时间单位须为秒、分钟或小时");
    }
    const unit = interval.unit as ScheduleIntervalUnit;
    if (interval.mode === "fixed") {
      intervalValue(interval.every, unit, [...path, "interval", "every"]);
    } else if (interval.mode === "random") {
      const minimum = intervalValue(interval.min, unit, [...path, "interval", "min"]);
      const maximum = intervalValue(interval.max, unit, [...path, "interval", "max"]);
      if (maximum < minimum) {
        throw new ScheduleConfigurationError([...path, "interval", "max"], "最长间隔不能小于最短间隔");
      }
    } else {
      throw new ScheduleConfigurationError([...path, "interval", "mode"], "请选择固定间隔或随机间隔");
    }
    if (!Array.isArray(item.prompts) || item.prompts.some(prompt => typeof prompt !== "string")) {
      throw new ScheduleConfigurationError([...path, "prompts"], "提示词必须是文本列表");
    }
    if (item.enable) {
      if (item.prompts.length === 0) {
        throw new ScheduleConfigurationError([...path, "prompts"], "启用前请至少添加一条提示词");
      }
      for (const [promptIndex, prompt] of item.prompts.entries()) {
        if ((prompt as string).trim() === "") {
          throw new ScheduleConfigurationError([...path, "prompts", String(promptIndex)], "启用任务的提示词不能为空");
        }
      }
    }
  }
  return value as readonly ScheduleTask[];
}

export function scheduleIntervalBounds(interval: ScheduleInterval): {
  readonly minimumMilliseconds: number;
  readonly maximumMilliseconds: number;
} {
  const multiplier = SCHEDULE_INTERVAL_UNITS[interval.unit].milliseconds;
  return interval.mode === "fixed"
    ? { minimumMilliseconds: interval.every * multiplier, maximumMilliseconds: interval.every * multiplier }
    : { minimumMilliseconds: interval.min * multiplier, maximumMilliseconds: interval.max * multiplier };
}
