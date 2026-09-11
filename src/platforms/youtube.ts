import type { EventSource, LiveEventHandler } from "../core/contracts.js";
import type { LiveEvent } from "../domain/types.js";
import { normalizeLivePayload } from "./normalization.js";
import type {
  AbortableSleep,
  PlatformDependencies,
  PlatformErrorHandler,
  ReconnectOptions,
} from "./types.js";
import {
  abortError,
  asError,
  backoffDelay,
  defaultSleep,
  isAbortError,
  isRecord,
  linkAbortSignal,
  PlatformConnectionError,
  positiveInteger,
  readJsonResponse,
} from "./utilities.js";

export interface YouTubeLiveChatOptions {
  readonly platform?: string;
  readonly apiKey: string;
  readonly videoId?: string;
  readonly liveChatId?: string;
  readonly apiBaseUrl?: string;
  readonly reconnect: ReconnectOptions;
}

interface PollResult {
  readonly intervalMs: number;
  readonly nextPageToken?: string;
  readonly events: readonly LiveEvent[];
}

export class YouTubeLiveChatSource implements EventSource {
  readonly name: string;

  readonly #options: YouTubeLiveChatOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: AbortableSleep;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #onError: PlatformErrorHandler;
  readonly #controller = new AbortController();
  readonly #unlinkExternalSignal: () => void;
  readonly #seenIds = new Set<string>();

  #handler: LiveEventHandler | undefined;
  #liveChatId: string | undefined;
  #pageToken: string | undefined;
  #runPromise: Promise<void> | undefined;
  #started = false;

