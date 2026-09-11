import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ConfigGenerationConflictError,
  ConfigStore,
  type JsonObject,
} from "../config/config-store.js";
import type {
  AgentExecutor,
  EventSource,
  ProcessedReply,
  SpeechService,
} from "../core/contracts.js";
import type { AppEvent, EventPublisher, LiveEvent } from "../domain/types.js";
import type {
  ManualEventInput,
  ManualRuntimeControls,
} from "./manual-input.js";
import type {
  RuntimeEventProcessor,
  RuntimeLogger,
} from "./scheduler.js";

export const RESTART_EXIT_CODE = 75;

export type ApplicationState =
  | "stopped"
  | "starting"
  | "running"
  | "reloading"
  | "stopping"
  | "failed";

export interface RuntimeEventBus extends EventPublisher {
  subscribe?(listener: (event: AppEvent) => void): () => void;
}

export interface RuntimeAutomation {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  dispose?(): void | Promise<void>;
  noteActivity?(event: LiveEvent): void;
  notePlaybackQueue?(waitPlayAudio: number): void;
  status?(): unknown;
}

export interface RuntimeServer {
  start(options?: {
    readonly host?: string;
    readonly port?: number;
  }): unknown | Promise<unknown>;
  close(): void | Promise<void>;
  status?(): unknown;
}

export interface RuntimeManualInput {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  dispose?(): void | Promise<void>;
  status?(): unknown;
}

export interface ApplicationServices {
  readonly config: ConfigStore;
  readonly publisher: RuntimeEventBus;
  readonly logger: RuntimeLogger;
  readonly executor: AgentExecutor;
  readonly speech: SpeechService;
  readonly processor: RuntimeEventProcessor;
  readonly automation?: RuntimeAutomation;
  readonly platform?: EventSource;
  readonly server?: RuntimeServer;
  readonly manualInput?: RuntimeManualInput;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface ApplicationContext {
  readonly application: Application;
  readonly services: ApplicationServices;
  readonly signal: AbortSignal;
  processEvent(event: LiveEvent): Promise<ProcessedReply | undefined>;
}

export interface LifecyclePlugin {
  readonly name: string;
  readonly order?: number;
  start?(context: ApplicationContext): void | Promise<void>;
  reload?(context: ApplicationContext): void | Promise<void>;
  stop?(context: ApplicationContext): void | Promise<void>;
  status?(): unknown;
}

export const LifecycleOrder = {
  agent: 200,
  speech: 300,
  processor: 400,
  extension: 500,
  automation: 600,
  platform: 700,
  server: 800,
  manualInput: 900,
} as const;

export interface ApplicationOptions {
  readonly services: ApplicationServices;
  readonly cwd?: string;
  readonly plugins?: readonly LifecyclePlugin[];
  readonly manageExecutorLifecycle?: boolean;
  readonly reloadExecutor?: (
    config: JsonObject,
    signal: AbortSignal,
  ) => void | Promise<void>;
  readonly loadBackup?: (path: string) => Promise<JsonObject>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface ApplicationStatus {
  readonly state: ApplicationState;
  readonly restartRequested: boolean;
  readonly requestedExitCode: number;
  readonly configPath: string;
  readonly startedAt?: number;
  readonly lastError?: string;
  readonly components: Readonly<Record<string, unknown>>;
}
export interface RuntimeEventProcessingOptions {
  readonly signal?: AbortSignal;
}


interface StopWaiter {
  resolve(status: ApplicationStatus): void;
}

export class Application implements ManualRuntimeControls {
  readonly services: ApplicationServices;
  readonly #cwd: string;
  readonly #plugins: readonly LifecyclePlugin[];
  readonly #reloadExecutor:
    | ((config: JsonObject, signal: AbortSignal) => void | Promise<void>)
    | undefined;
  readonly #loadBackup: (path: string) => Promise<JsonObject>;
  readonly #now: () => number;
  readonly #externalSignal: AbortSignal | undefined;

