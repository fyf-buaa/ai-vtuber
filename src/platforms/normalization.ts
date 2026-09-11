import { createHash } from "node:crypto";

import type { LiveEvent, LiveEventType, Metadata } from "../domain/types.js";
import { isRecord } from "./utilities.js";

export interface NormalizeOptions {
  readonly platform: string;
  readonly now?: () => number;
}

interface EventFields {
  readonly type: LiveEventType;
  readonly username?: string | undefined;
  readonly content?: string | undefined;
  readonly timestamp?: unknown;
  readonly sourceId?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const LIVE_EVENT_TYPES = new Set<LiveEventType>([
  "comment",
  "gift",
  "entrance",
  "follow",
  "talk",
  "schedule",
  "idle",
  "image",
]);
const COMMENT_TYPES = new Set([
  "comment",
  "chat",
  "danmu",
  "message",
  "privmsg",
  "live_open_platform_dm",
]);
const GIFT_TYPES = new Set([
  "gift",
  "donation",
  "super_chat",
  "superchat",
  "send_gift",
  "combo_send",
  "live_open_platform_send_gift",
  "live_open_platform_super_chat",
  "live_open_platform_guard",
]);
const ENTRANCE_TYPES = new Set([
  "entrance",
  "enter",
  "enter_room",
  "join",
  "interact_word",
]);
const FOLLOW_TYPES = new Set(["follow", "subscribe", "subscription"]);

export function normalizeLivePayload(
  payload: unknown,
  options: NormalizeOptions,
): readonly LiveEvent[] {
  const now = options.now ?? Date.now;
  return normalizePayload(payload, options.platform, now, payload);
}

function normalizePayload(
  payload: unknown,
  platform: string,
  now: () => number,
  identityPayload: unknown,
): readonly LiveEvent[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => normalizePayload(item, platform, now, item));
  }
  if (!isRecord(payload)) {
    return [];
  }

  const command = stringValue(payload["cmd"] ?? payload["command"]);
  if (command !== undefined) {
    const bilibili = normalizeBilibiliCommand(
      command,
      payload,
      platform,
      now,
      identityPayload,
    );
    if (bilibili.length > 0) {
      return bilibili;
    }
  }

  const rawType = stringValue(
    payload["type"] ?? payload["event_type"] ?? payload["eventType"],
  );
  if (rawType !== undefined) {
    const ordinaryRoad = normalizeOrdinaryRoad(
      rawType,
      payload,
      platform,
      now,
      identityPayload,
    );
    if (ordinaryRoad.length > 0) {
      return ordinaryRoad;
    }
  }

  const wrapped = payload["event"] ?? payload["payload"];
  if (isRecord(wrapped)) {
    return normalizePayload(wrapped, platform, now, identityPayload);
  }
  return normalizeSimple(payload, platform, now, identityPayload);
}