  constructor(
    options: YouTubeLiveChatOptions,
    dependencies: PlatformDependencies = {},
  ) {
    this.name = options.platform ?? "youtube";
    this.#options = options;
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#sleep = dependencies.sleep ?? defaultSleep;
    this.#now = dependencies.now ?? Date.now;
    this.#random = dependencies.random ?? Math.random;
    this.#onError =
      dependencies.onError ??
      ((error) => console.error(`[${this.name}] ${error.message}`, error));
    this.#unlinkExternalSignal = linkAbortSignal(
      dependencies.signal,
      this.#controller,
    );
  }

  async start(handler: LiveEventHandler): Promise<void> {
    if (this.#started) {
      throw new Error(`Event source "${this.name}" has already been started`);
    }
    if (this.#controller.signal.aborted) {
      throw abortError(this.#controller.signal.reason);
    }
    this.#started = true;
    this.#handler = handler;
    this.#liveChatId =
      this.#options.liveChatId ?? (await this.#resolveLiveChatId());
    const first = await this.#pollOnce();
    await this.#dispatch(first.events);
    this.#pageToken = first.nextPageToken;
    this.#runPromise = this.#poll(first.intervalMs);
  }

  async dispose(): Promise<void> {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new DOMException("Event source disposed", "AbortError"));
    }
    await this.#runPromise?.catch(() => undefined);
    this.#unlinkExternalSignal();
  }

  async #resolveLiveChatId(): Promise<string> {
    const videoId = this.#options.videoId;
    if (videoId === undefined || videoId.trim().length === 0) {
      throw new Error(
        `Platform "${this.name}" requires youtube.live_chat_id or room_display_id`,
      );
    }
    const url = new URL("videos", this.#apiBaseUrl());
    url.searchParams.set("part", "liveStreamingDetails");
    url.searchParams.set("id", videoId);
    url.searchParams.set("key", this.#options.apiKey);
    const body = await this.#request(url);
    if (!isRecord(body) || !Array.isArray(body["items"])) {
      throw new PlatformConnectionError(
        this.name,
        "YouTube videos response did not contain an items array",
      );
    }
    const first = body["items"][0];
    const details = isRecord(first)
      ? first["liveStreamingDetails"]
      : undefined;
    const liveChatId =
      isRecord(details) && typeof details["activeLiveChatId"] === "string"
        ? details["activeLiveChatId"].trim()
        : "";
    if (liveChatId.length === 0) {
      throw new PlatformConnectionError(
        this.name,
        `video ${JSON.stringify(videoId)} has no active live chat`,
      );
    }
    return liveChatId;
  }

  async #poll(initialIntervalMs: number): Promise<void> {
    const signal = this.#controller.signal;
    let intervalMs = initialIntervalMs;
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.#sleep(intervalMs, signal);
        const result = await this.#pollOnce();
        await this.#dispatch(result.events);
        this.#pageToken = result.nextPageToken;
        intervalMs = result.intervalMs;
        failures = 0;
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          return;
        }
        failures += 1;
        const parsed = asError(error);
        this.#onError(parsed);
        if (failures > this.#options.reconnect.maximumAttempts) {
          this.#onError(
            new PlatformConnectionError(
              this.name,
              `poll retry limit (${this.#options.reconnect.maximumAttempts}) exhausted`,
              { cause: parsed },
            ),
          );
          return;
        }
        intervalMs = backoffDelay(
          failures,
          this.#options.reconnect,
          this.#random,
        );
      }
    }
  }

  async #pollOnce(): Promise<PollResult> {
    const liveChatId = this.#liveChatId;
    if (liveChatId === undefined) {
      throw new Error("YouTube live chat was polled before initialization");
    }
    const url = new URL("liveChat/messages", this.#apiBaseUrl());
    url.searchParams.set("liveChatId", liveChatId);
    url.searchParams.set("part", "id,snippet,authorDetails");
    url.searchParams.set("maxResults", "200");
    url.searchParams.set("key", this.#options.apiKey);
    if (this.#pageToken !== undefined) {
      url.searchParams.set("pageToken", this.#pageToken);
    }
    const body = await this.#request(url);
    if (!isRecord(body) || !Array.isArray(body["items"])) {
      throw new PlatformConnectionError(
        this.name,
        "YouTube liveChat response did not contain an items array",
      );
    }
    const events = body["items"].flatMap((item) =>
      normalizeYouTubeItem(item, this.name, this.#now),
    );
    const nextPageToken =
      typeof body["nextPageToken"] === "string"
        ? body["nextPageToken"]
        : undefined;
    const intervalMs = positiveInteger(body["pollingIntervalMillis"], 5_000, 300_000);
    return {
      intervalMs,
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
      events,
    };
  }

  async #request(url: URL): Promise<unknown> {
    const requestController = new AbortController();
    const unlinkLifecycle = linkAbortSignal(
      this.#controller.signal,
      requestController,
    );
    const timeoutMs = this.#options.reconnect.connectionTimeoutMs;
    const timeout = requestController.signal.aborted
      ? undefined
      : setTimeout(() => {
          requestController.abort(
            new DOMException(
              `YouTube request timed out after ${timeoutMs} ms`,
              "TimeoutError",
            ),
          );
        }, timeoutMs);

    try {
      let response: Response;
      let body: unknown;
      try {
        response = await this.#fetch(url, {
          headers: { accept: "application/json" },
          signal: requestController.signal,
        });
        body = await readJsonResponse(response, requestController.signal);
      } catch (error) {
        throw new PlatformConnectionError(
          this.name,
          `request to ${url.origin} failed`,
          { cause: error },
        );
      }

      if (!response.ok) {
        const message = youtubeErrorMessage(body) ?? response.statusText;
        throw new PlatformConnectionError(
          this.name,
          `YouTube API returned ${response.status}: ${message}`,
        );
      }
      return body;
    } finally {
      clearTimeout(timeout);
      unlinkLifecycle();
    }
  }

  async #dispatch(events: readonly LiveEvent[]): Promise<void> {
    const handler = this.#handler;
    if (handler === undefined) {
      return;
    }
    for (const event of events) {
      if (this.#seenIds.has(event.id)) {
        continue;
      }
      this.#seenIds.add(event.id);
      if (this.#seenIds.size > 10_000) {
        const oldest = this.#seenIds.values().next().value as string | undefined;
        if (oldest !== undefined) {
          this.#seenIds.delete(oldest);
        }
      }
      await handler(event);
    }
  }

  #apiBaseUrl(): string {
    const configured = this.#options.apiBaseUrl ?? "https://www.googleapis.com/youtube/v3/";
    return configured.endsWith("/") ? configured : `${configured}/`;
  }
}

