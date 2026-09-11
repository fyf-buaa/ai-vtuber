import { resolve } from "node:path";

import { createPiAgentExecutor } from "../agent/index.js";
import {
  ConfigStore,
  type JsonObject,
} from "../config/config-store.js";
import {
  EventProcessor,
  type EventMiddleware,
  type EventReplyHook,
} from "../core/event-processor.js";
import type {
  AgentExecutionOptions,
  AgentExecutor,
  EventSource,
  ProcessedReply,
  SpeechService,
} from "../core/contracts.js";
import type {
  AgentRequest,
  AgentResponse,
  AppEvent,
  EventPublisher,
} from "../domain/types.js";
import { EventBus } from "../infrastructure/event-bus.js";
import { createLogger } from "../infrastructure/logger.js";
import {
  assertPlatformAvailable,
  createDefaultPlatformRegistry,
  type PlatformRegistry,
} from "../platforms/index.js";
import { createOperatorServer } from "../server/index.js";
import { createSpeechService } from "../speech/index.js";
import {
  Application,
  type ApplicationServices,
  type LifecyclePlugin,
  type RuntimeAutomation,
  type RuntimeEventBus,
  type RuntimeManualInput,
  type RuntimeServer,
} from "./application.js";
import {
  StdinManualInput,
  type ManualRuntimeControls,
} from "./manual-input.js";
import {
  RuntimeScheduler,
  type RuntimeClock,
  type RuntimeEventProcessor,
  type RuntimeLogger,
} from "./scheduler.js";
import {
  createFullApplication,
  type FullApplicationOptions,
} from "./full-application.js";

export type MaybePromise<T> = T | Promise<T>;

export interface ApplicationFactoryContext {
  readonly cwd: string;
  readonly config: ConfigStore;
  readonly publisher: RuntimeEventBus;
  readonly logger: RuntimeLogger;
  readonly controls: ManualRuntimeControls;
  readonly components: Readonly<Record<string, unknown>>;
}

export type ApplicationComponentFactory<T> = (
  context: ApplicationFactoryContext,
) => MaybePromise<T>;

export interface ApplicationComponentFactories {
  readonly loadConfig?: (path: string) => Promise<ConfigStore>;
  readonly publisher?: ApplicationComponentFactory<RuntimeEventBus>;
  readonly logger?: ApplicationComponentFactory<RuntimeLogger>;
  readonly executor?: ApplicationComponentFactory<AgentExecutor>;
  readonly speech?: ApplicationComponentFactory<SpeechService>;
  readonly processor?: ApplicationComponentFactory<RuntimeEventProcessor>;
  readonly platformRegistry?: ApplicationComponentFactory<PlatformRegistry>;
  readonly platform?: ApplicationComponentFactory<EventSource | undefined>;
  readonly automation?: ApplicationComponentFactory<RuntimeAutomation | undefined>;
  readonly server?: ApplicationComponentFactory<RuntimeServer | undefined>;
  readonly manualInput?: ApplicationComponentFactory<RuntimeManualInput | undefined>;
}

export interface ApplicationServiceOverrides {
  readonly config?: ConfigStore;
  readonly publisher?: RuntimeEventBus;
  readonly logger?: RuntimeLogger;
  readonly executor?: AgentExecutor;
  readonly speech?: SpeechService;
  readonly processor?: RuntimeEventProcessor;
  readonly platformRegistry?: PlatformRegistry | null;
  readonly platform?: EventSource | null;
  readonly automation?: RuntimeAutomation | null;
  readonly server?: RuntimeServer | null;
  readonly manualInput?: RuntimeManualInput | null;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface CreateApplicationOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly stdin?: boolean;
  readonly server?: boolean;
  readonly platform?: boolean;
  readonly services?: ApplicationServiceOverrides;
  readonly factories?: ApplicationComponentFactories;
  readonly plugins?: readonly LifecyclePlugin[];
  readonly processor?: {
    readonly middleware?: readonly EventMiddleware[];
    readonly replyHooks?: readonly EventReplyHook[];
  };
  readonly clock?: RuntimeClock;
  readonly random?: () => number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}