function normalizeOrdinaryRoad(
  rawType: string,
  envelope: Readonly<Record<string, unknown>>,
  platform: string,
  now: () => number,
  identityPayload: unknown,
): readonly LiveEvent[] {
  const normalizedType = rawType.trim().toLowerCase();
  if (
    normalizedType !== "danmu" &&
    normalizedType !== "gift" &&
    normalizedType !== "enter_room" &&
    normalizedType !== "like"
  ) {
    return [];
  }
  const message = childRecord(envelope, "msg");
  if (message === undefined) {
    return [];
  }
  const metadata: Record<string, unknown> = { protocol: "ordinaryroad-json" };
  copyMetadata(metadata, "relayPlatform", envelope["platform"]);
  copyMetadata(metadata, "roomId", envelope["roomId"] ?? envelope["room_id"]);
  copyMetadata(metadata, "userId", message["uid"] ?? message["userId"]);
  copyMetadata(metadata, "badgeName", message["badgeName"]);
  copyMetadata(metadata, "badgeLevel", message["badgeLevel"]);
  const username = firstText(message["username"], message["nickname"]);
  const sourceId = firstValue(
    message,
    "id",
    "msgId",
    "messageId",
    "timestamp",
  );

  if (normalizedType === "danmu") {
    return singleEvent(identityPayload, platform, now, {
      type: "comment",
      username,
      content: firstText(message["content"], message["message"]),
      timestamp: firstValue(message, "timestamp", "time"),
      sourceId,
      metadata,
    });
  }
  if (normalizedType === "enter_room") {
    return singleEvent(identityPayload, platform, now, {
      type: "entrance",
      username,
      content: "进入直播间",
      timestamp: firstValue(message, "timestamp", "time"),
      sourceId,
      metadata,
    });
  }
  if (normalizedType === "like") {
    const count = finiteNumber(message["clickCount"] ?? message["count"]);
    metadata["action"] = "like";
    copyMetadata(metadata, "count", count);
    return singleEvent(identityPayload, platform, now, {
      type: "comment",
      username,
      content: likeContent(count),
      timestamp: firstValue(message, "timestamp", "time"),
      sourceId,
      metadata,
    });
  }

  const giftName = firstText(message["giftName"], message["gift_name"]);
  const quantity = finiteNumber(message["giftCount"] ?? message["gift_num"]);
  const unitPrice = finiteNumber(message["giftPrice"] ?? message["gift_price"]);
  copyMetadata(metadata, "giftName", giftName);
  copyMetadata(metadata, "giftId", message["giftId"] ?? message["gift_id"]);
  copyMetadata(metadata, "quantity", quantity);
  copyMetadata(metadata, "unitPrice", unitPrice);
  if (quantity !== undefined && unitPrice !== undefined) {
    metadata["totalPrice"] = quantity * unitPrice;
  }
  return singleEvent(identityPayload, platform, now, {
    type: "gift",
    username,
    content: giftContent(giftName, quantity),
    timestamp: firstValue(message, "timestamp", "time"),
    sourceId,
    metadata,
  });
}