  #activePlugins: LifecyclePlugin[] = [];
  #controller: AbortController | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #state: ApplicationState = "stopped";
  #startAttempted = false;
  #restartRequested = false;
  #startedAt: number | undefined;
  #lastError: string | undefined;
  #stopWaiters: StopWaiter[] = [];
  #admittedEvents = 0;
  #eventDrainWaiters: Array<() => void> = [];
  #eventAdmissionsOpen = false;
  #queuedConfigChanges = 0;
  readonly #pluginStops = new Map<LifecyclePlugin, Promise<void>>();
  #detachExternalSignal: (() => void) | undefined;

  constructor(options: ApplicationOptions) {
    this.services = options.services;
    this.#cwd = resolve(options.cwd ?? process.cwd());
    this.#reloadExecutor = options.reloadExecutor;
    this.#loadBackup =
      options.loadBackup ??
      (async (path: string): Promise<JsonObject> =>
        (await ConfigStore.load(path)).snapshot());
    this.#externalSignal = options.signal;
    this.#now = options.now ?? Date.now;
    this.#plugins = this.#buildPlugins(
      options.plugins ?? [],
      options.manageExecutorLifecycle !== false,
    );
  }

  get requestedExitCode(): number {
    return this.#restartRequested ? RESTART_EXIT_CODE : 0;
  }