export interface ApplicationPreparation {
  readonly services?: Omit<
    ApplicationServiceOverrides,
    "config" | "publisher" | "logger"
  >;
  readonly factories?: Omit<
    ApplicationComponentFactories,
    "loadConfig" | "publisher" | "logger"
  >;
  readonly plugins?: readonly LifecyclePlugin[];
  readonly processor?: {
    readonly middleware?: readonly EventMiddleware[];
    readonly replyHooks?: readonly EventReplyHook[];
  };
  readonly stdin?: boolean;
  readonly server?: boolean;
  readonly platform?: boolean;
  readonly manageExecutorLifecycle?: boolean;
  dispose?(): MaybePromise<void>;
}

export type ApplicationPreparer = (
  context: ApplicationFactoryContext,
) => MaybePromise<ApplicationPreparation>;


class ReloadableAgentExecutor implements AgentExecutor {
  #current: AgentExecutor;
  readonly #create: (config: JsonObject) => MaybePromise<AgentExecutor>;

  constructor(
    initial: AgentExecutor,
    create: (config: JsonObject) => MaybePromise<AgentExecutor>,
  ) {
    this.#current = initial;
    this.#create = create;
  }

  execute(
    request: AgentRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentResponse> {
    return this.#current.execute(request, options);
  }

  stream(
    request: AgentRequest,
    options?: AgentExecutionOptions,
  ): AsyncIterable<string> {
    return this.#current.stream(request, options);
  }

  reset(sessionId?: string): Promise<void> {
    return this.#current.reset(sessionId);
  }

  async replace(config: JsonObject, signal: AbortSignal): Promise<void> {
    let next: AgentExecutor | undefined;
    try {
      next = await this.#create(config);
      signal.throwIfAborted();
      const previous = this.#current;
      await previous.reset();
      signal.throwIfAborted();
      this.#current = next;
    } catch (error) {
      if (next === undefined) {
        throw error;
      }
      try {
        await next.reset();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Agent replacement and candidate cleanup failed",
        );
      }
      throw error;
    }
  }
}

export async function createApplication(
  options: FullApplicationOptions = {},
): Promise<Application> {
  return createFullApplication(options);
}