function normalizeBilibiliCommand(
  command: string,
  envelope: Readonly<Record<string, unknown>>,
  platform: string,
  now: () => number,
  identityPayload: unknown,
): readonly LiveEvent[] {
  const baseCommand = command.split(":", 1)[0]?.toUpperCase() ?? "";
  const data = childRecord(envelope, "data") ?? envelope;
  const openLive = baseCommand.startsWith("LIVE_OPEN_PLATFORM_");
  const metadata: Record<string, unknown> = {
    protocol: openLive ? "bilibili-platform" : "bilibili-web",
    command: baseCommand,
  };
  if (baseCommand.endsWith("_MIRROR")) {
    metadata["isMirror"] = true;
  }
  copyMetadata(metadata, "roomId", data["room_id"] ?? data["roomid"]);
  copyMetadata(metadata, "userId", data["uid"] ?? data["open_id"]);
  copyMetadata(metadata, "avatarUrl", data["uface"] ?? data["face"]);

  if (baseCommand === "DANMU_MSG" || baseCommand === "DANMU_MSG_MIRROR") {
    const info = envelope["info"] ?? data["info"];
    if (!Array.isArray(info)) {
      return [];
    }
    const userTuple = info[2];
    const userId = Array.isArray(userTuple) ? userTuple[0] : undefined;
    const username = Array.isArray(userTuple) ? firstText(userTuple[1]) : undefined;
    copyMetadata(metadata, "userId", userId);
    const timing = info[0];
    const timestamp = Array.isArray(timing) ? timing[4] : undefined;
    return singleEvent(identityPayload, platform, now, {
      type: "comment",
      username,
      content: firstText(info[1]),
      timestamp,
      sourceId: firstValue(data, "msg_id", "id") ?? envelope["msg_id"],
      metadata,
    });
  }
  if (
    baseCommand === "LIVE_OPEN_PLATFORM_DM" ||
    baseCommand === "LIVE_OPEN_PLATFORM_DM_MIRROR"
  ) {
    return singleEvent(identityPayload, platform, now, {
      type: "comment",
      username: firstText(data["uname"], data["username"]),
      content: firstText(data["msg"], data["content"]),
      timestamp: firstValue(data, "timestamp", "send_time"),
      sourceId: firstValue(data, "msg_id", "id"),
      metadata,
    });
  }
  if (baseCommand === "INTERACT_WORD") {
    const messageType = finiteNumber(data["msg_type"]);
    const type = messageType === 1
      ? "entrance"
      : messageType === 2
        ? "follow"
        : undefined;
    if (type === undefined) {
      return [];
    }
    copyMetadata(metadata, "msgType", messageType);
    return singleEvent(identityPayload, platform, now, {
      type,
      username: firstText(data["uname"], data["username"]),
      content: type === "entrance" ? "进入直播间" : "关注了直播间",
      timestamp: firstValue(data, "timestamp", "trigger_time"),
      sourceId: firstValue(data, "msg_id", "id"),
      metadata,
    });
  }
  if (baseCommand === "LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER") {
    return singleEvent(identityPayload, platform, now, {
      type: "entrance",
      username: firstText(data["uname"], data["username"]),
      content: "进入直播间",
      timestamp: firstValue(data, "timestamp", "trigger_time"),
      sourceId: firstValue(data, "msg_id", "id"),
      metadata,
    });
  }
  if (baseCommand === "LIVE_OPEN_PLATFORM_LIKE") {
    const count = finiteNumber(data["like_count"] ?? data["count"]);
    metadata["action"] = "like";
    copyMetadata(metadata, "count", count);
    return singleEvent(identityPayload, platform, now, {
      type: "comment",
      username: firstText(data["uname"], data["username"]),
      content: likeContent(count),
      timestamp: firstValue(data, "timestamp", "send_time"),
      sourceId: firstValue(data, "msg_id", "id"),
      metadata,
    });
  }
  if (baseCommand === "SEND_GIFT" || baseCommand === "COMBO_SEND") {
    const giftName = firstText(data["giftName"], data["gift_name"]);
    const quantity = finiteNumber(
      data["num"] ?? data["combo_num"] ?? data["gift_num"],
    );
    const totalCoin = finiteNumber(
      data["combo_total_coin"] ?? data["total_coin"],
    );
    copyMetadata(metadata, "giftName", giftName);
    copyMetadata(metadata, "giftId", data["giftId"] ?? data["gift_id"]);
    copyMetadata(metadata, "quantity", quantity);
    if (totalCoin !== undefined) {
      metadata["totalPrice"] = totalCoin / 1_000;
      if (quantity !== undefined && quantity > 0) {
        metadata["unitPrice"] = totalCoin / quantity / 1_000;
      }
      metadata["currency"] = "CNY";
    }
    return singleEvent(identityPayload, platform, now, {
      type: "gift",
      username: firstText(data["uname"], data["username"]),
      content: giftContent(giftName, quantity),
      timestamp: firstValue(data, "timestamp", "send_time"),
      sourceId: firstValue(data, "tid", "msg_id", "id"),
      metadata,
    });
  }
  if (
    baseCommand === "LIVE_OPEN_PLATFORM_SEND_GIFT" ||
    baseCommand === "LIVE_OPEN_PLATFORM_SUPER_CHAT" ||
    baseCommand === "LIVE_OPEN_PLATFORM_GUARD"
  ) {
    const isSuperChat = baseCommand === "LIVE_OPEN_PLATFORM_SUPER_CHAT";
    const giftName = isSuperChat
      ? "SC"
      : firstText(data["gift_name"], data["giftName"], data["guard_name"]);
    const quantity = finiteNumber(data["gift_num"] ?? data["num"] ?? 1);
    const rawPrice = finiteNumber(
      data["gift_price"] ?? data["price"] ?? data["rmb"],
    );
    copyMetadata(metadata, "giftName", giftName);
    copyMetadata(metadata, "giftId", data["gift_id"]);
    copyMetadata(metadata, "quantity", quantity);
    if (rawPrice !== undefined) {
      const isCoinPrice = "gift_price" in data;
      metadata["unitPrice"] = isCoinPrice ? rawPrice / 1_000 : rawPrice;
      metadata["totalPrice"] =
        (isCoinPrice ? rawPrice / 1_000 : rawPrice) * (quantity ?? 1);
      metadata["currency"] = "CNY";
    }
    return singleEvent(identityPayload, platform, now, {
      type: "gift",
      username: firstText(data["uname"], data["username"]),
      content: giftContent(
        giftName,
        quantity,
        firstText(data["message"], data["msg"]),
      ),
      timestamp: firstValue(data, "timestamp", "send_time"),
      sourceId: firstValue(data, "msg_id", "id"),
      metadata,
    });
  }
  return [];
}