  status(): ApplicationStatus {
    const components: Record<string, unknown> = {};
    for (const plugin of this.#plugins) {
      if (plugin.status === undefined) {
        continue;
      }
      try {
        components[plugin.name] = plugin.status();
      } catch (error) {
        components[plugin.name] = { error: errorMessage(error) };
      }
    }

    return {
      state: this.#state,
      restartRequested: this.#restartRequested,
      requestedExitCode: this.requestedExitCode,
      configPath: this.services.config.path,
      ...(this.#startedAt === undefined ? {} : { startedAt: this.#startedAt }),
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      components,
    };
  }

  start(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#state === "running" || this.#state === "starting") {
        return;
      }
      if (this.#startAttempted) {
        throw new Error(
          `Application instances are single-use and cannot restart after reaching ${this.#state}`,
        );
      }
      if (this.#activePlugins.length > 0) {
        throw new Error("Cannot start an application with active lifecycle components");
      }
      this.#startAttempted = true;
      this.#pluginStops.clear();
      this.#state = "starting";
      this.#eventAdmissionsOpen = true;
      this.#lastError = undefined;
      this.#restartRequested = false;
      this.#controller = new AbortController();
      this.#attachExternalSignal();
      this.#publishStatus("starting", "Application startup began");

      try {
        this.#controller.signal.throwIfAborted();
        for (const plugin of this.#plugins) {
          this.#activePlugins.push(plugin);
          await this.#startPlugin(plugin);
        }
        this.#state = "running";
        this.#startedAt = this.#now();
        this.services.logger.info("Application started", {
          components: this.#activePlugins.map((plugin) => plugin.name),
        });
        this.#publishStatus("ready", "Application started");
      } catch (error) {
        this.#lastError = errorMessage(error);
        this.#eventAdmissionsOpen = false;
        this.#state = "failed";
        this.#controller?.abort(error);
        this.services.logger.error(`Application startup failed: ${this.#lastError}`, {
          error,
        });
        this.#publishStatus("error", `Application startup failed: ${this.#lastError}`);
        const cleanupErrors = await this.#stopActivePlugins(false);
        this.#notifyStopped();
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Application startup and rollback failed",
          );
        }
        throw error;
      }
    });
  }

  stop(): Promise<void> {
    this.#eventAdmissionsOpen = false;
    this.#controller?.abort(
      new DOMException("Application shutdown requested", "AbortError"),
    );
    return this.#exclusive(async () => {
      if (this.#state === "stopped" && this.#activePlugins.length === 0) {
        this.#notifyStopped();
        return;
      }

      this.#state = "stopping";
      this.#publishStatus("stopping", "Application shutdown began");
      const errors = await this.#stopActivePlugins(true);
      this.#state = "stopped";
      this.#startedAt = undefined;
      this.services.logger.info("Application stopped");
      this.#publishStatus("stopped", "Application stopped");
      this.#notifyStopped();
      if (errors.length > 0) {
        throw new AggregateError(errors, "Application shutdown failed");
      }
    });
  }

  reload(): Promise<void> {
    return this.#changeConfig(async (previousSnapshot) => {
      await this.services.config.reload();
      assertOperatorBindUnchanged(
        previousSnapshot,
        this.services.config.snapshot(),
      );
    }, "reload", "reload").then(() => undefined);
  }

  restore(backupPath?: string): Promise<void> {
    return this.#changeConfig(async (previousSnapshot) => {
      const resolvedBackupPath = resolve(
        this.#cwd,
        backupPath ?? `${this.services.config.path}.bak`,
      );
      const backup = await this.#loadBackup(resolvedBackupPath);
      assertOperatorBindUnchanged(previousSnapshot, backup);
      await this.services.config.save(backup);
    }, "restore", "persist").then(() => undefined);
  }

  updateConfig(config: JsonObject, expectedGeneration: number): Promise<number> {
    return this.#changeConfig(async (previousSnapshot) => {
      if (expectedGeneration !== this.services.config.generation) {
        throw new ConfigGenerationConflictError(
          expectedGeneration,
          this.services.config.generation,
        );
      }
      assertOperatorBindUnchanged(previousSnapshot, config);
      await this.services.config.save(config, expectedGeneration);
    }, "update", "persist");
  }

  async requestRestart(): Promise<void> {
    this.#restartRequested = true;
    this.services.logger.info("External restart requested", {
      exitCode: RESTART_EXIT_CODE,
    });
    this.#publishStatus("stopping", "External restart requested", {
      exitCode: RESTART_EXIT_CODE,
    });
    await this.stop();
  }

  async processEvent(
    event: LiveEvent,
    options: RuntimeEventProcessingOptions = {},
  ): Promise<ProcessedReply | undefined> {
    if (
      !this.#eventAdmissionsOpen ||
      (this.#state !== "running" && this.#state !== "starting")
    ) {
      throw new Error(`Cannot process an event while application is ${this.#state}`);
    }

    this.#admittedEvents += 1;
    try {
      const applicationSignal = this.#controller?.signal;
      const callerSignal = options.signal;
      const signal =
        applicationSignal === undefined || applicationSignal === callerSignal
          ? callerSignal
          : callerSignal === undefined
            ? applicationSignal
            : AbortSignal.any([applicationSignal, callerSignal]);
      signal?.throwIfAborted();
      this.services.automation?.noteActivity?.(event);
      return await (
        signal === undefined
          ? this.services.processor.process(event)
          : this.services.processor.process(event, { signal })
      );
    } finally {
      this.#admittedEvents -= 1;
      if (this.#admittedEvents === 0) {
        const waiters = this.#eventDrainWaiters;
        this.#eventDrainWaiters = [];
        for (const resolveDrain of waiters) {
          resolveDrain();
        }
      }
    }
  }

  submitManual(
    input: string | ManualEventInput | LiveEvent,
  ): Promise<ProcessedReply | undefined> {
    return this.processEvent(this.#manualEvent(input));
  }

  waitUntilStopped(): Promise<ApplicationStatus> {
    if (
      (this.#state === "stopped" || this.#state === "failed") &&
      this.#activePlugins.length === 0
    ) {
      return Promise.resolve(this.status());
    }
    return new Promise<ApplicationStatus>((resolvePromise) => {
      this.#stopWaiters.push({ resolve: resolvePromise });
    });
  }

  #changeConfig(
    change: (previousSnapshot: JsonObject) => Promise<void>,
    operation: "reload" | "restore" | "update",
    rollback: "reload" | "persist",
  ): Promise<number> {
    this.#eventAdmissionsOpen = false;
    this.#queuedConfigChanges += 1;
    const result = this.#exclusive(async () => {
      if (this.#state !== "running") {
        throw new Error(`Cannot ${operation} configuration while application is ${this.#state}`);
      }
      const controller = this.#controller;
      if (controller === undefined || controller.signal.aborted) {
        throw new Error(`Cannot ${operation} configuration during shutdown`);
      }

      const previousSnapshot = this.services.config.snapshot();
      const previousGeneration = this.services.config.generation;
      this.#state = "reloading";
      this.#publishStatus("starting", `Configuration ${operation} began`);
      await this.#drainEvents();

      let changeApplied = false;
      let changeGeneration = previousGeneration;
      let pluginReloadBegan = false;
      try {
        controller.signal.throwIfAborted();
        await change(previousSnapshot);
        changeGeneration = this.services.config.generation;
        changeApplied = changeGeneration !== previousGeneration;
        for (const plugin of this.#activePlugins) {
          if (plugin.reload === undefined) {
            continue;
          }
          pluginReloadBegan = true;
          controller.signal.throwIfAborted();
          await plugin.reload(this.#context());
        }
        this.#state = "running";
        this.#lastError = undefined;
        this.services.logger.info(`Configuration ${operation} completed`);
        this.#publishStatus("ready", `Configuration ${operation} completed`);
        return this.services.config.generation;
      } catch (error) {
        const currentGeneration = this.services.config.generation;
        if (!changeApplied && currentGeneration !== previousGeneration) {
          changeApplied = true;
          changeGeneration = currentGeneration;
        }
        const rollbackErrors: unknown[] = [];
        if (changeApplied) {
          if (
            rollback === "reload" &&
            error instanceof OperatorBindRestartRequiredError
          ) {
            try {
              this.services.config.restoreSnapshot(
                previousSnapshot,
                changeGeneration,
              );
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          } else {
            try {
              await this.services.config.save(
                previousSnapshot,
                changeGeneration,
              );
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
              try {
                this.services.config.restoreSnapshot(
                  previousSnapshot,
                  changeGeneration,
                );
              } catch (restoreError) {
                rollbackErrors.push(restoreError);
              }
            }
          }
        }
        if (pluginReloadBegan) {
          for (const plugin of this.#activePlugins) {
            if (plugin.reload === undefined) {
              continue;
            }
            try {
              await plugin.reload(this.#context());
            } catch (rollbackError) {
              rollbackErrors.push(
                new Error(`Failed to compensate lifecycle component ${plugin.name}`, {
                  cause: rollbackError,
                }),
              );
            }
          }
        }

        const failure =
          rollbackErrors.length === 0
            ? error
            : new AggregateError(
                [error, ...rollbackErrors],
                `Configuration ${operation} and rollback failed`,
              );
        this.#state = rollbackErrors.length === 0 ? "running" : "failed";
        this.#lastError = errorMessage(failure);
        this.services.logger.error(
          `Configuration ${operation} failed: ${this.#lastError}`,
          { error: failure },
        );
        this.#publishStatus(
          "degraded",
          `Configuration ${operation} failed: ${this.#lastError}`,
        );
        throw failure;
      }
    });
    return result.finally(() => {
      this.#queuedConfigChanges -= 1;
      if (
        this.#queuedConfigChanges === 0 &&
        this.#state === "running" &&
        this.#controller?.signal.aborted === false
      ) {
        this.#eventAdmissionsOpen = true;
      }
    });
  }


  #buildPlugins(
    extensions: readonly LifecyclePlugin[],
    manageExecutorLifecycle: boolean,
  ): readonly LifecyclePlugin[] {
    const plugins: LifecyclePlugin[] = [];
    if (manageExecutorLifecycle) {
      plugins.push({
        name: "agent",
        order: LifecycleOrder.agent,
        reload: async () => {
          if (this.#reloadExecutor === undefined) {
            await this.services.executor.reset();
            return;
          }
          const signal = this.#controller?.signal;
          if (signal === undefined) {
            throw new Error("Agent reload requires an active application signal");
          }
          await this.#reloadExecutor(this.services.config.snapshot(), signal);
        },
        stop: async () => {
          await this.services.executor.reset();
        },
      });
    }
    plugins.push(
      {
        name: "speech",
        order: LifecycleOrder.speech,
        stop: async () => {
          await this.services.speech.dispose();
        },
        status: () => this.services.speech.status(),
      },
      {
        name: "processor",
        order: LifecycleOrder.processor,
        reload: async () => {
          await this.services.processor.reload?.();
        },
        stop: async () => {
          await this.services.processor.dispose?.();
        },
      },
    );

    const automation = this.services.automation;
    if (automation !== undefined) {
      plugins.push({
        name: "automation",
        order: LifecycleOrder.automation,
        start: async () => {
          await automation.start();
        },
        reload: async () => {
          await automation.stop();
          await automation.start();
        },
        stop: async () => {
          await automation.stop();
        },
        status: () => automation.status?.(),
      });
    }
    const platform = this.services.platform;
    if (platform !== undefined) {
      plugins.push({
        name: `platform:${platform.name}`,
        order: LifecycleOrder.platform,
        start: async () => {
          await platform.start(async (event): Promise<void> => {
            await this.processEvent(event);
          });
        },
        stop: async () => {
          await platform.dispose();
        },
      });
    }
    const server = this.services.server;
    if (server !== undefined) {
      plugins.push({
        name: "server",
        order: LifecycleOrder.server,
        start: async () => {
          await server.start();
        },
        stop: async () => {
          await server.close();
        },
        status: () => server.status?.(),
      });
    }
    const manualInput = this.services.manualInput;
    if (manualInput !== undefined) {
      plugins.push({
        name: "manual-input",
        order: LifecycleOrder.manualInput,
        start: async () => {
          await manualInput.start();
        },
        stop: async () => {
          await manualInput.stop();
        },
        status: () => manualInput.status?.(),
      });
    }
    plugins.push(...extensions);

    const names = new Set<string>();
    for (const plugin of plugins) {
      if (names.has(plugin.name)) {
        throw new Error(`Duplicate lifecycle plugin name: ${plugin.name}`);
      }
      names.add(plugin.name);
    }
    return plugins
      .map((plugin, index) => ({ plugin, index }))
      .sort(
        (left, right) =>
          (left.plugin.order ?? LifecycleOrder.extension) -
            (right.plugin.order ?? LifecycleOrder.extension) ||
          left.index - right.index,
      )
      .map(({ plugin }) => plugin);
  }

  #attachExternalSignal(): void {
    const external = this.#externalSignal;
    const controller = this.#controller;
    if (external === undefined || controller === undefined) {
      return;
    }
    const abort = (): void => {
      controller.abort(
        external.reason ?? new DOMException("Application startup aborted", "AbortError"),
      );
      void this.stop().catch((error: unknown) => {
        this.services.logger.error("External abort cleanup failed", { error });
      });
    };
    if (external.aborted) {
      controller.abort(
        external.reason ?? new DOMException("Application startup aborted", "AbortError"),
      );
      return;
    }
    external.addEventListener("abort", abort, { once: true });
    this.#detachExternalSignal = () => {
      external.removeEventListener("abort", abort);
    };
  }

  async #startPlugin(plugin: LifecyclePlugin): Promise<void> {
    if (plugin.start === undefined) {
      return;
    }
    const context = this.#context();
    const signal = context.signal;
    signal.throwIfAborted();

    const startOperation = Promise.resolve().then(async () => plugin.start!(context));
    let earlyStop: Promise<void> | undefined;
    const {
      promise: aborted,
      reject: rejectAborted,
    } = Promise.withResolvers<never>();
    const stopOnAbort = (): void => {
      earlyStop = this.#stopPlugin(plugin);
      void earlyStop.catch(() => undefined);
      rejectAborted(
        signal.reason ?? new DOMException("Application startup aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      await Promise.race([startOperation, aborted]);
      signal.throwIfAborted();
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
      const cleanupErrors: unknown[] = [];
      try {
        await startOperation;
      } catch (startError) {
        if (startError !== error && startError !== signal.reason) {
          cleanupErrors.push(startError);
        }
      }
      try {
        await earlyStop;
      } catch (stopError) {
        cleanupErrors.push(stopError);
      }
      try {
        await this.#stopPlugin(plugin, true);
      } catch (stopError) {
        cleanupErrors.push(stopError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Lifecycle component ${plugin.name} abort cleanup failed`,
        );
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", stopOnAbort);
    }
  }

  #stopPlugin(plugin: LifecyclePlugin, force = false): Promise<void> {
    const active = this.#pluginStops.get(plugin);
    if (!force && active !== undefined) {
      return active;
    }
    const stopping = Promise.resolve().then(async () => plugin.stop?.(this.#context()));
    this.#pluginStops.set(plugin, stopping);
    return stopping;
  }

  #drainEvents(): Promise<void> {
    if (this.#admittedEvents === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolveDrain) => {
      this.#eventDrainWaiters.push(resolveDrain);
    });
  }

  async #stopActivePlugins(reportErrors: boolean): Promise<unknown[]> {
    const errors: unknown[] = [];
    while (this.#activePlugins.length > 0) {
      const plugin = this.#activePlugins.pop()!;
      try {
        await this.#stopPlugin(plugin);
      } catch (error) {
        errors.push(error);
        this.services.logger.error(
          `Failed to stop lifecycle component ${plugin.name}: ${errorMessage(error)}`,
          { error, component: plugin.name },
        );
      }
    }
    this.#controller = undefined;
    this.#eventAdmissionsOpen = false;
    this.#pluginStops.clear();
    this.#detachExternalSignal?.();
    this.#detachExternalSignal = undefined;
    if (!reportErrors && errors.length > 0) {
      this.services.logger.error("Startup rollback encountered cleanup errors", {
        errors,
      });
    }
    return errors;
  }

  #context(): ApplicationContext {
    return {
      application: this,
      services: this.services,
      signal:
        this.#controller?.signal ??
        AbortSignal.abort(new DOMException("Application is stopped", "AbortError")),
      processEvent: (event) => this.processEvent(event),
    };
  }

  #manualEvent(input: string | ManualEventInput | LiveEvent): LiveEvent {
    if (typeof input !== "string" && isLiveEvent(input)) {
      return input;
    }
    const manual = typeof input === "string" ? { content: input } : input;
    const content = manual.content.trim();
    if (content.length === 0) {
      throw new TypeError("Manual event content must not be empty");
    }
    return {
      id: randomUUID(),
      type: manual.type ?? "talk",
      platform: manual.platform ?? "stdin",
      username:
        manual.username ??
        "manual",
      content,
      timestamp: this.#now(),
      metadata: { source: "manual", ...manual.metadata },
    };
  }

  #publishStatus(
    status: "starting" | "ready" | "degraded" | "stopping" | "stopped" | "error",
    message: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): void {
    this.services.publisher.publish({
      type: "system.status",
      component: "runtime.application",
      status,
      message,
      ...(metadata === undefined ? {} : { metadata }),
      timestamp: this.#now(),
    });
  }

  #notifyStopped(): void {
    const status = this.status();
    const waiters = this.#stopWaiters;
    this.#stopWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve(status);
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class OperatorBindRestartRequiredError extends Error {
  constructor() {
    super(
      "Operator HTTP bind configuration changed; restart the application to apply webui.ip/webui.port or api_ip/api_port",
    );
    this.name = "OperatorBindRestartRequiredError";
  }
}

function assertOperatorBindUnchanged(
  previous: JsonObject,
  candidate: JsonObject,
): void {
  const previousBind = operatorBind(previous);
  const candidateBind = operatorBind(candidate);
  if (isDeepStrictEqual(previousBind, candidateBind)) {
    return;
  }
  throw new OperatorBindRestartRequiredError();
}

function operatorBind(config: JsonObject): {
  readonly host: unknown;
  readonly port: unknown;
} {
  const webui =
    config["webui"] !== null &&
    typeof config["webui"] === "object" &&
    !Array.isArray(config["webui"])
      ? config["webui"] as JsonObject
      : {};
  return {
    host: webui["ip"] ?? config["api_ip"] ?? "127.0.0.1",
    port: webui["port"] ?? config["api_port"] ?? 8_081,
  };
}

function isLiveEvent(value: ManualEventInput | LiveEvent): value is LiveEvent {
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "timestamp" in value &&
    typeof value.timestamp === "number" &&
    "metadata" in value &&
    value.metadata !== null &&
    typeof value.metadata === "object"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
