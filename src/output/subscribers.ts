import type { EventReplyHook } from "../core/event-processor.js";
import type { ProcessedReply } from "../core/contracts.js";
import type {
  AgentRequest,
  AppEvent,
  Disposable,
  EventPublisher,
  Metadata,
  SpeechRequest,
} from "../domain/types.js";
import {
  asOutputBridgeError,
  OutputBridgeError,
  OutputConfigError,
  publishOutputFailure,
  type OutputClock,
} from "./errors.js";
import type {
  CaptionBridge,
  CaptionUpdate,
} from "./captions.js";
import {
  type CoordinationCallbackBridge,
  type OutputMessageKind,
  type OutputTextMessage,
  type TextOutputBridge,
} from "./bridges.js";
import type { Live2dStaticServer } from "./live2d-server.js";

export interface AppEventSubscriber {
  readonly name: string;
  handle(event: AppEvent): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface AppEventSubscriptionSource {
  subscribe(listener: (event: AppEvent) => void): () => void;
}

export interface OutputSubscriberDependencies {
  readonly publisher?: EventPublisher | undefined;
  readonly clock?: OutputClock | undefined;
  readonly maximumQueuedEvents?: number | undefined;
}

const DEFAULT_MAXIMUM_QUEUED_EVENTS = 128;
const MAXIMUM_QUEUED_EVENTS = 65_536;
const OUTPUT_QUEUE_OVERFLOW_MARKER = "outputSubscriberQueueOverflow";
const IMAGE_DATA_URL = /^\s*data:image\/[^;,]+;base64,/iu;
const BINARY_IMAGE_METADATA_KEYS: Readonly<Record<string, true>> = {
  base64: true,
  dataurl: true,
  image: true,
  imagebase64: true,
  imagedata: true,
  imagedataurl: true,
  images: true,
};

interface RetainedOutputEvent {
  readonly event: AppEvent;
  readonly imageKey: string | undefined;
}

interface SubscriberEventQueue {
  readonly subscriber: AppEventSubscriber;
  readonly events: Array<RetainedOutputEvent | undefined>;
  head: number;
  size: number;
  handling: boolean;
  overflowReported: boolean;
  drain: Promise<void> | undefined;
}


function isBinaryImageMetadata(key: string, value: unknown): boolean {
  const normalizedKey = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (normalizedKey === "imagepath" || normalizedKey === "path") {
    return false;
  }
  return BINARY_IMAGE_METADATA_KEYS[normalizedKey] === true
    || normalizedKey.endsWith("base64")
    || normalizedKey.endsWith("dataurl")
    || normalizedKey.endsWith("datauri")
    || (typeof value === "string" && IMAGE_DATA_URL.test(value));
}

function containsImageMetadata(metadata: Metadata | undefined): boolean {
  if (metadataString(metadata, "eventType", "sourceEventType")?.toLowerCase() === "image") {
    return true;
  }
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (isBinaryImageMetadata(key, value)) {
      return true;
    }
  }
  return false;
}

function binaryFreeMetadata(metadata: Metadata | undefined): Metadata | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const retained: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isBinaryImageMetadata(key, value)) {
      continue;
    }
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      retained[key] = value;
    }
  }
  return retained;
}