function normalizeSimple(
  envelope: Readonly<Record<string, unknown>>,
  platform: string,
  now: () => number,
  identityPayload: unknown,
): readonly LiveEvent[] {
  const nested = childRecord(envelope, "data");
  const source = nested ?? envelope;
  const rawType = firstText(
    envelope["type"],
    envelope["event_type"],
    envelope["eventType"],
    source["type"],
  );
  const eventType = mapEventType(rawType, source);
  if (eventType === undefined) {
    return [];
  }
  const user = childRecord(source, "user", "author", "authorDetails");
  const username = firstText(
    source["username"],
    source["nickname"],
    source["uname"],
    source["user_name"],
    source["displayName"],
    user?.["nickname"],
    user?.["username"],
    user?.["displayName"],
    user?.["name"],
  );
  const metadata: Record<string, unknown> = {};
  if (isRecord(source["metadata"])) {
    Object.assign(metadata, source["metadata"]);
  }
  copyMetadata(
    metadata,
    "userId",
    source["uid"] ?? source["user_id"] ?? user?.["id"],
  );
  copyMetadata(
    metadata,
    "avatarUrl",
    source["avatar"] ?? source["avatar_url"] ?? user?.["avatar"],
  );
  copyMetadata(metadata, "roomId", source["room_id"] ?? source["roomId"]);
  if (rawType !== undefined) {
    metadata["rawType"] = rawType;
  }
  if (rawType?.trim().toLowerCase() === "like") {
    const count = finiteNumber(source["count"] ?? source["clickCount"]);
    metadata["action"] = "like";
    copyMetadata(metadata, "count", count);
    return singleEvent(identityPayload, platform, now, {
      type: "comment",
      username,
      content: firstText(source["content"], source["message"]) ?? likeContent(count),
      timestamp: firstValue(source, "timestamp", "time", "created_at"),
      sourceId: firstValue(source, "id", "event_id", "msg_id", "seq"),
      metadata,
    });
  }

  const giftName = firstText(
    source["gift_name"],
    source["giftName"],
    source["gift"],
  );
  const quantity = finiteNumber(
    source["num"] ??
      source["quantity"] ??
      source["count"] ??
      source["giftCount"],
  );
  if (eventType === "gift") {
    copyMetadata(metadata, "giftName", giftName);
    copyMetadata(metadata, "quantity", quantity);
    copyMetadata(
      metadata,
      "unitPrice",
      finiteNumber(source["unit_price"] ?? source["unitPrice"]),
    );
    copyMetadata(
      metadata,
      "totalPrice",
      finiteNumber(source["total_price"] ?? source["totalPrice"]),
    );
    copyMetadata(metadata, "currency", source["currency"]);
  }
  const content =
    eventType === "gift"
      ? giftContent(
          giftName,
          quantity,
          firstText(source["content"], source["message"], source["text"]),
        )
      : eventType === "entrance"
        ? firstText(source["content"], source["message"]) ?? "进入直播间"
        : eventType === "follow"
          ? firstText(source["content"], source["message"]) ?? "关注了直播间"
          : firstText(
              source["content"],
              source["message"],
              source["text"],
              source["comment"],
            );
  return singleEvent(identityPayload, platform, now, {
    type: eventType,
    username,
    content,
    timestamp: firstValue(
      source,
      "timestamp",
      "time",
      "created_at",
      "createdAt",
      "publishedAt",
      "send_time",
    ),
    sourceId: firstValue(
      source,
      "id",
      "event_id",
      "eventId",
      "msg_id",
      "msgId",
      "message_id",
      "messageId",
      "seq",
      "commentId",
    ),
    metadata,
  });
}

