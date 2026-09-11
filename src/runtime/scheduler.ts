import { randomUUID } from "node:crypto";
import { resolvePiAgentMode } from "../agent/provider-resolution.js";
import { MAX_TIMER_DELAY_MS, validateIdleConfig } from "../config/idle.js";
import { parseScheduleConfig, scheduleIntervalBounds } from "../config/schedule.js";
import type { ProcessedReply } from "../core/contracts.js";

import type { ConfigStore } from "../config/config-store.js";
import type { AppEvent, EventPublisher, LiveEvent } from "../domain/types.js";


export interface RuntimeLogger {
  debug(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  info(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  error(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export interface RuntimeEventProcessor {
  process(
    event: LiveEvent,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProcessedReply | undefined>;
  reload?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface RuntimeClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface SchedulerStatus {
  readonly running: boolean;
  readonly taskCount: number;
  readonly failures: readonly SchedulerFailure[];
}

export interface SchedulerFailure {
  readonly task: string;
  readonly message: string;
  readonly timestamp: number;
}


export interface RuntimeSchedulerOptions {
  readonly config: ConfigStore;
  readonly processor: RuntimeEventProcessor;
  readonly publisher?: EventPublisher;
  readonly logger?: RuntimeLogger;
  readonly clock?: RuntimeClock;
  readonly random?: () => number;
  readonly onError?: (error: unknown, task: string) => void;
  readonly getQueueStatus?: () => unknown;
}

interface ScheduledMessageConfig {
  readonly id: string;
  readonly name: string;
  readonly runOnStart: boolean;
  readonly minimumMilliseconds: number;
  readonly maximumMilliseconds: number;
  readonly prompts: readonly string[];
}


interface IdleModeConfig {
  readonly name: "copywriting" | "comment";
  readonly random: boolean;
  readonly values: readonly string[];
}

interface IdleConfig {
  readonly type: string;
  readonly minimumMilliseconds: number;
  readonly maximumMilliseconds: number;
  readonly triggerTypes: ReadonlySet<string>;
  readonly minimumMessageQueueLength: number;
  readonly minimumAudioQueueLength: number;
  readonly waitPlayAudioThreshold: number;
  readonly idleTimeReduceToMilliseconds: number;
  readonly modes: readonly IdleModeConfig[];
}


interface AutomationPlan {
  readonly scheduledMessages: readonly ScheduledMessageConfig[];
  readonly idle?: IdleConfig;
}

interface RotationState {
  signature: string;
  remaining: string[];
}

const defaultLogger: RuntimeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const realRuntimeClock: RuntimeClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolvePromise, rejectPromise) => {
      if (signal.aborted) {
        rejectPromise(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }

      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        rejectPromise(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };

      timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise();
      }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, milliseconds)));
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

export class RuntimeScheduler {
  readonly #config: ConfigStore;
  readonly #processor: RuntimeEventProcessor;
  readonly #publisher: EventPublisher | undefined;
  readonly #logger: RuntimeLogger;
  readonly #clock: RuntimeClock;
  readonly #random: () => number;
  readonly #onError: ((error: unknown, task: string) => void) | undefined;
  readonly #getQueueStatus: (() => unknown) | undefined;

  #controller: AbortController | undefined;
  #loops = new Set<Promise<void>>();
  #dispatchTail: Promise<void> = Promise.resolve();
  #failures: SchedulerFailure[] = [];
  #lastUsername = "";
  #onlineUserCount: string | number = "N";
  #idlePlan: IdleConfig | undefined;
  #idleNextAt = 0;
  #idleIntervalMilliseconds = 0;

  constructor(options: RuntimeSchedulerOptions) {
    this.#config = options.config;
    this.#processor = options.processor;
    this.#publisher = options.publisher;
    this.#logger = options.logger ?? defaultLogger;
    this.#clock = options.clock ?? realRuntimeClock;
    this.#random = options.random ?? Math.random;
    this.#onError = options.onError;
    this.#getQueueStatus = options.getQueueStatus;
  }

  status(): SchedulerStatus {
    return {
      running:
        this.#controller !== undefined &&
        !this.#controller.signal.aborted &&
        this.#loops.size > 0,
      taskCount: this.#loops.size,
      failures: this.#failures.map((failure) => ({ ...failure })),
    };
  }

  async start(): Promise<void> {
    if (this.#controller !== undefined && !this.#controller.signal.aborted) {
      return;
    }

    const plan = this.#readPlan();
    const controller = new AbortController();
    this.#controller = controller;
    this.#loops = new Set();
    this.#dispatchTail = Promise.resolve();
    this.#idlePlan = plan.idle;
    const startedAt = this.#clock.now();
    this.#idleIntervalMilliseconds = plan.idle
      ? this.#randomInterval(plan.idle)
      : 0;
    this.#idleNextAt = plan.idle
      ? startedAt + this.#idleIntervalMilliseconds
      : 0;

    for (const task of plan.scheduledMessages) {
      this.#spawn(`schedule:${task.id}`, (signal) =>
        this.#runScheduledMessages(task, signal),
      );
    }


    if (plan.idle !== undefined && plan.idle.modes.length > 0) {
      this.#spawn("idle", (signal) => this.#runIdle(plan.idle!, signal));
    }


    this.#logger.info("Runtime scheduling started", {
      taskCount: this.#loops.size,
    });
    this.#publishStatus("ready", "Runtime scheduling started", {
      taskCount: this.#loops.size,
    });
  }

  async stop(): Promise<void> {
    const controller = this.#controller;
    if (controller === undefined) {
      return;
    }

    this.#controller = undefined;
    controller.abort(new DOMException("Runtime scheduler stopped", "AbortError"));
    const loops = this.#loops;
    this.#loops = new Set();
    await Promise.allSettled(loops);
    await this.#dispatchTail.catch(() => undefined);
    this.#idlePlan = undefined;
    this.#idleIntervalMilliseconds = 0;
    this.#logger.info("Runtime scheduling stopped");
    this.#publishStatus("stopped", "Runtime scheduling stopped");
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  noteActivity(event: LiveEvent): void {
    this.#lastUsername = event.username;
    const onlineUserCount = event.metadata.onlineUserCount;
    if (typeof onlineUserCount === "number" || typeof onlineUserCount === "string") {
      this.#onlineUserCount = onlineUserCount;
    }

    const idle = this.#idlePlan;
    if (idle === undefined || !idle.triggerTypes.has(event.type)) {
      return;
    }

    const activityAt = this.#clock.now();
    this.#idleIntervalMilliseconds = this.#randomInterval(idle);
    this.#idleNextAt = activityAt + this.#idleIntervalMilliseconds;
  }

  /**
   * Mirrors the legacy playback callback: a backed-up external playback queue
   * resets the current idle cycle's elapsed time to idle_time_reduce_to.
   */
  notePlaybackQueue(waitPlayAudio: number): void {
    const idle = this.#idlePlan;
    if (
      idle === undefined ||
      !Number.isSafeInteger(waitPlayAudio) ||
      waitPlayAudio < 0 ||
      waitPlayAudio <= idle.waitPlayAudioThreshold
    ) {
      return;
    }

    const remaining = Math.max(
      0,
      this.#idleIntervalMilliseconds - idle.idleTimeReduceToMilliseconds,
    );
    this.#idleNextAt = this.#clock.now() + remaining;
  }

  #spawn(
    task: string,
    run: (signal: AbortSignal) => Promise<void>,
  ): void {
    const signal = this.#controller?.signal;
    if (signal === undefined) {
      throw new Error("Cannot spawn a runtime task before the scheduler starts");
    }

    const loops = this.#loops;
    const loop = run(signal).catch((error: unknown) => {
      if (signal.aborted || isAbortError(error)) {
        return;
      }
      this.#recordFailure(error, task);
    });
    loops.add(loop);
    const removeSettledLoop = (): void => {
      if (this.#loops === loops && loops.has(loop)) {
        loops.delete(loop);
      }
    };
    void loop.then(removeSettledLoop, removeSettledLoop);
  }

  async #runScheduledMessages(
    task: ScheduledMessageConfig,
    signal: AbortSignal,
  ): Promise<void> {
    if (!task.runOnStart) {
      await this.#clock.sleep(this.#scheduledInterval(task), signal);
    }

    while (!signal.aborted) {
      const template = choose(task.prompts, this.#random);
      const content = randomizeBrackets(
        this.#formatVariables(template),
        this.#random,
      ).trim();
      if (content.length > 0) {
        await this.#dispatch(
          this.#event("schedule", task.name, content, {
            source: "schedule",
            scheduleId: task.id,
            sessionId: `${this.#config.get<string>("platform") ?? "local"}:schedule:${task.id}`,
          }),
          signal,
        );
      }
      await this.#clock.sleep(this.#scheduledInterval(task), signal);
    }
  }


  async #runIdle(idle: IdleConfig, signal: AbortSignal): Promise<void> {
    const rotations = new Map<IdleModeConfig["name"], RotationState>();
    let modeIndex = 0;

    while (!signal.aborted) {
      const now = this.#clock.now();
      const remaining = this.#idleNextAt - now;
      if (remaining > 0) {
        await this.#clock.sleep(Math.min(remaining, 1_000), signal);
        continue;
      }
      if (!this.#queueAllowsIdle(idle)) {
        this.#idleNextAt = now + Math.min(this.#randomInterval(idle), 1_000);
        continue;
      }

      const mode = idle.modes[modeIndex % idle.modes.length]!;
      modeIndex = (modeIndex + 1) % idle.modes.length;
      const value = takeRotationValue(
        mode,
        rotations,
        this.#random,
      );
      if (value !== undefined) {
        await this.#dispatchIdle(mode, value, signal);
      }
      this.#idleIntervalMilliseconds = this.#randomInterval(idle);
      this.#idleNextAt =
        this.#clock.now() + this.#idleIntervalMilliseconds;
    }
  }

  async #dispatchIdle(
    mode: IdleModeConfig,
    value: string,
    signal: AbortSignal,
  ): Promise<void> {
    const content = randomizeBrackets(
      this.#formatVariables(value),
      this.#random,
    ).trim();
    if (content.length === 0) {
      return;
    }
    await this.#dispatch(
      this.#event(
        "idle",
        "闲时任务",
        content,
        {
          idleMode: mode.name,
          source: "idle_time_task",
        },
      ),
      signal,
    );
  }


  #dispatch(event: LiveEvent, signal: AbortSignal): Promise<void> {
    return this.#serialize(async () => {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      await this.#processor.process(event, { signal });
    });
  }

  #serialize(run: () => Promise<void>): Promise<void> {
    const current = this.#dispatchTail.catch(() => undefined).then(run);
    this.#dispatchTail = current.catch(() => undefined);
    return current;
  }

  #event(
    type: LiveEvent["type"],
    username: string,
    content: string,
    metadata: Readonly<Record<string, unknown>>,
  ): LiveEvent {
    return {
      id: randomUUID(),
      type,
      platform: this.#config.get<string>("platform") ?? "local",
      username,
      content,
      timestamp: this.#clock.now(),
      metadata,
    };
  }

  #formatVariables(template: string): string {
    const time = formatChineseTime(this.#clock.now());
    return template
      .replaceAll("{time}", time)
      .replaceAll("{user_num}", String(this.#onlineUserCount))
      .replaceAll("{last_username}", this.#lastUsername);
  }

  #scheduledInterval(task: ScheduledMessageConfig): number {
    return randomBetween(
      task.minimumMilliseconds,
      task.maximumMilliseconds,
      this.#random,
    );
  }

  #randomInterval(idle: IdleConfig): number {
    return randomBetween(
      idle.minimumMilliseconds,
      idle.maximumMilliseconds,
      this.#random,
    );
  }

  #queueAllowsIdle(idle: IdleConfig): boolean {
    if (idle.type === "直播间无消息更新闲时") {
      return true;
    }

    const status = asRecord(this.#getQueueStatus?.());
    if (status === undefined) {
      return false;
    }
    if (idle.type === "待合成消息队列更新闲时") {
      const queued = firstNumber(status, [
        "queued",
        "queueLength",
        "messageQueueLength",
        "pending",
      ]);
      return queued !== undefined && queued < idle.minimumMessageQueueLength;
    }
    if (idle.type === "待播放音频队列更新闲时") {
      const queued = firstNumber(status, [
        "queued",
        "queueLength",
        "audioQueueLength",
        "pending",
      ]);
      const playing = status.playing === true || status.state === "playing";
      return (
        queued !== undefined &&
        queued + (playing ? 1 : 0) < idle.minimumAudioQueueLength
      );
    }
    return false;
  }

  #readPlan(): AutomationPlan {
    const scheduledMessages = this.#readScheduledMessages();
    const idle = this.#readIdleConfig();

    return {
      scheduledMessages,
      ...(idle === undefined ? {} : { idle }),
    };
  }

  #readScheduledMessages(): ScheduledMessageConfig[] {
    const tasks = parseScheduleConfig(this.#config.get<unknown>("schedule"));
    if (resolvePiAgentMode(this.#config.snapshot()) !== "llm") {
      return [];
    }

    return tasks
      .filter((task) => task.enable)
      .map((task) => {
        const { minimumMilliseconds, maximumMilliseconds } =
          scheduleIntervalBounds(task.interval);
        return {
          id: task.id,
          name: task.name,
          runOnStart: task.run_on_start,
          minimumMilliseconds,
          maximumMilliseconds,
          prompts: task.prompts,
        };
      });
  }

  #readIdleConfig(): IdleConfig | undefined {
    const value = this.#config.get<unknown>("idle_time_task");
    validateIdleConfig(value);
    const config = asRecord(value);
    if (config?.enable !== true) return undefined;

    const minimumMilliseconds = Math.round(
      ((config.idle_time_min as number | undefined) ?? 30) * 1_000,
    );
    const maximumMilliseconds = Math.round(
      ((config.idle_time_max as number | undefined) ?? 60) * 1_000,
    );
    const modes: IdleModeConfig[] = [];
    for (const name of ["copywriting", "comment"] as const) {
      const mode = asRecord(config[name]);
      if (mode?.enable !== true) continue;
      const values = stringArray(mode.copy);
      if (values.length > 0) {
        modes.push({ name, random: mode.random === true, values });
      }
    }

    return {
      type: (config.type as string | undefined) ?? "直播间无消息更新闲时",
      minimumMilliseconds,
      maximumMilliseconds,
      triggerTypes: new Set(stringArray(config.trigger_type)),
      minimumMessageQueueLength: (config.min_msg_queue_len_to_trigger as number | undefined) ?? 1,
      minimumAudioQueueLength: (config.min_audio_queue_len_to_trigger as number | undefined) ?? 1,
      waitPlayAudioThreshold: (config.wait_play_audio_num_threshold as number | undefined) ?? 10,
      idleTimeReduceToMilliseconds: Math.round(
        ((config.idle_time_reduce_to as number | undefined) ?? 0) * 1_000,
      ),
      modes,
    };
  }


  #recordFailure(error: unknown, task: string): void {
    const message = errorMessage(error);
    const failure = { task, message, timestamp: this.#clock.now() };
    this.#failures.push(failure);
    this.#logger.error(`Runtime task ${task} failed: ${message}`, {
      error,
      task,
    });
    this.#publishStatus("error", `Runtime task ${task} failed: ${message}`, {
      task,
    });
    this.#onError?.(error, task);
  }

  #publishStatus(
    status: Extract<AppEvent, { type: "system.status" }>["status"],
    message: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): void {

    this.#publisher?.publish({
      type: "system.status",
      component: "runtime.scheduler",
      status,
      message,
      ...(metadata === undefined ? {} : { metadata }),
      timestamp: this.#clock.now(),
    });
  }
}


