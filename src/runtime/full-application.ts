import { resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import { isDeepStrictEqual } from "node:util";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  createImageAgentExecutor,
  primaryAgentSupportsImage,
  createPiAgentExecutor,
  type PiAgentExecutorOptions,
} from "../agent/index.js";
import {
  createActionServices,
  type ActionServiceBundle,
  type ActionServiceDependencies,
} from "../actions/index.js";
import type { JsonObject, JsonValue } from "../config/config-store.js";
import type {
  AgentExecutionOptions,
  AgentExecutor,
  EventSource,
  SpeechEnqueueOptions,
  SpeechService,
} from "../core/contracts.js";
import {
  type EventMiddleware,
  type EventMiddlewareResult,
  type EventProcessingContext,
} from "../core/event-processor.js";
import type {
  AgentRequest,
  AgentResponse,
  AppEvent,
  LiveEvent,
  LocalAudioRequest,
  SpeechRequest,
  SpeechStatus,
} from "../domain/types.js";
import { AnalyticsService } from "../features/analytics/index.js";
import {
  BoundedOnlineSearchService,
  defaultContentFetch,
  mapOnlineSearchConfig,
  type ContentFetch,
} from "../features/content/index.js";
import { createEngagementMiddleware } from "../features/engagement/index.js";
import {
  CaptionSubscriber,
  CoordinationCallbackSubscriber,
  ExternalVisualAudioSink,
  Live2dMessageSubscriber,
  MirroredAudioSink,
  PlaybackStatusSubscriber,
  ReplyForwardingSubscriber,
  createLegacyOutputAdapters,
  subscribeOutputSubscribers,
  type AppEventSubscriber,
  type LegacyOutputAdapters,
  type OutputAdapterFactoryDependencies,
} from "../output/index.js";
import {
  assertPlatformAvailable,
  createDefaultPlatformRegistry,
  type PlatformRegistry,
} from "../platforms/index.js";
import {
  SqliteRepository,
  type IntegralRankingMetric,
} from "../persistence/index.js";
import {
  LegacyUmsService,
  type LegacyUmsDependencies,
  type LegacyUmsLoginConfig,
} from "../security/legacy-ums.js";
import {
  createOperatorServer,
  type LocalBearerAuthorization,
  type OperatorAnalyticsService,
  type OperatorAvatarStatus,
  type OperatorEventBus,
} from "../server/index.js";
import {
  ExternalAudioSink,
  NoopAudioSink,
  createSpeechService,
  resolveSpeechRuntimeSettings,
  type AudioSink,
} from "../speech/index.js";
import { createActionTools } from "../tools/action-tools.js";
import { createContentTools } from "../tools/content-tools.js";
import {
  LifecycleOrder,
  type ApplicationContext,
  type LifecyclePlugin,
  type RuntimeAutomation,
} from "./application.js";
import {
  createCoreApplication,
  type ApplicationFactoryContext,
  type ApplicationPreparation,
  type CreateApplicationOptions,
} from "./create-application.js";

export interface FullApplicationDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly contentFetch?: ContentFetch;
  readonly pi?: Omit<PiAgentExecutorOptions, "publisher" | "tools"> & {
    readonly tools?: readonly AgentTool[];
  };
  readonly actions?: ActionServiceDependencies;
  readonly output?: Omit<
    OutputAdapterFactoryDependencies,
    "fetch" | "projectRoot" | "publisher"
  >;
  readonly ums?: Omit<
    LegacyUmsDependencies,
    "fetch" | "publishStatus" | "stop"
  >;
  readonly createRepository?: (path: string) => SqliteRepository;
  readonly createActionServices?: typeof createActionServices;
  readonly createOutputAdapters?: typeof createLegacyOutputAdapters;
  readonly createImageExecutor?: (
    config: JsonObject,
    options: PiAgentExecutorOptions,
  ) => AgentExecutor | undefined;
  readonly platformRegistry?: PlatformRegistry;
}

export interface FullApplicationOptions extends CreateApplicationOptions {
  /** `false` retains the low-level composition for embedders that supply everything. */
  readonly features?: false | FullApplicationDependencies;
}

function imageAgentOptions(
  options: FullApplicationDependencies["pi"],
): Omit<PiAgentExecutorOptions, "publisher" | "tools" | "toolsForSession"> {
  const { tools, toolsForSession, ...shared } = options ?? {};
  void tools;
  void toolsForSession;
  return shared;
}

interface FeatureBundle {
  readonly snapshot: JsonObject;
  readonly repository?: SqliteRepository;
  readonly analytics?: AnalyticsService;
  readonly actions: ActionServiceBundle;
  readonly outputs: LegacyOutputAdapters;
  readonly audioSink: AudioSink;
  readonly playback: PlaybackStatusSubscriber;
  readonly subscribers: readonly AppEventSubscriber[];
  readonly middleware: readonly EventMiddleware[];
  readonly tools: readonly AgentTool[];
  readonly executor: AgentExecutor;
  readonly imageExecutor?: AgentExecutor;
  readonly ownsExecutor: boolean;
  readonly speech: SpeechService;
  readonly ownsSpeech: boolean;
  readonly sources: readonly EventSource[];
  readonly ums: LegacyUmsService;
  subscription: { dispose(): Promise<void> } | undefined;
  readonly admissionController: AbortController;
  speechStop: Promise<void> | undefined;
  sourceDisposal: Promise<unknown[]> | undefined;
  detachSignal: (() => void) | undefined;
  disposal: Promise<unknown[]> | undefined;
}