export async function createCoreApplication(
  options: CreateApplicationOptions = {},
  prepare?: ApplicationPreparer,
): Promise<Application> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.configPath ?? "config.local.json");
  let overrides = options.services ?? {};
  let factories = options.factories ?? {};
  const config =
    overrides.config ??
    (await (factories.loadConfig !== undefined
      ? factories.loadConfig(configPath)
      : options.configPath === undefined
        ? ConfigStore.loadDefault(cwd)
        : ConfigStore.load(configPath)));

  let application: Application | undefined;
  const controls: ManualRuntimeControls = {
    start: () => requireApplication(application).start(),
    stop: () => requireApplication(application).stop(),
    reload: () => requireApplication(application).reload(),
    restore: (backupPath) => requireApplication(application).restore(backupPath),
    updateConfig: (config: JsonObject, expectedGeneration: number) =>
      requireApplication(application).updateConfig(config, expectedGeneration),
    processEvent: (event, processOptions) =>
      requireApplication(application).processEvent(event, processOptions),
    requestRestart: () => requireApplication(application).requestRestart(),
    status: () => requireApplication(application).status(),
    submitManual: (input) => requireApplication(application).submitManual(input),
  };
  const components: Record<string, unknown> = { config };

  const provisionalPublisher = new EventBus();
  const provisionalLogger = createLogger();
  const baseContext = (): ApplicationFactoryContext => ({
    cwd,
    config,
    publisher:
      (components.publisher as RuntimeEventBus | undefined) ??
      provisionalPublisher,
    logger:
      (components.logger as RuntimeLogger | undefined) ??
      provisionalLogger,
    controls,
    components,
  });

  const publisher =
    overrides.publisher ??
    (factories.publisher
      ? await factories.publisher(baseContext())
      : provisionalPublisher);
  components.publisher = publisher;
  const logger =
    overrides.logger ??
    (factories.logger
      ? await factories.logger(baseContext())
      : createLogger({
          bindings: { component: "runtime" },
        }));
  components.logger = logger;

  const cleanup: Array<() => MaybePromise<void>> = [];
  try {
    const preparation = await prepare?.(baseContext());
    if (preparation !== undefined) {
      const preparedServices = preparation.services ?? {};
      const originalExtensions = overrides.extensions;
      const preparedExtensions = preparedServices.extensions;
      overrides = {
        ...overrides,
        ...preparedServices,
        ...(originalExtensions === undefined && preparedExtensions === undefined
          ? {}
          : {
              extensions: {
                ...(originalExtensions ?? {}),
                ...(preparedExtensions ?? {}),
              },
            }),
      };
      factories = {
        ...factories,
        ...(preparation.factories ?? {}),
      };
      if (preparation.dispose !== undefined) {
        cleanup.push(() => preparation.dispose!());
      }
    }
    const middleware = [
      ...(preparation?.processor?.middleware ?? []),
      ...(options.processor?.middleware ?? []),
    ];
    const replyHooks = [
      ...(preparation?.processor?.replyHooks ?? []),
      ...(options.processor?.replyHooks ?? []),
    ];
    const createExecutor = async (snapshot: JsonObject): Promise<AgentExecutor> => {
      if (factories.executor !== undefined) {
        return factories.executor({
          ...baseContext(),
          components: { ...components, config: snapshot },
        });
      }
      return createPiAgentExecutor(snapshot, { publisher });
    };
    const suppliedExecutor = overrides.executor;
    const initialExecutor =
      suppliedExecutor ?? (await createExecutor(config.snapshot()));
    const executor =
      suppliedExecutor === undefined
        ? new ReloadableAgentExecutor(initialExecutor, createExecutor)
        : suppliedExecutor;
    components.executor = executor;
    cleanup.push(() => executor.reset());

    const speech =
      overrides.speech ??
      (factories.speech
        ? await factories.speech(baseContext())
        : createSpeechService({ config, publisher, cwd }));
    components.speech = speech;
    cleanup.push(() => speech.dispose());

    const processor =
      overrides.processor ??
      (factories.processor
        ? await factories.processor(baseContext())
        : new EventProcessor({
            config,
            executor,
            publisher,
            speech,
            cwd,
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(middleware.length === 0 ? {} : { middleware }),
            ...(replyHooks.length === 0 ? {} : { replyHooks }),
          }));
    components.processor = processor;
    cleanup.push(async () => {
      await processor.dispose?.();
    });

    const platformRegistry =
      overrides.platformRegistry === null
        ? undefined
        : overrides.platformRegistry ??
          (factories.platformRegistry
            ? await factories.platformRegistry(baseContext())
            : createDefaultPlatformRegistry({
                onError: (error: Error) => {
                  logger.error(`Platform failed: ${error.message}`, { error });
                },
              }));
    components.platformRegistry = platformRegistry;

    const configuredPlatform = config.get<unknown>("platform");
    const platformName =
      configuredPlatform === undefined
        ? "talk"
        : typeof configuredPlatform === "string"
        ? configuredPlatform
        : String(configuredPlatform);
    const platformEnabled =
      preparation?.platform ??
      options.platform ??
      (overrides.platform !== undefined ||
        factories.platform !== undefined ||
        platformName !== "talk");
    if (platformEnabled) {
      assertPlatformAvailable(platformName);
    }
    const platform =
      overrides.platform === null || !platformEnabled
        ? undefined
        : overrides.platform ??
          (factories.platform
            ? await factories.platform(baseContext())
            : platformRegistry?.create(platformName, config.snapshot()));
    components.platform = platform;
    if (platform !== undefined) {
      cleanup.push(() => platform.dispose());
    }

    const automation =
      overrides.automation === null
        ? undefined
        : overrides.automation ??
          (factories.automation
            ? await factories.automation(baseContext())
            : new RuntimeScheduler({
                config,
                processor,
                publisher,
                logger,
                ...(options.clock === undefined ? {} : { clock: options.clock }),
                ...(options.random === undefined
                  ? {}
                  : { random: options.random }),
                getQueueStatus: () => speech.status(),
              }));
    components.automation = automation;
    if (automation !== undefined) {
      cleanup.push(async () => {
        if (automation.dispose !== undefined) {
          await automation.dispose();
        } else {
          await automation.stop();
        }
      });
    }

    const serverEnabled = preparation?.server ?? options.server ?? true;
    let defaultServer: RuntimeServer | undefined;
    if (
      serverEnabled &&
      overrides.server === undefined &&
      factories.server === undefined
    ) {
      if (!hasSubscriptions(publisher)) {
        throw new TypeError(
          "The default operator server requires an event bus with subscribe()",
        );
      }
      defaultServer = createOperatorServer(
        {
          configStore: config,
          eventSubmitter: {
            async submit(event, submitOptions): Promise<ProcessedReply | undefined> {
              return processor.process(event, submitOptions);
            },
          },
          runtime: controls,
          speech,
          events: publisher,
          onPlaybackCallback: (callback) => {
            if (callback.type !== "audio_playback_completed") {
              return;
            }
            const raw = callback.data["wait_play_audio_num"];
            const waitPlayAudio =
              typeof raw === "string" && raw.trim() !== ""
                ? Number(raw)
                : raw;
            if (
              typeof waitPlayAudio === "number" &&
              Number.isSafeInteger(waitPlayAudio) &&
              waitPlayAudio >= 0
            ) {
              automation?.notePlaybackQueue?.(waitPlayAudio);
            }
          },
          logger,
        },
        {
          applicationRoot: cwd,
          webRoot: resolve(cwd, "web"),
        },
      );
    }
    const server =
      overrides.server === null || !serverEnabled
        ? undefined
        : overrides.server ??
          (factories.server
            ? await factories.server(baseContext())
            : defaultServer);
    components.server = server;
    if (server !== undefined) {
      cleanup.push(() => server.close());
    }

    const stdinEnabled =
      preparation?.stdin ??
      options.stdin ??
      (overrides.manualInput !== undefined ||
        factories.manualInput !== undefined ||
        platformName === "talk");
    const manualInput =
      overrides.manualInput === null || !stdinEnabled
        ? undefined
        : overrides.manualInput ??
          (factories.manualInput
            ? await factories.manualInput(baseContext())
            : new StdinManualInput({
                controls,
                logger,
                onEnd: () => {
                  queueMicrotask(() => void controls.stop());
                },
              }));
    components.manualInput = manualInput;
    if (manualInput !== undefined) {
      cleanup.push(async () => {
        if (manualInput.dispose !== undefined) {
          await manualInput.dispose();
        } else {
          await manualInput.stop();
        }
      });
    }

    const services: ApplicationServices = {
      config,
      publisher,
      logger,
      executor,
      speech,
      processor,
      ...(automation === undefined ? {} : { automation }),
      ...(platform === undefined ? {} : { platform }),
      ...(server === undefined ? {} : { server }),
      ...(manualInput === undefined ? {} : { manualInput }),
      ...(overrides.extensions === undefined
        ? {}
        : { extensions: overrides.extensions }),
    };

    const lifecyclePlugins = [
      ...(preparation?.plugins ?? []),
      ...(options.plugins ?? []),
    ];
    application = new Application({
      services,
      cwd,
      ...(lifecyclePlugins.length === 0 ? {} : { plugins: lifecyclePlugins }),
      manageExecutorLifecycle:
        preparation?.manageExecutorLifecycle !== false,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(executor instanceof ReloadableAgentExecutor
        ? {
            reloadExecutor: (snapshot, signal) =>
              executor.replace(snapshot, signal),
          }
        : {}),
    });

    cleanup.length = 0;
    return application;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const dispose of cleanup.reverse()) {
      try {
        await dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
        try {
          logger.error("Application composition cleanup failed", {
            error: cleanupError,
          });
        } catch {
          // Cleanup must continue even when a user-supplied logger fails.
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Application composition and cleanup failed",
      );
    }
    throw error;
  }
}

function requireApplication(
  application: Application | undefined,
): Application {
  if (application === undefined) {
    throw new Error("Application composition is not complete");
  }
  return application;
}

function hasSubscriptions(
  publisher: EventPublisher,
): publisher is RuntimeEventBus & {
  subscribe(listener: (event: AppEvent) => void): () => void;
} {
  return (
    "subscribe" in publisher &&
    typeof (publisher as { subscribe?: unknown }).subscribe === "function"
  );
}