export function normalizeYouTubeItem(
  value: unknown,
  platform = "youtube",
  now: () => number = Date.now,
): readonly LiveEvent[] {
  if (!isRecord(value)) {
    return [];
  }
  const snippet = value["snippet"];
  const author = value["authorDetails"];
  if (!isRecord(snippet) || !isRecord(author)) {
    return [];
  }
  const rawType =
    typeof snippet["type"] === "string" ? snippet["type"] : "";
  const username =
    typeof author["displayName"] === "string"
      ? author["displayName"]
      : "匿名用户";
  const metadata: Record<string, unknown> = {
    protocol: "youtube-data-api",
    youtubeType: rawType,
  };
  copyKnownMetadata(metadata, "userId", author["channelId"]);
  copyKnownMetadata(metadata, "avatarUrl", author["profileImageUrl"]);
  copyKnownMetadata(metadata, "isVerified", author["isVerified"]);
  copyKnownMetadata(metadata, "isChatOwner", author["isChatOwner"]);
  copyKnownMetadata(metadata, "isChatModerator", author["isChatModerator"]);
  const id = value["id"];
  const timestamp = snippet["publishedAt"];
  const displayMessage =
    typeof snippet["displayMessage"] === "string"
      ? snippet["displayMessage"]
      : undefined;

  if (rawType === "textMessageEvent" || rawType === "messageDeletedEvent") {
    const details = snippet["textMessageDetails"];
    const text =
      isRecord(details) && typeof details["messageText"] === "string"
        ? details["messageText"]
        : displayMessage;
    return normalizeLivePayload(
      { id, type: "comment", username, content: text, timestamp, metadata },
      { platform, now },
    );
  }
  if (rawType === "superChatEvent" || rawType === "superStickerEvent") {
    const detailsKey =
      rawType === "superChatEvent" ? "superChatDetails" : "superStickerDetails";
    const details = snippet[detailsKey];
    if (isRecord(details)) {
      const amountMicros = Number(details["amountMicros"]);
      copyKnownMetadata(metadata, "amountDisplayString", details["amountDisplayString"]);
      copyKnownMetadata(metadata, "currency", details["currency"]);
      copyKnownMetadata(metadata, "tier", details["tier"]);
      if (Number.isFinite(amountMicros)) {
        metadata["totalPrice"] = amountMicros / 1_000_000;
      }
    }
    metadata["giftName"] =
      rawType === "superChatEvent" ? "Super Chat" : "Super Sticker";
    metadata["quantity"] = 1;
    return normalizeLivePayload(
      {
        id,
        type: "gift",
        username,
        content: displayMessage ?? String(metadata["giftName"]),
        timestamp,
        metadata,
      },
      { platform, now },
    );
  }
  if (rawType === "newSponsorEvent") {
    return normalizeLivePayload(
      {
        id,
        type: "follow",
        username,
        content: displayMessage ?? "加入了频道会员",
        timestamp,
        metadata,
      },
      { platform, now },
    );
  }
  if (rawType === "memberMilestoneChatEvent") {
    return normalizeLivePayload(
      {
        id,
        type: "comment",
        username,
        content: displayMessage,
        timestamp,
        metadata,
      },
      { platform, now },
    );
  }
  if (
    rawType === "membershipGiftingEvent" ||
    rawType === "giftMembershipReceivedEvent"
  ) {
    metadata["giftName"] = "Channel Membership";
    return normalizeLivePayload(
      {
        id,
        type: "gift",
        username,
        content: displayMessage ?? "赠送了频道会员",
        timestamp,
        metadata,
      },
      { platform, now },
    );
  }
  return [];
}

function copyKnownMetadata(
  metadata: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined && value !== null && value !== "") {
    metadata[key] = value;
  }
}

function youtubeErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body["error"])) {
    return undefined;
  }
  return typeof body["error"]["message"] === "string"
    ? body["error"]["message"]
    : undefined;
}