interface FeatureBundleLease {
  readonly bundle: FeatureBundle;
  release(): void;
}

class FeatureAgentExecutor implements AgentExecutor {
  readonly #runtime: FeatureRuntime;

  constructor(runtime: FeatureRuntime) {
    this.#runtime = runtime;
  }

  execute(
    request: AgentRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentResponse> {
    return this.#runtime.useBundle((bundle) =>
      this.#executorFor(bundle, request).execute(request, options)
    );
  }

  async *stream(
    request: AgentRequest,
    options?: AgentExecutionOptions,
  ): AsyncIterable<string> {
    const lease = await this.#runtime.leaseBundle();
    try {
      yield* this.#executorFor(lease.bundle, request).stream(request, options);
    } finally {
      lease.release();
    }
  }

  reset(sessionId?: string): Promise<void> {
    return this.#runtime.useOptionalBundle(async (bundle) => {
      if (bundle === undefined) {
        return;
      }
      const errors: unknown[] = [];
      try {
        await bundle.executor.reset(sessionId);
      } catch (error) {
        errors.push(error);
      }
      if (
        bundle.imageExecutor !== undefined &&
        bundle.imageExecutor !== bundle.executor
      ) {
        try {
          await bundle.imageExecutor.reset(sessionId);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Feature agent reset failed");
      }
    });
  }

  #executorFor(bundle: FeatureBundle, request: AgentRequest): AgentExecutor {
    return request.metadata?.eventType === "image" &&
        bundle.imageExecutor !== undefined
      ? bundle.imageExecutor
      : bundle.executor;
  }
}

class FeatureSpeechService implements SpeechService {
  readonly #runtime: FeatureRuntime;

  constructor(runtime: FeatureRuntime) {
    this.#runtime = runtime;
  }

  enqueue(
    request: SpeechRequest,
    options?: SpeechEnqueueOptions,
  ): Promise<string> {
    return this.#runtime.useBundle((bundle) =>
      bundle.speech.enqueue(
        request,
        this.#bundleEnqueueOptions(bundle, options),
      )
    );
  }

  enqueueAudio(
    request: LocalAudioRequest,
    options?: SpeechEnqueueOptions,
  ): Promise<string> {
    return this.#runtime.useBundle((bundle) =>
      bundle.speech.enqueueAudio(
        request,
        this.#bundleEnqueueOptions(bundle, options),
      )
    );
  }

  stop(): Promise<void> {
    return this.#runtime.useOptionalBundle(async (bundle) => {
      await bundle?.speech.stop();
    });
  }

  status(): SpeechStatus {
    return this.#runtime.currentBundle()?.speech.status() ?? {
      state: "stopped",
      queued: 0,
    };
  }

  dispose(): Promise<void> {
    return this.#runtime.useOptionalBundle(async (bundle) => {
      await bundle?.speech.dispose();
    });
  }

  #bundleEnqueueOptions(
    bundle: FeatureBundle,
    options: SpeechEnqueueOptions | undefined,
  ): SpeechEnqueueOptions {
    const admissionSignal = bundle.admissionController.signal;
    const callerSignal = options?.signal;
    return {
      ...options,
      signal:
        callerSignal === undefined || callerSignal === admissionSignal
          ? admissionSignal
          : AbortSignal.any([callerSignal, admissionSignal]),
    };
  }
}

class FeatureAnalyticsProxy implements OperatorAnalyticsService {
  readonly #runtime: FeatureRuntime;

  constructor(runtime: FeatureRuntime) {
    this.#runtime = runtime;
  }

  isAvailable(): Promise<boolean> {
    return this.#runtime.useOptionalBundle(
      (bundle) => bundle?.analytics !== undefined,
    );
  }

  commentWordFrequency(options?: {
    readonly limit?: number;
    readonly sampleLimit?: number;
  }) {
    return this.#runtime.useBundle((bundle) => {
      const analytics = bundle.analytics;
      if (analytics === undefined) {
        throw new Error("Analytics is disabled because SQLite persistence is disabled");
      }
      return analytics.commentWordFrequency(options);
    });
  }

  integralRanking(metric?: IntegralRankingMetric, requestedLimit?: number) {
    return this.#runtime.useBundle((bundle) => {
      const analytics = bundle.analytics;
      if (analytics === undefined) {
        throw new Error("Analytics is disabled because SQLite persistence is disabled");
      }
      return analytics.integralRanking(metric, requestedLimit);
    });
  }

  giftAggregates(requestedLimit?: number) {
    return this.#runtime.useBundle((bundle) => {
      const analytics = bundle.analytics;
      if (analytics === undefined) {
        throw new Error("Analytics is disabled because SQLite persistence is disabled");
      }
      return analytics.giftAggregates(requestedLimit);
    });
  }
}

function hasSubscriptions(
  publisher: ApplicationFactoryContext["publisher"],
): publisher is OperatorEventBus {
  return typeof publisher.subscribe === "function";
}

class FeatureRuntime {
  readonly #context: ApplicationFactoryContext;
  readonly #options: FullApplicationOptions;
  readonly #dependencies: FullApplicationDependencies;
  readonly #events: OperatorEventBus;
  readonly executor: FeatureAgentExecutor;
  readonly speech: FeatureSpeechService;
  readonly analytics: FeatureAnalyticsProxy;