function mapEventType(
  rawType: string | undefined,
  source: Readonly<Record<string, unknown>>,
): LiveEventType | undefined {
  if (rawType === undefined) {
    return firstText(source["content"], source["message"], source["text"])
      ? "comment"
      : undefined;
  }
  const normalized = rawType.trim().toLowerCase();
  if (normalized === "like") {
    return "comment";
  }
  if (LIVE_EVENT_TYPES.has(normalized as LiveEventType)) {
    return normalized as LiveEventType;
  }
  if (COMMENT_TYPES.has(normalized)) {
    return "comment";
  }
  if (GIFT_TYPES.has(normalized)) {
    return "gift";
  }
  if (ENTRANCE_TYPES.has(normalized)) {
    return "entrance";
  }
  if (FOLLOW_TYPES.has(normalized)) {
    return "follow";
  }
  return undefined;
}

function singleEvent(
  identityPayload: unknown,
  platform: string,
  now: () => number,
  fields: EventFields,
): readonly LiveEvent[] {
  const content = fields.content?.trim() ?? "";
  if (
    content.length === 0 &&
    fields.type !== "entrance" &&
    fields.type !== "follow"
  ) {
    return [];
  }
  const username = fields.username?.trim() || "匿名用户";
  const timestamp = parseTimestamp(fields.timestamp, now());
  const sourceId = scalarId(fields.sourceId);
  const digest = createHash("sha256")
    .update(canonicalJson(identityPayload))
    .digest("hex")
    .slice(0, 24);
  const id = `${platform}:${fields.type}:${sourceId ?? digest}`;
  const metadata: Metadata = Object.freeze({ ...(fields.metadata ?? {}) });
  return [
    Object.freeze({
      id,
      type: fields.type,
      platform,
      username,
      content,
      timestamp,
      metadata,
    }),
  ];
}

function childRecord(
  parent: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): Readonly<Record<string, unknown>> | undefined {
  for (const key of keys) {
    const value = parent[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function firstValue(
  record: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function firstText(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
}

function parseTimestamp(value: unknown, fallback: number): number {
  const numeric = finiteNumber(value);
  if (numeric !== undefined && numeric >= 0) {
    if (numeric < 100_000_000_000) {
      return Math.trunc(numeric * 1_000);
    }
    if (numeric > 10_000_000_000_000) {
      return Math.trunc(numeric / 1_000);
    }
    return Math.trunc(numeric);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Math.trunc(fallback);
}

function scalarId(value: unknown): string | undefined {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "bigint"
  ) {
    return undefined;
  }
  const id = String(value).trim();
  return id.length > 0 ? id : undefined;
}

function copyMetadata(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined && value !== null && value !== "") {
    target[key] = value;
  }
}

function giftContent(
  giftName: string | undefined,
  quantity: number | undefined,
  message?: string,
): string {
  if (message !== undefined && message.trim().length > 0) {
    return message.trim();
  }
  const name = giftName ?? "礼物";
  return quantity !== undefined ? `${name} x${quantity}` : name;
}

function likeContent(count: number | undefined): string {
  return count === undefined ? "点赞了直播间" : `点赞了直播间 x${count}`;
}

function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (item: unknown): unknown => {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      return item;
    }
    if (typeof item === "bigint") {
      return item.toString();
    }
    if (Array.isArray(item)) {
      return item.map(normalize);
    }
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) {
        return "[Circular]";
      }
      seen.add(item);
      const object = item as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(object).sort()) {
        normalized[key] = normalize(object[key]);
      }
      return normalized;
    }
    return String(item);
  };
  return JSON.stringify(normalize(value));
}