function binaryFreeAgentRequest(request: AgentRequest): AgentRequest {
  const metadata = binaryFreeMetadata(request.metadata);
  return {
    sessionId: request.sessionId,
    username: request.username,
    content: request.content,
    ...(request.systemPrompt === undefined
      ? {}
      : { systemPrompt: request.systemPrompt }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function binaryFreeSpeechRequest(request: SpeechRequest): SpeechRequest {
  const metadata = binaryFreeMetadata(request.metadata);
  return {
    text: request.text,
    ...(request.sourceEventId === undefined
      ? {}
      : { sourceEventId: request.sourceEventId }),
    ...(request.outputPath === undefined
      ? {}
      : { outputPath: request.outputPath }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function retainedOutputEvent(event: AppEvent): RetainedOutputEvent {
  if (event.type === "inbound") {
    if (event.event.type !== "image") {
      return { event, imageKey: undefined };
    }
    const sessionId = metadataString(event.event.metadata, "sessionId", "session_id");
    return {
      event: {
        ...event,
        event: {
          ...event.event,
          metadata: binaryFreeMetadata(event.event.metadata) ?? {},
        },
      },
      imageKey: sessionId === undefined ? undefined : `inbound.image:${sessionId}`,
    };
  }

  if (
    event.type === "agent.delta"
    || event.type === "agent.completed"
    || event.type === "agent.error"
  ) {
    if (
      (event.request.images === undefined || event.request.images.length === 0)
      && !containsImageMetadata(event.request.metadata)
    ) {
      return { event, imageKey: undefined };
    }
    const sessionId = event.request.sessionId.trim();
    return {
      event: {
        ...event,
        request: binaryFreeAgentRequest(event.request),
      },
      imageKey: sessionId.length === 0
        ? undefined
        : `${event.type}:${sessionId}`,
    };
  }

  if (
    event.type === "speech.queued"
    || event.type === "speech.started"
    || event.type === "speech.completed"
    || event.type === "speech.error"
  ) {
    if (!containsImageMetadata(event.request.metadata)) {
      return { event, imageKey: undefined };
    }
    const sessionId = metadataString(
      event.request.metadata,
      "sessionId",
      "session_id",
    );
    return {
      event: {
        ...event,
        request: binaryFreeSpeechRequest(event.request),
      },
      imageKey: sessionId === undefined
        ? undefined
        : `${event.type}:${sessionId}`,
    };
  }

  return { event, imageKey: undefined };
}

async function drainSubscriberQueue(
  queue: SubscriberEventQueue,
  dependencies: OutputSubscriberDependencies,
): Promise<void> {
  while (queue.size > 0) {
    const retained = queue.events[queue.head]!;
    queue.handling = true;
    try {
      await queue.subscriber.handle(retained.event);
    } catch (cause) {
      const error = asOutputBridgeError(
        `output.subscriber.${queue.subscriber.name}`,
        cause,
        `${queue.subscriber.name} subscriber failed`,
      );
      publishOutputFailure(dependencies.publisher, error, dependencies.clock);
    } finally {
      queue.events[queue.head] = undefined;
      queue.head = (queue.head + 1) % queue.events.length;
      queue.size -= 1;
      queue.handling = false;
      if (queue.size < queue.events.length) {
        queue.overflowReported = false;
      }
    }
  }
}

function startSubscriberDrain(
  queue: SubscriberEventQueue,
  dependencies: OutputSubscriberDependencies,
): void {
  if (queue.drain !== undefined || queue.size === 0) {
    return;
  }

  const drain = Promise.resolve().then(async () => {
    await drainSubscriberQueue(queue, dependencies);
  });
  queue.drain = drain;
  void drain
    .finally(() => {
      if (queue.drain === drain) {
        queue.drain = undefined;
        startSubscriberDrain(queue, dependencies);
      }
    })
    .catch(() => undefined);
}

function enqueueSubscriberEvent(
  queue: SubscriberEventQueue,
  retained: RetainedOutputEvent,
  dependencies: OutputSubscriberDependencies,
): void {
  const capacity = queue.events.length;
  if (retained.imageKey !== undefined) {
    const firstPendingOffset = queue.handling ? 1 : 0;
    for (let offset = firstPendingOffset; offset < queue.size; offset += 1) {
      const index = (queue.head + offset) % capacity;
      if (queue.events[index]?.imageKey === retained.imageKey) {
        queue.events[index] = retained;
        return;
      }
    }
  }

  if (queue.size >= capacity) {
    if (!queue.overflowReported) {
      queue.overflowReported = true;
      const error = new OutputBridgeError(
        `${queue.subscriber.name} subscriber queue exceeded its ${capacity}-event limit`,
        {
          code: "OUTPUT_REQUEST_FAILED",
          component: `output.subscriber.${queue.subscriber.name}`,
        },
      );
      publishOutputFailure(dependencies.publisher, error, dependencies.clock, {
        [OUTPUT_QUEUE_OVERFLOW_MARKER]: true,
        maximumQueuedEvents: capacity,
        droppedEventType: retained.event.type,
      });
    }
    return;
  }

  const tail = (queue.head + queue.size) % capacity;
  queue.events[tail] = retained;
  queue.size += 1;
  startSubscriberDrain(queue, dependencies);
}

function discardPendingSubscriberEvents(queue: SubscriberEventQueue): void {
  const retainedActiveCount = queue.handling ? 1 : 0;
  for (
    let offset = retainedActiveCount;
    offset < queue.size;
    offset += 1
  ) {
    const index = (queue.head + offset) % queue.events.length;
    queue.events[index] = undefined;
  }
  queue.size = retainedActiveCount;
  if (retainedActiveCount === 0) {
    queue.head = 0;
  }
  queue.overflowReported = false;
}

export function subscribeOutputSubscribers(
  source: AppEventSubscriptionSource,
  subscribers: readonly AppEventSubscriber[],
  dependencies: OutputSubscriberDependencies = {},
): Disposable {
  const maximumQueuedEvents =
    dependencies.maximumQueuedEvents ?? DEFAULT_MAXIMUM_QUEUED_EVENTS;
  if (
    !Number.isSafeInteger(maximumQueuedEvents)
    || maximumQueuedEvents <= 0
    || maximumQueuedEvents > MAXIMUM_QUEUED_EVENTS
  ) {
    throw new OutputConfigError(
      "output.subscribers",
      `maximumQueuedEvents must be an integer between 1 and ${MAXIMUM_QUEUED_EVENTS}`,
    );
  }

  let disposed = false;
  let disposal: Promise<void> | undefined;
  const queues = subscribers.map<SubscriberEventQueue>((subscriber) => ({
    subscriber,
    events: new Array<RetainedOutputEvent | undefined>(maximumQueuedEvents),
    head: 0,
    size: 0,
    handling: false,
    overflowReported: false,
    drain: undefined,
  }));

  const unsubscribe = source.subscribe((event) => {
    if (
      disposed
      || (
        event.type === "system.status"
        && event.metadata?.[OUTPUT_QUEUE_OVERFLOW_MARKER] === true
      )
    ) {
      return;
    }
    const retained = retainedOutputEvent(event);
    for (const queue of queues) {
      enqueueSubscriberEvent(queue, retained, dependencies);
    }
  });

  return {
    dispose() {
      if (disposal !== undefined) {
        return disposal;
      }
      disposed = true;
      unsubscribe();
      for (const queue of queues) {
        discardPendingSubscriberEvents(queue);
      }
      disposal = (async () => {
        await Promise.all(queues.map(async (queue) => {
          while (queue.drain !== undefined) {
            await queue.drain;
          }
        }));
        for (const subscriber of [...subscribers].reverse()) {
          await subscriber.dispose?.();
        }
        for (const queue of queues) {
          queue.events.length = 0;
        }
      })();
      return disposal;
    },
  };
}


function metadataString(metadata: Metadata | undefined, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function completedEventMessage(event: Extract<AppEvent, { readonly type: "agent.completed" }>): OutputTextMessage {
  const eventType = metadataString(event.request.metadata, "eventType", "sourceEventType", "kind") ?? "reply";
  return {
    kind: eventType,
    username: event.request.username,
    content: event.response.text,
    sourceEventId: metadataString(event.request.metadata, "sourceEventId", "eventId"),
    metadata: event.request.metadata,
  };
}

async function forwardText(
  bridges: readonly TextOutputBridge[],
  message: OutputTextMessage,
  signal?: AbortSignal,
): Promise<void> {
  const failures: unknown[] = [];
  for (const bridge of bridges) {
    try {
      await bridge.sendText(message, signal);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "one or more reply output bridges failed");
  }
}

export class ReplyForwardingSubscriber implements AppEventSubscriber {
  readonly name = "reply-forwarding";
  readonly #bridges: readonly TextOutputBridge[];

  constructor(bridges: readonly TextOutputBridge[]) {
    this.#bridges = bridges;
  }

  async handle(event: AppEvent): Promise<void> {
    if (event.type !== "agent.completed") {
      return;
    }
    await forwardText(this.#bridges, completedEventMessage(event));
  }
}

export function createReplyForwardingHook(
  bridges: readonly TextOutputBridge[],
): EventReplyHook {
  return async (reply) => {
    await forwardText(bridges, {
      kind: reply.event.type,
      username: reply.event.username,
      content: reply.text,
      sourceEventId: reply.event.id,
      metadata: reply.event.metadata,
    });
    return reply;
  };
}

export interface CaptionSubscriberConfig {
  readonly updateRawInbound?: boolean | undefined;
}

export class CaptionSubscriber implements AppEventSubscriber {
  readonly name = "captions";
  readonly #rendered: CaptionBridge;
  readonly #raw: CaptionBridge;
  readonly #config: CaptionSubscriberConfig;

  constructor(
    rendered: CaptionBridge,
    raw: CaptionBridge,
    config: CaptionSubscriberConfig = {},
  ) {
    this.#rendered = rendered;
    this.#raw = raw;
    this.#config = config;
  }

  async handle(event: AppEvent): Promise<void> {
    if (event.type === "inbound" && this.#config.updateRawInbound !== false) {
      const caption: CaptionUpdate = {
        content: event.event.content,
        username: event.event.username,
        kind: event.event.type,
        sourceEventId: event.event.id,
      };
      await this.#raw.update(caption);
      return;
    }
    if (event.type === "speech.started") {
      await this.#rendered.update({
        content: event.request.text,
        kind: metadataString(event.request.metadata, "eventType", "sourceEventType"),
        sourceEventId: event.request.sourceEventId,
      });
    }
  }
}

export interface PlaybackCallbackData {
  readonly wait_play_audio_num: number;
  readonly wait_synthesis_msg_num: number;
}

export interface PlaybackCallbackPayload {
  readonly type: "audio_playback_completed";
  readonly data: PlaybackCallbackData;
}

export interface PlaybackStatus {
  readonly waitPlayAudio: number;
  readonly waitSynthesisMessages: number;
  readonly activeSpeechIds: readonly string[];
}

export type PlaybackStatusCallback = Pick<
  CoordinationCallbackBridge,
  "enabled" | "send"
>;

export interface PlaybackStatusSubscriberOptions extends OutputSubscriberDependencies {
  readonly callback?: PlaybackStatusCallback | undefined;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OutputConfigError("output.playback-status", `${field} must be a non-negative integer`);
  }
  return value as number;
}

export function parsePlaybackCallback(value: unknown): PlaybackCallbackPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OutputConfigError("output.playback-status", "playback callback must be an object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record["type"] !== "audio_playback_completed") {
    throw new OutputConfigError("output.playback-status", "playback callback type is unsupported");
  }
  const rawData = record["data"];
  if (rawData === null || typeof rawData !== "object" || Array.isArray(rawData)) {
    throw new OutputConfigError("output.playback-status", "playback callback data must be an object");
  }
  const data = rawData as Readonly<Record<string, unknown>>;
  return {
    type: "audio_playback_completed",
    data: {
      wait_play_audio_num: nonNegativeInteger(data["wait_play_audio_num"], "wait_play_audio_num"),
      wait_synthesis_msg_num: nonNegativeInteger(data["wait_synthesis_msg_num"], "wait_synthesis_msg_num"),
    },
  };
}

export class PlaybackStatusSubscriber implements AppEventSubscriber {
  readonly name = "playback-status";
  readonly #queued = new Set<string>();
  readonly #active = new Set<string>();
  readonly #options: PlaybackStatusSubscriberOptions;
  #externalWaitPlayAudio: number | undefined;
  #externalWaitSynthesis: number | undefined;

  constructor(options: PlaybackStatusSubscriberOptions = {}) {
    this.#options = options;
  }

  get status(): PlaybackStatus {
    return {
      waitPlayAudio: this.#externalWaitPlayAudio ?? this.#queued.size + this.#active.size,
      waitSynthesisMessages: this.#externalWaitSynthesis ?? this.#queued.size,
      activeSpeechIds: [...this.#active],
    };
  }

  applyCallback(value: unknown): PlaybackStatus {
    const callback = parsePlaybackCallback(value);
    this.#externalWaitPlayAudio = callback.data.wait_play_audio_num;
    this.#externalWaitSynthesis = callback.data.wait_synthesis_msg_num;
    return this.status;
  }

  async handle(event: AppEvent): Promise<void> {
    let terminal = false;
    switch (event.type) {
      case "speech.queued":
        this.#queued.add(event.speechId);
        this.#externalWaitPlayAudio = undefined;
        this.#externalWaitSynthesis = undefined;
        break;
      case "speech.started":
        this.#queued.delete(event.speechId);
        this.#active.add(event.speechId);
        this.#externalWaitPlayAudio = undefined;
        this.#externalWaitSynthesis = undefined;
        break;
      case "speech.completed":
      case "speech.error":
        this.#queued.delete(event.speechId);
        this.#active.delete(event.speechId);
        this.#externalWaitPlayAudio = undefined;
        this.#externalWaitSynthesis = undefined;
        terminal = true;
        break;
      default:
        return;
    }

    const status = this.status;
    this.#options.publisher?.publish({
      type: "system.status",
      component: "output.playback-status",
      status: "ready",
      metadata: {
        waitPlayAudio: status.waitPlayAudio,
        waitSynthesisMessages: status.waitSynthesisMessages,
        activeSpeechIds: status.activeSpeechIds,
      },
      timestamp: (this.#options.clock ?? Date.now)(),
    });
    if (terminal && this.#options.callback?.enabled === true) {
      await this.#options.callback.send({
        type: "audio_playback_completed",
        data: {
          wait_play_audio_num: status.waitPlayAudio,
          wait_synthesis_msg_num: status.waitSynthesisMessages,
        },
        timestamp: (this.#options.clock ?? Date.now)(),
      });
    }
  }
}
export class Live2dMessageSubscriber implements AppEventSubscriber {
  readonly name = "live2d-messages";
  readonly #server: Live2dStaticServer;
  readonly #duration: number;

  constructor(server: Live2dStaticServer, duration = 2_000) {
    this.#server = server;
    this.#duration = duration;
  }

  handle(event: AppEvent): void {
    if (event.type === "agent.completed") {
      this.#server.publishMessage(event.response.text, this.#duration);
    }
  }
}


export interface CoordinationCallbackSubscriberConfig {
  readonly enabled: boolean;
  readonly eventTypes?: readonly AppEvent["type"][] | undefined;
}

export class CoordinationCallbackSubscriber implements AppEventSubscriber {
  readonly name = "coordination-callback";
  readonly #config: CoordinationCallbackSubscriberConfig;
  readonly #callback: CoordinationCallbackBridge;

  constructor(
    config: CoordinationCallbackSubscriberConfig,
    callback: CoordinationCallbackBridge,
  ) {
    this.#config = config;
    this.#callback = callback;
  }

  async handle(event: AppEvent): Promise<void> {
    if (!this.#config.enabled || !this.#callback.enabled) {
      return;
    }
    if (
      (this.#config.eventTypes !== undefined && !this.#config.eventTypes.includes(event.type))
      || (
        event.type === "system.status"
        && event.component === "output.coordination-callback"
      )
    ) {
      return;
    }
    await this.#callback.send({
      type: event.type,
      data: { ...event },
      timestamp: event.timestamp,
    });
  }
}

export function processedReplyMessage(reply: ProcessedReply): OutputTextMessage {
  return {
    kind: reply.event.type as OutputMessageKind,
    username: reply.event.username,
    content: reply.text,
    sourceEventId: reply.event.id,
    metadata: reply.event.metadata,
  };
}