  #bundle: FeatureBundle | undefined;
  #committedSnapshot: JsonObject;
  #transition: Promise<void> = Promise.resolve();
  #releaseTransition: (() => void) | undefined;
  #running = false;
  #generation = 0;
  #acceptingLeases = false;
  #activeLeases = 0;
  #leaseDrainWaiters: Array<() => void> = [];

  private constructor(
    context: ApplicationFactoryContext,
    options: FullApplicationOptions,
    dependencies: FullApplicationDependencies,
    events: OperatorEventBus,
    snapshot: JsonObject,
  ) {
    this.#context = context;
    this.#options = options;
    this.#dependencies = dependencies;
    this.#events = events;
    this.#committedSnapshot = structuredClone(snapshot);
    this.executor = new FeatureAgentExecutor(this);
    this.speech = new FeatureSpeechService(this);
    this.analytics = new FeatureAnalyticsProxy(this);
  }

  static create(
    context: ApplicationFactoryContext,
    options: FullApplicationOptions,
  ): FeatureRuntime {
    const events = context.publisher;
    if (!hasSubscriptions(events)) {
      throw new TypeError(
        "The full application requires an event bus with subscribe()",
      );
    }
    const dependencies = options.features === false ? {} : options.features ?? {};
    return new FeatureRuntime(
      context,
      options,
      dependencies,
      events,
      context.config.snapshot(),
    );
  }

  preparation(): ApplicationPreparation {
    const managesPrimary =
      this.#options.services?.platform === undefined &&
      this.#options.factories?.platform === undefined;
    const serverFactory =
      this.#options.services?.server === undefined &&
      this.#options.factories?.server === undefined
        ? {
            server: (context: ApplicationFactoryContext) => {
              return createOperatorServer(
                {
                  configStore: context.config,
                  eventSubmitter: {
                    submit: (event, submitOptions) =>
                      context.controls.processEvent(event, submitOptions),
                  },
                  runtime: context.controls,
                  speech: this.speech,
                  events: this.#events,
                  authorizeRequest: (request, localBearer) =>
                    this.authorizeRequest(request, localBearer),
                  analytics: this.analytics,
                  avatar: {
                    status: () => this.useBundle((bundle) => this.avatarStatus(bundle)),
                    camera: (action) => this.useBundle(async (bundle) => {
                      if (action === "stop") {
                        await bundle.outputs.avatarCamera.stop();
                      } else {
                        const origin = bundle.outputs.live2dServer.origin;
                        if (!bundle.outputs.live2dServer.enabled || origin === undefined) {
                          throw new Error("请先启用 Live2D 并重新载入运行配置");
                        }
                        await bundle.outputs.avatarCamera.start(
                          `${origin}/Live2D/?camera=1`,
                          bundle.admissionController.signal,
                        );
                      }
                      return this.avatarStatus(bundle);
                    }),
                    handleRequest: (request, response) => this.useBundle((bundle) =>
                      bundle.outputs.live2dServer.handleRequest(request, response, "/avatar/Live2D/")),
                  },
                  onPlaybackCallback: (callback) =>
                    this.useOptionalBundle(async (bundle) => {
                      if (bundle === undefined) {
                        return;
                      }
                      const status = bundle.playback.applyCallback(callback);
                      const automation = context.components["automation"] as
                        | RuntimeAutomation
                        | undefined;
                      automation?.notePlaybackQueue?.(status.waitPlayAudio);
                    }),
                  logger: context.logger,
                },
                {
                  applicationRoot: context.cwd,
                  webRoot: resolve(context.cwd, "web"),
                },
              );
            },
          }
        : {};
    const platform = stringValue(this.#committedSnapshot["platform"], "talk");
    const stdin =
      this.#options.stdin ??
      (managesPrimary && platform === "talk" ? true : undefined);

    return {
      manageExecutorLifecycle: false,
      services: {
        executor: this.executor,
        speech: this.speech,
        ...(managesPrimary ? { platform: null, platformRegistry: null } : {}),
        extensions: {
          featureRuntime: this,
          analytics: this.analytics,
        },
      },
      factories: serverFactory,
      processor: {
        middleware: [(context) => this.runMiddleware(context)],
      },
      plugins: [this.lifecyclePlugin()],
      ...(stdin === undefined ? {} : { stdin }),
      dispose: async () => this.dispose(),
    };
  }

  currentBundle(): FeatureBundle | undefined {
    return this.#bundle;
  }

  async leaseBundle(): Promise<FeatureBundleLease> {
    while (this.#releaseTransition !== undefined) {
      await this.#transition;
    }
    const bundle = this.#bundle;
    if (!this.#acceptingLeases || bundle === undefined) {
      throw new Error("Full application feature runtime is not active");
    }
    this.#activeLeases += 1;
    let released = false;
    return {
      bundle,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#releaseLease();
      },
    };
  }

  async useBundle<T>(
    operation: (bundle: FeatureBundle) => T | Promise<T>,
  ): Promise<T> {
    const lease = await this.leaseBundle();
    try {
      return await operation(lease.bundle);
    } finally {
      lease.release();
    }
  }

