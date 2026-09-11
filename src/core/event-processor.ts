import { dirname } from "node:path";
import { resolvePiAgentMode } from "../agent/provider-resolution.js";
import { parseScheduleConfig } from "../config/schedule.js";
import type { ConfigStore, JsonObject } from "../config/config-store.js";
import type {
  AgentRequest,
  AgentResponse,
  EventPublisher,
  LiveEvent,
  SpeechRequest,
} from "../domain/types.js";
import type {
  AgentExecutor,
  ProcessedReply,
  SpeechService,
} from "./contracts.js";
import {
  ContentFilters,
  expandBracketChoices,
  formatBeijingTime,
  getConfigValue,
  renderTemplate,
  selectDeterministic,
  throwIfAborted,
  toFiniteNumber,
  toStringList,
  waitForWithSignal,
} from "./filters.js";

export interface EventProcessingContext {
  readonly originalEvent: LiveEvent;
  readonly event: LiveEvent;
  readonly sessionId: string;
  readonly config: JsonObject;
  readonly signal?: AbortSignal;
}

export type EventMiddlewareResult =
  | { readonly type: "continue"; readonly event?: LiveEvent }
  | { readonly type: "drop" }
  | {
      readonly type: "reply";
      readonly text: string;
      readonly source?: ProcessedReply["source"];
    };

export type EventMiddleware = (
  context: EventProcessingContext,
) =>
  | EventMiddlewareResult
  | void
  | Promise<EventMiddlewareResult | void>;

export interface EventReplyContext extends EventProcessingContext {
  readonly request: AgentRequest;
  readonly response: AgentResponse;
}

export type EventReplyHook = (
  reply: ProcessedReply,
  context: EventReplyContext,
) => ProcessedReply | undefined | Promise<ProcessedReply | undefined>;

export interface EventProcessorOptions {
  readonly config: Pick<ConfigStore, "path" | "snapshot">;
  readonly executor: AgentExecutor;
  readonly publisher: EventPublisher;
  readonly speech?: SpeechService;
  readonly middleware?: readonly EventMiddleware[];
  readonly replyHooks?: readonly EventReplyHook[];
  readonly cwd?: string;
  readonly now?: () => number;
  readonly maxPendingEvents?: number;
  readonly maxActiveSessions?: number;
}

export interface EventProcessorStatus {
  readonly disposed: boolean;
  readonly pendingEvents: number;
  readonly activeSessions: number;
  readonly maxPendingEvents: number;
  readonly maxActiveSessions: number;
}

export type EventProcessorOverloadResource = "events" | "sessions";

export class EventProcessorOverloadError extends Error {
  readonly code = "EVENT_PROCESSOR_OVERLOAD";
  readonly resource: EventProcessorOverloadResource;
  readonly limit: number;

  constructor(resource: EventProcessorOverloadResource, limit: number) {
    const subject = resource === "events" ? "pending event" : "active session";
    super(`Event processor ${subject} limit of ${limit} was reached`);
    this.name = "EventProcessorOverloadError";
    this.resource = resource;
    this.limit = limit;
  }
}

export interface ProcessEventOptions {
  readonly signal?: AbortSignal;
}

interface MiddlewareContinuation {
  readonly type: "continue";
  readonly event: LiveEvent;
}

interface DraftReply {
  readonly event: LiveEvent;
  readonly text: string;
  readonly source: ProcessedReply["source"];
  readonly request: AgentRequest;
  readonly response: AgentResponse;
  readonly applyReplyTemplate: boolean;
}

type EventAdmissionState = "admitted" | "chained" | "released";

interface EventAdmission {
  readonly sessionId: string;
  state: EventAdmissionState;
}

const SYSTEM_NOTICE_OPEN = "<system-notice>";
const SYSTEM_NOTICE_CLOSE = "<\\system-notice>";

function systemNotice(
  type: "gift" | "entrance" | "follow" | "idle" | "schedule",
  username: string,
  content: string,
): string {
  const payload = JSON.stringify({ type, username, content })
    .replaceAll("<", "\\u003c");
  return `${SYSTEM_NOTICE_OPEN}\n${payload}\n${SYSTEM_NOTICE_CLOSE}`;
}
const DEFAULT_MAX_PENDING_EVENTS = 256;
const DEFAULT_MAX_ACTIVE_SESSIONS = 64;

function positiveIntegerOption(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}