function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
}


function firstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function choose<T>(values: readonly T[], random: () => number): T {
  const index = Math.min(
    values.length - 1,
    Math.floor(clampRandom(random()) * values.length),
  );
  return values[index]!;
}

function randomBetween(
  minimum: number,
  maximum: number,
  random: () => number,
): number {
  if (minimum === maximum) {
    return minimum;
  }
  return minimum + Math.floor(clampRandom(random()) * (maximum - minimum + 1));
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1 - Number.EPSILON;
  }
  return value;
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(clampRandom(random()) * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function takeRotationValue(
  mode: IdleModeConfig,
  rotations: Map<IdleModeConfig["name"], RotationState>,
  random: () => number,
): string | undefined {
  const signature = JSON.stringify(mode.values);
  let state = rotations.get(mode.name);
  if (state === undefined || state.signature !== signature || state.remaining.length === 0) {
    state = {
      signature,
      remaining: mode.random
        ? shuffled(mode.values, random)
        : [...mode.values],
    };
    rotations.set(mode.name, state);
  }
  return state.remaining.shift();
}

export function randomizeBrackets(
  text: string,
  random: () => number = Math.random,
): string {
  return text.replace(/\[([^\]]*)\]/g, (_match, options: string) =>
    choose(options.split("|"), random),
  );
}

export function formatChineseTime(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  if (hour < 6) {
    return `凌晨${hour}点${minute}分`;
  }
  if (hour < 9) {
    return `早晨${hour}点${minute}分`;
  }
  if (hour < 12) {
    return `上午${hour}点${minute}分`;
  }
  if (hour === 12) {
    return `中午${hour}点${minute}分`;
  }
  if (hour < 18) {
    return `下午${hour - 12}点${minute}分`;
  }
  if (hour < 20) {
    return `傍晚${hour - 12}点${minute}分`;
  }
  return `晚上${hour - 12}点${minute}分`;
}


function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