  async useOptionalBundle<T>(
    operation: (bundle: FeatureBundle | undefined) => T | Promise<T>,
  ): Promise<T> {
    while (this.#releaseTransition !== undefined) {
      await this.#transition;
    }
    const bundle = this.#bundle;
    if (!this.#acceptingLeases || bundle === undefined) {
      return await operation(undefined);
    }
    this.#activeLeases += 1;
    let released = false;
    try {
      return await operation(bundle);
    } finally {
      if (!released) {
        released = true;
        this.#releaseLease();
      }
    }
  }

  lifecyclePlugin(): LifecyclePlugin {
    return {
      name: "features",
      order: LifecycleOrder.extension,
      start: (context) => this.start(context),
      reload: (context) => this.reload(context),
      stop: () => this.stop(),
      status: () => this.status(),
    };
  }

  async start(context: ApplicationContext): Promise<void> {
    if (this.#running) {
      return;
    }
    let bundle = this.#bundle;
    try {
      bundle ??= await this.#buildBundle(this.#committedSnapshot);
      context.signal.throwIfAborted();
      this.#bundle = bundle;
      this.#running = true;
      this.#acceptingLeases = true;
      await this.#activateBundle(bundle, context);
      context.signal.throwIfAborted();
      if (this.#bundle !== bundle || !this.#running) {
        throw context.signal.reason ??
          new DOMException("Feature runtime startup was cancelled", "AbortError");
      }
      this.#generation += 1;
    } catch (error) {
      this.#acceptingLeases = false;
      this.#running = false;
      if (this.#bundle === bundle) {
        this.#bundle = undefined;
      }
      const cleanupErrors =
        bundle === undefined ? [] : await this.#disposeBundle(bundle, true);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Feature runtime startup and cleanup failed",
        );
      }
      throw error;
    }
  }

  async reload(context: ApplicationContext): Promise<void> {
    if (!this.#running) {
      throw new Error("Cannot reload an inactive full application feature runtime");
    }
    const previous = this.#bundle;
    const nextSnapshot = this.#context.config.snapshot();
    if (
      previous !== undefined &&
      isDeepStrictEqual(nextSnapshot, this.#committedSnapshot)
    ) {
      return;
    }

    this.#beginTransition();
    let candidate: FeatureBundle | undefined;
    let previousTouched = false;
    try {
      candidate = await this.#buildBundle(nextSnapshot);
      context.signal.throwIfAborted();
      if (previous !== undefined) {
        previousTouched = true;
        try {
          await this.#stopBundleSpeech(previous, false);
        } catch {
          // Disposal records the failure after all leases have had a chance to drain.
        }
        await this.#drainLeases();
        const retirementErrors = await this.#disposeBundle(previous, false);
        if (retirementErrors.length > 0) {
          throw new AggregateError(
            retirementErrors,
            "Failed to retire the previous feature bundle",
          );
        }
      }

      this.#bundle = candidate;
      await this.#activateBundle(candidate, context);
      context.signal.throwIfAborted();
      this.#committedSnapshot = structuredClone(nextSnapshot);
      this.#generation += 1;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (candidate !== undefined) {
        cleanupErrors.push(...await this.#disposeBundle(candidate, false));
      }
      if (previousTouched) {
        if (previous !== undefined) {
          cleanupErrors.push(...await this.#disposeBundle(previous, false));
        }
        this.#bundle = undefined;
      } else {
        this.#bundle = previous;
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Feature reload and cleanup failed",
        );
      }
      throw error;
    } finally {
      this.#endTransition();
    }
  }

  async stop(): Promise<void> {
    if (!this.#running && this.#bundle === undefined) {
      return;
    }
    this.#beginTransition();
    const bundle = this.#bundle;
    this.#bundle = undefined;
    this.#running = false;
    try {
      if (bundle !== undefined) {
        try {
          await this.#stopBundleSpeech(bundle, true);
        } catch {
          // Disposal records the failure after all leases have had a chance to drain.
        }
        await this.#drainLeases();
        const errors = await this.#disposeBundle(bundle, true);
        if (errors.length > 0) {
          throw new AggregateError(errors, "Feature runtime cleanup failed");
        }
      }
    } finally {
      this.#endTransition();
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
  }


  private avatarStatus(bundle: FeatureBundle): OperatorAvatarStatus {
    const live2d = bundle.outputs.live2dServer;
    return {
      enabled: live2d.enabled,
      modelName: stringValue(recordValue(bundle.snapshot["live2d"])["name"], "Hiyori"),
      previewUrl: live2d.enabled && live2d.origin !== undefined ? "/avatar/Live2D/" : null,
      camera: bundle.outputs.avatarCamera.status(),
    };
  }
  status(): Readonly<Record<string, unknown>> {
    const bundle = this.#bundle;
    return {
      state:
        bundle === undefined
          ? this.#running
            ? "failed"
            : "stopped"
          : this.#running
            ? "running"
            : "stopped",
      generation: this.#generation,
      database: {
        enabled: bundle?.repository !== undefined,
        ...(bundle?.repository === undefined
          ? {}
          : { path: bundle.repository.path }),
      },
      analytics: { enabled: bundle?.analytics !== undefined },
      tools: bundle?.tools.map((tool) => tool.name) ?? [],
      sources: bundle?.sources.map((source) => source.name) ?? [],
      output: {
        visualBody: bundle?.outputs.visualBody?.bridge.name ?? null,
        live2d: bundle?.outputs.live2dServer.enabled ?? false,
        avatarCamera: bundle?.outputs.avatarCamera.status() ?? null,
        virtualMicrophone: bundle?.outputs.virtualMicrophone !== undefined,
      },
      playback: bundle?.playback.status ?? {
        waitPlayAudio: 0,
        waitSynthesisMessages: 0,
        activeSpeechIds: [],
      },
      ums: bundle?.ums.status() ?? {
        enabled: false,
        state: "disabled",
        authenticated: false,
      },
    };
  }

  async authorizeRequest(
    request: IncomingMessage,
    localBearer: LocalBearerAuthorization,
  ): Promise<boolean> {
    if (!localBearer.authorized) {
      return false;
    }
    try {
      return await this.useOptionalBundle(async (bundle) => {
        const ums = bundle?.ums;
        if (ums === undefined || !ums.status().enabled) {
          return true;
        }
        const authorize = ums.createRequestAuthorizer(() => localBearer);
        return await authorize(request);
      });
    } catch {
      return false;
    }
  }

  private runMiddleware(
    initialContext: EventProcessingContext,
  ): Promise<EventMiddlewareResult | undefined> {
    return this.useBundle(async (bundle) => {
      let event = initialContext.event;
      for (const middleware of bundle.middleware) {
        const result = await middleware({ ...initialContext, event });
        if (result === undefined) {
          continue;
        }
        if (result.type === "drop" || result.type === "reply") {
          return result;
        }
        if (result.event !== undefined) {
          event = result.event;
        }
      }
      return event === initialContext.event
        ? undefined
        : { type: "continue", event };
    });
  }

  async #buildBundle(snapshot: JsonObject): Promise<FeatureBundle> {
    const dependencies = this.#dependencies;
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    const contentFetch = dependencies.contentFetch ?? defaultContentFetch;
    let repository: SqliteRepository | undefined;
    let actions: ActionServiceBundle | undefined;
    let outputs: LegacyOutputAdapters | undefined;
    let audioSink: AudioSink | undefined;
    let executor: AgentExecutor | undefined;
    let imageExecutor: AgentExecutor | undefined;
    let speech: SpeechService | undefined;
    let admissionController: AbortController | undefined;
    let subscribers: readonly AppEventSubscriber[] = [];
    let sources: readonly EventSource[] = [];
    let ums: LegacyUmsService | undefined;

    try {
      if (databaseEnabled(snapshot)) {
        const configuredPath = recordValue(snapshot["database"])["path"];
        const path = configuredPath === ":memory:"
          ? ":memory:"
          : resolve(
              this.#context.cwd,
              stringValue(configuredPath, "data/data.db"),
            );
        repository = (dependencies.createRepository ?? ((value) => new SqliteRepository(value)))(path);
      }
      const analytics = repository === undefined
        ? undefined
        : new AnalyticsService(repository);
      const engagement = repository === undefined
        ? undefined
        : createEngagementMiddleware({
            repository,
            ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
            ...(this.#options.random === undefined
              ? {}
              : { random: this.#options.random }),
          });

      const searchConfig = mapOnlineSearchConfig(snapshot);
      const search = new BoundedOnlineSearchService(searchConfig.service, {
        fetch: contentFetch,
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      });

      outputs = (
        dependencies.createOutputAdapters ?? createLegacyOutputAdapters
      )(
        snapshot,
        {
          ...(dependencies.output ?? {}),
          projectRoot: this.#context.cwd,
          fetch: fetchImpl,
          publisher: this.#context.publisher,
        },
      );
      const speechSettings = resolveSpeechRuntimeSettings(snapshot, this.#context.cwd);
      const primaryAudioSink = !speechSettings.playbackEnabled
        ? new NoopAudioSink()
        : outputs.visualBody === undefined
          ? new ExternalAudioSink(speechSettings.player)
          : new ExternalVisualAudioSink(outputs.visualBody.bridge);
      audioSink = outputs.virtualMicrophone === undefined
        ? primaryAudioSink
        : new MirroredAudioSink(
            primaryAudioSink,
            outputs.virtualMicrophone,
          );

      const createActions = dependencies.createActionServices ?? createActionServices;
      actions = createActions(snapshot, dependencies.actions);

      const tools = [
        ...createContentTools({
          ...(searchConfig.enabled
            ? { search, searchLimits: searchConfig.service }
            : {}),
        }),
        ...createActionTools(actions.runtime),
        ...(dependencies.pi?.tools ?? []),
      ];

      const ownsExecutor = this.#options.services?.executor === undefined;
      if (this.#options.services?.executor !== undefined) {
        executor = this.#options.services.executor;
      } else if (this.#options.factories?.executor !== undefined) {
        executor = await this.#options.factories.executor(
          this.#factoryContext(snapshot, {
            agentTools: tools,
            actionServices: actions,
            contentServices: { search },
          }),
        );
      } else {
        executor = createPiAgentExecutor(snapshot, {
          ...(dependencies.pi ?? {}),
          publisher: this.#context.publisher,
          tools,
        });
      }
      if (recordValue(snapshot["image_recognition"])["enable"] === true) {
        const imageOptions = {
          ...imageAgentOptions(dependencies.pi),
          publisher: this.#context.publisher,
        };
        if (!primaryAgentSupportsImage(snapshot, imageOptions)) {
          imageExecutor = (
            dependencies.createImageExecutor ?? createImageAgentExecutor
          )(snapshot, imageOptions);
        }
      }

      const ownsSpeech = this.#options.services?.speech === undefined;
      if (this.#options.services?.speech !== undefined) {
        speech = this.#options.services.speech;
      } else if (this.#options.factories?.speech !== undefined) {
        speech = await this.#options.factories.speech(
          this.#factoryContext(snapshot, {
            audioSink,
            postProcessors: outputs.svcPostProcessors,
          }),
        );
      } else {
        speech = createSpeechService({
          config: { snapshot: () => structuredClone(snapshot) },
          publisher: this.#context.publisher,
          cwd: this.#context.cwd,
          fetch: fetchImpl,
          sink: audioSink,
          postProcessors: outputs.svcPostProcessors,
          ...(this.#options.now === undefined
            ? {}
            : { clock: this.#options.now }),
        });
      }

      const playAudio = recordValue(snapshot["play_audio"]);
      const playback = new PlaybackStatusSubscriber({
        callback: playAudio["info_to_callback"] === true
          ? {
              enabled: true,
              send: async (callback) => {
                const status = playback.applyCallback(callback);
                const automation = this.#context.components["automation"] as
                  | RuntimeAutomation
                  | undefined;
                automation?.notePlaybackQueue?.(status.waitPlayAudio);
              },
            }
          : undefined,
        publisher: this.#context.publisher,
        ...(this.#options.now === undefined
          ? {}
          : { clock: this.#options.now }),
      });
      admissionController = new AbortController();

      subscribers = this.#createSubscribers(
        snapshot,
        outputs,
        playback,
      );
      sources = await this.#createSources(snapshot);
      const login = legacyUmsConfig(snapshot);
      let bundleReference: FeatureBundle | undefined;
      ums = new LegacyUmsService(login, {
        ...(dependencies.ums ?? {}),
        fetch: fetchImpl,
        stop: () => {
          if (this.#running && this.#bundle === bundleReference) {
            queueMicrotask(() => void this.#context.controls.stop());
          }
        },
        publishStatus: (status) => {
          this.#context.publisher.publish({
            type: "system.status",
            component: "security.legacy-ums",
            status: status.authenticated
              ? "ready"
              : status.enabled
                ? "error"
                : "stopped",
            metadata: { ...status },
            timestamp: this.#options.now?.() ?? Date.now(),
          });
        },
      });

      const middleware = engagement === undefined ? [] : [engagement];
      const bundle: FeatureBundle = {
        snapshot: structuredClone(snapshot),
        ...(repository === undefined ? {} : { repository }),
        ...(analytics === undefined ? {} : { analytics }),
        actions,
        outputs,
        audioSink,
        playback,
        subscribers,
        middleware,
        tools,
        executor,
        ...(imageExecutor === undefined ? {} : { imageExecutor }),
        ownsExecutor,
        speech,
        ownsSpeech,
        sources,
        ums,
        admissionController,
        subscription: undefined,
        speechStop: undefined,
        sourceDisposal: undefined,
        detachSignal: undefined,
        disposal: undefined,
      };
      bundleReference = bundle;
      return bundle;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      const attempt = async (
        operation: (() => void | Promise<void>) | undefined,
      ): Promise<void> => {
        if (operation === undefined) {
          return;
        }
        try {
          await operation();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      };
      admissionController?.abort(
        new DOMException("Feature bundle construction failed", "AbortError"),
      );
      for (const source of [...sources].reverse()) {
        await attempt(() => source.dispose());
      }
      for (const subscriber of [...subscribers].reverse()) {
        await attempt(
          subscriber.dispose === undefined
            ? undefined
            : () => subscriber.dispose!(),
        );
      }
      await attempt(
        outputs === undefined
          ? undefined
          : () => outputs!.avatarCamera.dispose(),
      );
      await attempt(
        outputs === undefined
          ? undefined
          : () => outputs!.live2dServer.dispose(),
      );
      await attempt(ums === undefined ? undefined : () => ums!.dispose());
      if (speech !== undefined && speech !== this.#options.services?.speech) {
        await attempt(() => speech!.dispose());
      }
      if (imageExecutor !== undefined) {
        await attempt(() => imageExecutor!.reset());
      }
      if (
        executor !== undefined &&
        executor !== imageExecutor &&
        executor !== this.#options.services?.executor
      ) {
        await attempt(() => executor!.reset());
      }
      await attempt(
        audioSink?.dispose === undefined
          ? undefined
          : () => audioSink!.dispose!(),
      );
      await attempt(
        repository === undefined ? undefined : () => repository!.dispose(),
      );
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Feature bundle construction and cleanup failed",
        );
      }
      throw error;
    }
  }

  #factoryContext(
    snapshot: JsonObject,
    additions: Readonly<Record<string, unknown>>,
  ): ApplicationFactoryContext {
    return {
      ...this.#context,
      components: {
        ...this.#context.components,
        config: structuredClone(snapshot),
        ...additions,
      },
    };
  }

  async #createSources(snapshot: JsonObject): Promise<readonly EventSource[]> {
    const managesPrimary =
      this.#options.platform !== false &&
      this.#options.services?.platform === undefined &&
      this.#options.factories?.platform === undefined;
    if (!managesPrimary) {
      return [];
    }
    const configuredPlatform = snapshot["platform"];
    if (configuredPlatform === undefined) {
      return [];
    }
    const platform =
      typeof configuredPlatform === "string"
        ? configuredPlatform
        : String(configuredPlatform);
    if (platform === "talk") {
      return [];
    }
    assertPlatformAvailable(platform);
    const registry = await this.#platformRegistry();
    return [registry.create(platform, snapshot)];
  }

  async #platformRegistry(): Promise<PlatformRegistry> {
    if (this.#dependencies.platformRegistry !== undefined) {
      return this.#dependencies.platformRegistry;
    }
    const configured = this.#options.services?.platformRegistry;
    if (configured !== undefined && configured !== null) {
      return configured;
    }
    if (this.#options.factories?.platformRegistry !== undefined) {
      return this.#options.factories.platformRegistry(this.#context);
    }
    return createDefaultPlatformRegistry({
      onError: (error: Error) => {
        this.#context.logger.error(`Platform failed: ${error.message}`, { error });
      },
    });
  }

  #createSubscribers(
    snapshot: JsonObject,
    outputs: LegacyOutputAdapters,
    playback: PlaybackStatusSubscriber,
  ): readonly AppEventSubscriber[] {
    const coordination = recordValue(snapshot["coordination_callback"]);
    return [
      new ReplyForwardingSubscriber([]),
      new CaptionSubscriber(outputs.renderedCaptions, outputs.rawCaptions),
      playback,
      new Live2dMessageSubscriber(outputs.live2dServer),
      new CoordinationCallbackSubscriber(
        {
          enabled: coordination["enable"] === true,
          ...(stringList(coordination["event_types"]).length === 0
            ? {}
            : {
                eventTypes: stringList(
                  coordination["event_types"],
                ) as AppEvent["type"][],
              }),
        },
        outputs.coordinationCallback,
      ),
    ];
  }

  async #activateBundle(
    bundle: FeatureBundle,
    context: ApplicationContext,
  ): Promise<void> {
    const leasedSubscribers = bundle.subscribers.map<AppEventSubscriber>(
      (subscriber) => ({
        name: subscriber.name,
        handle: (event) => this.#handleSubscriber(bundle, subscriber, event),
        ...(subscriber.dispose === undefined
          ? {}
          : { dispose: () => subscriber.dispose!() }),
      }),
    );
    bundle.subscription = subscribeOutputSubscribers(
      this.#events,
      leasedSubscribers,
      {
        publisher: this.#context.publisher,
        ...(this.#options.now === undefined
          ? {}
          : { clock: this.#options.now }),
      },
    );

    const disposeSourcesOnAbort = (): void => {
      void this.#disposeSources(bundle);
    };
    context.signal.addEventListener("abort", disposeSourcesOnAbort, {
      once: true,
    });
    bundle.detachSignal = () => {
      context.signal.removeEventListener("abort", disposeSourcesOnAbort);
    };
    if (context.signal.aborted) {
      disposeSourcesOnAbort();
      context.signal.throwIfAborted();
    }

    const umsStatus = await bundle.ums.start(context.signal);
    if (umsStatus.enabled && !umsStatus.authenticated) {
      throw new Error(
        `Legacy UMS account gate failed: ${umsStatus.failureCode ?? umsStatus.state}`,
      );
    }
    context.signal.throwIfAborted();
    await bundle.outputs.live2dServer.start(context.signal);
    const cameraConfig = recordValue(recordValue(bundle.snapshot["live2d"])["camera"]);
    if (cameraConfig["auto_start"] === true) {
      const origin = bundle.outputs.live2dServer.origin;
      if (origin === undefined) {
        throw new Error("Live2D must be enabled before auto-starting its virtual camera");
      }
      await bundle.outputs.avatarCamera.start(`${origin}/Live2D/?camera=1`, context.signal);
    }
    context.signal.throwIfAborted();
    await Promise.all(
      bundle.sources.map(async (source) => {
        await waitForSignal(
          Promise.resolve(
            source.start(async (event) => {
              await this.#handleSourceEvent(bundle, context, event);
            }),
          ),
          context.signal,
        );
      }),
    );
  }

  #disposeBundle(
    bundle: FeatureBundle,
    final: boolean,
  ): Promise<unknown[]> {
    bundle.disposal ??= this.#disposeBundleOnce(bundle, final);
    return bundle.disposal;
  }

  async #disposeBundleOnce(
    bundle: FeatureBundle,
    final: boolean,
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    await attempt(() => this.#stopBundleSpeech(bundle, final));
    bundle.detachSignal?.();
    bundle.detachSignal = undefined;
    errors.push(...await this.#disposeSources(bundle));
    await attempt(() => bundle.outputs.avatarCamera.dispose());
    await attempt(() => bundle.outputs.live2dServer.dispose());
    await attempt(() => bundle.ums.dispose());
    if (bundle.subscription !== undefined) {
      const subscription = bundle.subscription;
      bundle.subscription = undefined;
      await attempt(() => subscription.dispose());
    }
    if (bundle.ownsSpeech || final) {
      await attempt(() => bundle.speech.dispose());
    }
    if (
      (bundle.ownsExecutor || final) &&
      bundle.executor !== bundle.imageExecutor
    ) {
      await attempt(() => bundle.executor.reset());
    }
    if (bundle.imageExecutor !== undefined) {
      await attempt(() => bundle.imageExecutor!.reset());
    }
    await attempt(async () => {
      await bundle.audioSink.dispose?.();
    });
    if (bundle.repository !== undefined) {
      await attempt(() => bundle.repository!.dispose());
    }
    return errors;
  }

  #stopBundleSpeech(
    bundle: FeatureBundle,
    final: boolean,
  ): Promise<void> {
    bundle.admissionController.abort(
      new DOMException("Feature bundle is retiring", "AbortError"),
    );
    if (!bundle.ownsSpeech && !final) {
      return Promise.resolve();
    }
    bundle.speechStop ??= Promise.resolve().then(async () => {
      await bundle.speech.stop();
    });
    return bundle.speechStop;
  }

  #disposeSources(bundle: FeatureBundle): Promise<unknown[]> {
    bundle.sourceDisposal ??= (async () => {
      const errors: unknown[] = [];
      await Promise.all(
        [...bundle.sources].reverse().map(async (source) => {
          try {
            await source.dispose();
          } catch (error) {
            errors.push(error);
          }
        }),
      );
      return errors;
    })();
    return bundle.sourceDisposal;
  }

  async #handleSubscriber(
    bundle: FeatureBundle,
    subscriber: AppEventSubscriber,
    event: AppEvent,
  ): Promise<void> {
    const release = this.#tryAcquireBundle(bundle);
    if (release === undefined) {
      return;
    }
    try {
      await subscriber.handle(event);
    } finally {
      release();
    }
  }

  async #handleSourceEvent(
    bundle: FeatureBundle,
    context: ApplicationContext,
    event: LiveEvent,
  ): Promise<void> {
    const release = this.#tryAcquireBundle(bundle);
    if (release === undefined) {
      throw new Error("Cannot process a source event during a feature transition");
    }
    try {
      context.signal.throwIfAborted();
      await context.processEvent(event);
    } finally {
      release();
    }
  }

  #tryAcquireBundle(bundle: FeatureBundle): (() => void) | undefined {
    if (!this.#acceptingLeases || this.#bundle !== bundle) {
      return undefined;
    }
    this.#activeLeases += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#releaseLease();
    };
  }

  #releaseLease(): void {
    this.#activeLeases -= 1;
    if (this.#activeLeases !== 0) {
      return;
    }
    const waiters = this.#leaseDrainWaiters;
    this.#leaseDrainWaiters = [];
    for (const resolveDrain of waiters) {
      resolveDrain();
    }
  }

  #drainLeases(): Promise<void> {
    if (this.#activeLeases === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolveDrain) => {
      this.#leaseDrainWaiters.push(resolveDrain);
    });
  }

  #beginTransition(): void {
    if (this.#releaseTransition !== undefined) {
      throw new Error("A feature runtime transition is already active");
    }
    this.#acceptingLeases = false;
    this.#transition = new Promise<void>((resolveTransition) => {
      this.#releaseTransition = resolveTransition;
    });
  }

  #endTransition(): void {
    const release = this.#releaseTransition;
    this.#acceptingLeases = this.#running && this.#bundle !== undefined;
    this.#releaseTransition = undefined;
    release?.();
    this.#transition = Promise.resolve();
  }
}

function waitForSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("Operation aborted", "AbortError"),
    );
  }
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      cleanup();
      rejectOperation(
        signal.reason ?? new DOMException("Operation aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolveOperation(value);
      },
      (error: unknown) => {
        cleanup();
        rejectOperation(error);
      },
    );
  });
}

export async function createFullApplication(
  options: FullApplicationOptions = {},
) {
  if (options.features === false) {
    return createCoreApplication(options);
  }
  return createCoreApplication(options, async (context) => {
    const runtime = await FeatureRuntime.create(context, options);
    return runtime.preparation();
  });
}

function recordValue(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function stringValue(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}


function legacyUmsConfig(snapshot: JsonObject): LegacyUmsLoginConfig {
  const login = recordValue(snapshot["login"]);
  const username = optionalString(login["username"]);
  const password = optionalString(login["password"]);
  const apiUrl = optionalString(login["ums_api"]);
  const checkInterval = numberValue(login["check_interval_seconds"]);
  const timeout = numberValue(login["request_timeout_ms"]);
  const maximumBytes = numberValue(login["max_response_bytes"]);
  return {
    enable: login["enable"] === true,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    ...(apiUrl === undefined ? {} : { ums_api: apiUrl }),
    ...(checkInterval === undefined
      ? {}
      : { check_interval_seconds: checkInterval }),
    ...(timeout === undefined ? {} : { request_timeout_ms: timeout }),
    ...(maximumBytes === undefined
      ? {}
      : { max_response_bytes: maximumBytes }),
    allow_insecure_development_http:
      login["allow_insecure_development_http"] === true,
  };
}

function databaseEnabled(snapshot: JsonObject): boolean {
  const database = recordValue(snapshot["database"]);
  if (database["enable"] === false) {
    return false;
  }
  const integral = recordValue(snapshot["integral"]);
  const analytics = recordValue(snapshot["data_analysis"]);
  return (
    database["enable"] === true ||
    database["comment_enable"] === true ||
    database["entrance_enable"] === true ||
    database["gift_enable"] === true ||
    integral["enable"] === true ||
    analytics["enable"] === true
  );
}