function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function metadataString(event: LiveEvent, key: string): string | undefined {
  const value = event.metadata[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function stableUserId(event: LiveEvent): string | undefined {
  const value = event.metadata.userId;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized;
}

function sessionIdentity(event: LiveEvent): string {
  // An explicit sessionId is an upstream trust boundary. Otherwise namespace
  // stable IDs separately from username fallbacks so they cannot collide.
  const explicit = metadataString(event, "sessionId");
  if (explicit !== undefined) {
    return explicit;
  }
  const userId = stableUserId(event);
  return JSON.stringify(
    userId === undefined
      ? ["username", event.platform, event.username]
      : ["user", event.platform, userId],
  );
}

function chatMode(event: LiveEvent, config: unknown): string {
  const override = metadataString(event, "chatType");
  if (override !== undefined) {
    const normalized = override.toLowerCase();
    return normalized === "disabled" ? "none" : normalized;
  }

  try {
    switch (resolvePiAgentMode(config)) {
      case "llm":
        return "agent";
      case "reread":
        return "reread";
      case "disabled":
        return "none";
    }
  } catch {
    return "none";
  }
}

function imagesFrom(event: LiveEvent): readonly string[] | undefined {
  const configured = event.metadata.images;
  if (!Array.isArray(configured)) {
    return undefined;
  }

  const images = configured.filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return images.length > 0 ? images : undefined;
}

export class EventProcessor {
  readonly #config: Pick<ConfigStore, "path" | "snapshot">;
  readonly #executor: AgentExecutor;
  readonly #publisher: EventPublisher;
  readonly #speech: SpeechService | undefined;
  readonly #middleware: readonly EventMiddleware[];
  readonly #replyHooks: readonly EventReplyHook[];
  readonly #now: () => number;
  readonly #filters: ContentFilters;
  readonly #maxPendingEvents: number;
  readonly #maxActiveSessions: number;
  readonly #admissions = new Set<EventAdmission>();
  readonly #sessionReferences = new Map<string, number>();
  readonly #sessionTails = new Map<string, Promise<void>>();
  #disposed = false;

  constructor(options: EventProcessorOptions) {
    this.#config = options.config;
    this.#executor = options.executor;
    this.#publisher = options.publisher;
    this.#speech = options.speech;
    this.#middleware = options.middleware ?? [];
    this.#replyHooks = options.replyHooks ?? [];
    this.#now = options.now ?? Date.now;
    this.#maxPendingEvents = positiveIntegerOption(
      "maxPendingEvents",
      options.maxPendingEvents,
      DEFAULT_MAX_PENDING_EVENTS,
    );
    this.#maxActiveSessions = positiveIntegerOption(
      "maxActiveSessions",
      options.maxActiveSessions,
      DEFAULT_MAX_ACTIVE_SESSIONS,
    );

    const baseDirectory = options.cwd ?? dirname(options.config.path);
    this.#filters = new ContentFilters(baseDirectory);
  }


  status(): EventProcessorStatus {
    return {
      disposed: this.#disposed,
      pendingEvents: this.#admissions.size,
      activeSessions: this.#sessionReferences.size,
      maxPendingEvents: this.#maxPendingEvents,
      maxActiveSessions: this.#maxActiveSessions,
    };
  }

  reload(): void {
    this.#filters.clearCache();
  }

  process(
    event: LiveEvent,
    options: ProcessEventOptions = {},
  ): Promise<ProcessedReply | undefined> {
    if (this.#disposed) {
      return Promise.reject(new Error("EventProcessor has been disposed"));
    }

    let admission: EventAdmission;
    try {
      admission = this.#admit(sessionIdentity(event));
    } catch (error) {
      return Promise.reject(error);
    }

    try {
      return this.#enqueueOrdered(event, options.signal, admission);
    } catch (error) {
      this.#releaseAdmission(admission);
      return Promise.reject(error);
    }
  }

  #admit(sessionId: string): EventAdmission {
    if (this.#disposed) {
      throw new Error("EventProcessor has been disposed");
    }

    if (this.#admissions.size >= this.#maxPendingEvents) {
      throw new EventProcessorOverloadError("events", this.#maxPendingEvents);
    }

    const sessionReferences = this.#sessionReferences.get(sessionId);
    if (
      sessionReferences === undefined &&
      this.#sessionReferences.size >= this.#maxActiveSessions
    ) {
      throw new EventProcessorOverloadError(
        "sessions",
        this.#maxActiveSessions,
      );
    }

    const admission: EventAdmission = { sessionId, state: "admitted" };
    this.#admissions.add(admission);
    this.#sessionReferences.set(sessionId, (sessionReferences ?? 0) + 1);
    return admission;
  }

  #enqueueOrdered(
    event: LiveEvent,
    signal: AbortSignal | undefined,
    admission: EventAdmission,
  ): Promise<ProcessedReply | undefined> {
    if (this.#disposed) {
      this.#releaseAdmission(admission);
      return Promise.reject(new Error("EventProcessor has been disposed"));
    }
    if (admission.state !== "admitted") {
      return Promise.reject(new Error("Event admission is no longer active"));
    }

    admission.state = "chained";
    const sessionId = admission.sessionId;
    const previous = this.#sessionTails.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(() =>
      this.#processOrdered(event, sessionId, signal),
    );
    const settled = operation.then(
      (value) => {
        this.#releaseAdmission(admission);
        return value;
      },
      (error: unknown) => {
        this.#releaseAdmission(admission);
        throw error;
      },
    );
    const tail = settled.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.#sessionTails.get(sessionId) === tail) {
        this.#sessionTails.delete(sessionId);
      }
    });

    return waitForWithSignal(settled, signal);
  }


  #releaseAdmission(admission: EventAdmission): void {
    if (admission.state === "released") {
      return;
    }

    admission.state = "released";
    this.#admissions.delete(admission);
    const references = this.#sessionReferences.get(admission.sessionId);
    if (references === 1) {
      this.#sessionReferences.delete(admission.sessionId);
    } else if (references !== undefined) {
      this.#sessionReferences.set(admission.sessionId, references - 1);
    }
  }


  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    await Promise.all(this.#sessionTails.values());
    for (const admission of this.#admissions) {
      this.#releaseAdmission(admission);
    }
    this.#sessionTails.clear();
    this.#sessionReferences.clear();
    this.#filters.clearCache();
  }

  async #processOrdered(
    originalEvent: LiveEvent,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ProcessedReply | undefined> {
    throwIfAborted(signal);
    const config = this.#config.snapshot();

    this.#publisher.publish({
      type: "inbound",
      event: originalEvent,
      timestamp: this.#now(),
    });

    const filteredEvent = await this.#filterEvent(originalEvent, config, signal);
    if (filteredEvent === undefined) {
      return undefined;
    }

    const middlewareResult = await this.#runMiddleware(
      originalEvent,
      filteredEvent,
      sessionId,
      config,
      signal,
    );
    if (middlewareResult.type === "drop") {
      return undefined;
    }

    if (middlewareResult.type === "reply") {
      const request = this.#agentRequest(
        middlewareResult.event,
        sessionId,
        middlewareResult.event.content,
        "middleware",
        config,
      );
      return this.#finish(
        {
          event: middlewareResult.event,
          text: middlewareResult.text,
          source: middlewareResult.source,
          request,
          response: {
            text: middlewareResult.text,
            model: "middleware",
            provider: "local",
          },
          applyReplyTemplate: false,
        },
        originalEvent,
        sessionId,
        config,
        signal,
      );
    }

    const event = middlewareResult.event;

    const draft = await this.#route(event, sessionId, config, signal);
    if (draft === undefined) {
      return undefined;
    }

    return this.#finish(draft, originalEvent, sessionId, config, signal);
  }

  async #filterEvent(
    event: LiveEvent,
    config: JsonObject,
    signal?: AbortSignal,
  ): Promise<LiveEvent | undefined> {
    const username = await this.#filters.applyProhibitions(
      event.username,
      config,
      signal,
    );
    if (username === undefined || username.length === 0) {
      return undefined;
    }

    const imageFallback = getConfigValue<unknown>(
      config,
      "image_recognition",
      "prompt",
    );
    const sourceContent =
      event.type === "image" && event.content.length === 0 &&
        typeof imageFallback === "string"
        ? imageFallback
        : event.content;
    const content = await this.#filters.applyProhibitions(
      sourceContent,
      config,
      signal,
    );
    if (content === undefined || content.length === 0) {
      return undefined;
    }
    return { ...event, username, content };
  }

  async #runMiddleware(
    originalEvent: LiveEvent,
    initialEvent: LiveEvent,
    sessionId: string,
    config: JsonObject,
    signal?: AbortSignal,
  ): Promise<
    | MiddlewareContinuation
    | { readonly type: "drop" }
    | {
        readonly type: "reply";
        readonly event: LiveEvent;
        readonly text: string;
        readonly source: ProcessedReply["source"];
      }
  > {
    let event = initialEvent;
    for (const middleware of this.#middleware) {
      throwIfAborted(signal);
      const context: EventProcessingContext = {
        originalEvent,
        event,
        sessionId,
        config,
        ...(signal === undefined ? {} : { signal }),
      };
      const result = await middleware(context);
      throwIfAborted(signal);
      if (result === undefined) {
        continue;
      }

      if (result.type === "drop") {
        return result;
      }
      if (result.type === "reply") {
        return {
          type: "reply",
          event,
          text: result.text,
          source: result.source ?? "command",
        };
      }
      if (result.event !== undefined) {
        event = result.event;
      }
    }

    return { type: "continue", event };
  }

  async #route(
    event: LiveEvent,
    sessionId: string,
    config: JsonObject,
    signal?: AbortSignal,
  ): Promise<DraftReply | undefined> {
    switch (event.type) {
      case "gift":
      case "entrance":
      case "follow":
      case "idle":
      case "schedule":
        return this.#systemNoticeReply(event, sessionId, config, signal);
      case "comment":
      case "talk":
      case "image":
        return this.#conversationReply(event, sessionId, config, signal);
    }
  }

  async #conversationReply(
    event: LiveEvent,
    sessionId: string,
    config: JsonObject,
    signal?: AbortSignal,
  ): Promise<DraftReply | undefined> {

    throwIfAborted(signal);
    if (event.type === "image") {
      return this.#executeAgentReply(
        event,
        sessionId,
        event.content,
        "image_recognition_schedule",
        config,
        signal,
      );
    }

    const mode = chatMode(event, config);
    if (mode === "none") {
      return undefined;
    }

    if (mode === "reread" || mode === "reread_top_priority") {
      const request = this.#agentRequest(
        event,
        sessionId,
        event.content,
        mode,
        config,
      );
      return {
        event,
        text: event.content,
        source: "reread",
        request,
        response: { text: event.content, model: mode, provider: "local" },
        applyReplyTemplate: true,
      };
    }

    const prompt = this.#composePrompt(event.content, event.username, config, event.id);
    return this.#executeAgentReply(
      event,
      sessionId,
      prompt,
      "agent",
      config,
      signal,
    );
  }

  async #executeAgentReply(
    event: LiveEvent,
    sessionId: string,
    content: string,
    mode: string,
    config: JsonObject,
    signal?: AbortSignal,
  ): Promise<DraftReply> {
    const request = this.#agentRequest(
      event,
      sessionId,
      content,
      mode,
      config,
    );
    let response: AgentResponse;
    try {
      response = await this.#executor.execute(
        request,
        signal === undefined ? undefined : { signal },
      );
    } catch (error) {
      this.#publisher.publish({
        type: "agent.error",
        request,
        error: errorMessage(error),
        timestamp: this.#now(),
      });
      throw error;
    }
    throwIfAborted(signal);

    return {
      event,
      text: response.text,
      source: "agent",
      request,
      response,
      applyReplyTemplate: true,
    };
  }

  async #systemNoticeReply(
    event: LiveEvent,
    sessionId: string,
    config: JsonObject,
    signal?: AbortSignal,
  ): Promise<DraftReply | undefined> {
    if (
      event.type !== "gift" &&
      event.type !== "entrance" &&
      event.type !== "follow" &&
      event.type !== "idle" &&
      event.type !== "schedule"
    ) {
      return undefined;
    }
    if (resolvePiAgentMode(config) !== "llm") {
      return undefined;
    }
    let enabled: boolean;
    if (event.type === "schedule") {
      const scheduleId = metadataString(event, "scheduleId");
      enabled =
        event.metadata.source === "schedule" &&
        scheduleId !== undefined &&
        parseScheduleConfig(config.schedule).some(
          (task) => task.enable && task.id === scheduleId,
        );
    } else if (event.type === "idle") {
      enabled = getConfigValue(config, "idle_time_task", "enable") === true;
    } else {
      enabled = getConfigValue(config, "thanks", `${event.type}_enable`) === true;
    }
    if (!enabled) {
      return undefined;
    }
    throwIfAborted(signal);
    return this.#executeAgentReply(
      event,
      sessionId,
      systemNotice(event.type, event.username, event.content),
      "agent",
      config,
      signal,
    );
  }


  #composePrompt(
    content: string,
    username: string,
    config: JsonObject,
    seed: string,
  ): string {
    let promptContent = content;
    if (getConfigValue(config, "comment_template", "enable") === true) {
      const template = getConfigValue<unknown>(
        config,
        "comment_template",
        "copywriting",
      );
      if (typeof template === "string") {
        promptContent = renderTemplate(template, {
          username,
          comment: content,
          cur_time: formatBeijingTime(this.#now()),
        });
        promptContent = expandBracketChoices(promptContent, `${seed}:prompt`);
      }
    }

    const before = getConfigValue<unknown>(config, "before_prompt");
    const after = getConfigValue<unknown>(config, "after_prompt");
    return `${typeof before === "string" ? before : ""}${promptContent}${
      typeof after === "string" ? after : ""
    }`;
  }

  #agentRequest(
    event: LiveEvent,
    sessionId: string,
    content: string,
    mode: string,
    _config: JsonObject,
  ): AgentRequest {
    const metadataSystemPrompt = event.metadata.systemPrompt;
    const systemPrompt =
      typeof metadataSystemPrompt === "string" ? metadataSystemPrompt : undefined;
    const images = imagesFrom(event);

    return {
      sessionId,
      username: event.username,
      content,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(images === undefined ? {} : { images }),
      metadata: {
        ...event.metadata,
        eventId: event.id,
        eventType: event.type,
        platform: event.platform,
        chatType: mode,
      },
    };
  }



  async #finish(
    draft: DraftReply,
    originalEvent: LiveEvent,
    sessionId: string,
    config: JsonObject,
    signal?: AbortSignal,
  ): Promise<ProcessedReply | undefined> {
    throwIfAborted(signal);
    let text = this.#filters.cleanupResponse(draft.text);
    if (text.length === 0) {
      return undefined;
    }

    if (
      draft.applyReplyTemplate &&
      getConfigValue(config, "reply_template", "enable") === true
    ) {
      const templates = toStringList(
        getConfigValue(config, "reply_template", "copywriting"),
      );
      const template = selectDeterministic(templates, draft.event.id) ?? "{data}";
      const maximumUsernameLength = toFiniteNumber(
        getConfigValue(config, "reply_template", "username_max_len"),
      );
      const username =
        maximumUsernameLength === undefined || maximumUsernameLength < 0
          ? draft.event.username
          : Array.from(draft.event.username)
              .slice(0, Math.floor(maximumUsernameLength))
              .join("");
      text = renderTemplate(template, {
        username,
        data: text,
        cur_time: formatBeijingTime(this.#now()),
      });
      text = expandBracketChoices(text, `${draft.event.id}:reply-template`);
    }

    const allowed = await this.#filters.applyProhibitions(text, config, signal);
    if (allowed === undefined) {
      return undefined;
    }
    text = allowed;
    if (text.length === 0) {
      return undefined;
    }

    const source = draft.source;
    let response: AgentResponse = { ...draft.response, text };

    let reply: ProcessedReply = { event: draft.event, text, source };
    for (const hook of this.#replyHooks) {
      throwIfAborted(signal);
      const context: EventReplyContext = {
        originalEvent,
        event: draft.event,
        sessionId,
        config,
        request: draft.request,
        response,
        ...(signal === undefined ? {} : { signal }),
      };
      const next = await hook(reply, context);
      throwIfAborted(signal);
      if (next === undefined) {
        return undefined;
      }
      reply = { ...next, event: draft.event };
    }

    const finalText = await this.#filters.applyProhibitions(
      this.#filters.cleanupResponse(reply.text),
      config,
      signal,
    );
    if (finalText === undefined || finalText.length === 0) {
      return undefined;
    }
    reply = { ...reply, event: draft.event, text: finalText };
    response = { ...response, text: finalText };

    const completedTimestamp = this.#now();
    throwIfAborted(signal);
    this.#publisher.publish({
      type: "agent.completed",
      request: draft.request,
      response,
      timestamp: completedTimestamp,
    });
    throwIfAborted(signal);
    if (
      reply.speechId !== undefined ||
      this.#speech === undefined ||
      draft.event.metadata.speak === false
    ) {
      return reply;
    }

    throwIfAborted(signal);
    const requestChatType = draft.request.metadata?.chatType;
    const speechChatType =
      typeof requestChatType === "string" &&
      (draft.event.type === "comment" ||
        draft.event.type === "talk" ||
        draft.event.type === "idle" ||
        draft.event.type === "image")
        ? requestChatType
        : undefined;
    const speechRequest: SpeechRequest = {
      text: finalText,
      sourceEventId: draft.event.id,
      metadata: {
        ...draft.event.metadata,
        ...(speechChatType === undefined ? {} : { chatType: speechChatType }),
        eventType: draft.event.type,
        platform: draft.event.platform,
        username: draft.event.username,
        source: reply.source,
        sessionId,
      },
    };
    const speechId =
      signal === undefined
        ? await this.#speech.enqueue(speechRequest)
        : await this.#speech.enqueue(speechRequest, { signal });
    throwIfAborted(signal);
    return { ...reply, speechId };
  }
}
