import type { JsonObject } from "../../config/config-store.js";
import type { EventMiddleware } from "../../core/event-processor.js";
import {
  getConfigValue,
  renderTemplate,
  throwIfAborted,
  toFiniteNumber,
  toStringList,
} from "../../core/filters.js";
import type { LiveEvent } from "../../domain/types.js";
import {
  normalizeMoney,
  type GiftRecord,
  type IntegralAccount,
  type SqliteRepository,
} from "../../persistence/sqlite-repository.js";

export type EngagementErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_GIFT_EVENT"
  | "INVALID_CLOCK"
  | "INVALID_RANDOM_SOURCE"
  | "POINTS_OUT_OF_RANGE";

export class EngagementError extends Error {
  readonly code: EngagementErrorCode;
  readonly path?: string;

  constructor(
    code: EngagementErrorCode,
    message: string,
    options: { readonly path?: string; readonly cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "EngagementError";
    this.code = code;
    if (options.path !== undefined) {
      this.path = options.path;
    }
  }
}

export interface EngagementDependencies {
  readonly repository: SqliteRepository;
  /** Unix time in milliseconds. */
  readonly now?: () => number;
  /** Must return a number in [0, 1), like Math.random. */
  readonly random?: () => number;
}

export type EngagementResult =
  | { readonly type: "continue" }
  | {
      readonly type: "reply";
      readonly text: string;
      readonly reason: "sign" | "sign-duplicate" | "entrance" | "gift" | "query";
      readonly account?: IntegralAccount;
    };

type GiftDetails = GiftRecord;

interface IntervalCopywriting {
  readonly minimum: number;
  readonly maximum: number;
  readonly choices: readonly string[];
}

const INTERVAL_PATTERN =
  /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/u;

function isEnabled(config: JsonObject, ...path: readonly string[]): boolean {
  return getConfigValue(config, ...path) === true;
}

function configError(path: string, expectation: string): EngagementError {
  return new EngagementError(
    "INVALID_CONFIG",
    `enabled engagement setting ${path} ${expectation}`,
    { path },
  );
}

function requiredFiniteNumber(
  config: JsonObject,
  path: readonly string[],
): number {
  const raw = getConfigValue(config, ...path);
  const displayPath = path.join(".");
  if (
    (typeof raw !== "number" &&
      (typeof raw !== "string" || raw.trim().length === 0)) ||
    toFiniteNumber(raw) === undefined
  ) {
    throw configError(displayPath, "must be a finite number");
  }
  return Number(raw);
}

function requiredPoints(config: JsonObject, path: readonly string[]): number {
  const points = requiredFiniteNumber(config, path);
  if (!Number.isSafeInteger(points) || points < 0) {
    throw configError(
      path.join("."),
      "must be a non-negative safe integer",
    );
  }
  return points;
}

function requiredCommands(
  config: JsonObject,
  path: readonly string[],
): readonly string[] {
  const value = getConfigValue(config, ...path);
  const commands = toStringList(value);
  if (!Array.isArray(value) || commands.length === 0) {
    throw configError(path.join("."), "must be a non-empty string array");
  }
  return commands;
}

function requiredCopywriting(
  config: JsonObject,
  path: readonly string[],
): readonly string[] {
  const value = getConfigValue(config, ...path);
  const choices = toStringList(value);
  if (!Array.isArray(value) || choices.length === 0) {
    throw configError(path.join("."), "must be a non-empty string array");
  }
  return choices;
}

function parseIntervals(
  config: JsonObject,
  section: "sign" | "entrance" | "gift",
): readonly IntervalCopywriting[] {
  const path = `integral.${section}.copywriting`;
  const value = getConfigValue(config, "integral", section, "copywriting");
  if (!Array.isArray(value) || value.length === 0) {
    throw configError(path, "must be a non-empty array");
  }

  const intervalKey =
    section === "sign"
      ? "sign_num_interval"
      : section === "entrance"
        ? "entrance_num_interval"
        : "gift_price_interval";

  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw configError(`${path}[${index}]`, "must be an object");
    }
    const record = entry as Readonly<Record<string, unknown>>;
    const interval = record[intervalKey];
    if (typeof interval !== "string") {
      throw configError(
        `${path}[${index}].${intervalKey}`,
        "must be a minimum-maximum string",
      );
    }
    const match = INTERVAL_PATTERN.exec(interval);
    if (match === null) {
      throw configError(
        `${path}[${index}].${intervalKey}`,
        "must use minimum-maximum syntax",
      );
    }
    const minimumText = match[1];
    const maximumText = match[2];
    if (minimumText === undefined || maximumText === undefined) {
      throw configError(
        `${path}[${index}].${intervalKey}`,
        "must contain both interval bounds",
      );
    }
    const minimum = Number(minimumText);
    const maximum = Number(maximumText);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
      throw configError(
        `${path}[${index}].${intervalKey}`,
        "must contain an ordered finite interval",
      );
    }
    if (
      section !== "gift" &&
      (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum))
    ) {
      throw configError(
        `${path}[${index}].${intervalKey}`,
        "must contain integer bounds",
      );
    }
    const choices = toStringList(record["copywriting"]);
    if (!Array.isArray(record["copywriting"]) || choices.length === 0) {
      throw configError(
        `${path}[${index}].copywriting`,
        "must be a non-empty string array",
      );
    }
    return { minimum, maximum, choices };
  });
}

function intervalChoices(
  config: JsonObject,
  section: "sign" | "entrance" | "gift",
  value: number,
): readonly string[] {
  const match = parseIntervals(config, section).find(
    (entry) => entry.minimum <= value && value <= entry.maximum,
  );
  if (match === undefined) {
    throw configError(
      `integral.${section}.copywriting`,
      `has no interval covering ${value}`,
    );
  }
  return match.choices;
}

function eventDate(event: LiveEvent): Date {
  const value = new Date(event.timestamp);
  if (!Number.isFinite(value.getTime())) {
    throw new EngagementError(
      "INVALID_CLOCK",
      `event ${event.id} has an invalid timestamp`,
    );
  }
  return value;
}

function metadataNumber(
  event: LiveEvent,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const raw = event.metadata[key];
    if (
      typeof raw !== "number" &&
      (typeof raw !== "string" || raw.trim().length === 0)
    ) {
      continue;
    }
    const value = toFiniteNumber(raw);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function metadataString(
  event: LiveEvent,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = event.metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function parseGift(event: LiveEvent): GiftDetails {
  const quantity =
    metadataNumber(event, ["quantity", "giftNum", "gift_num", "num"]) ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new EngagementError(
      "INVALID_GIFT_EVENT",
      `gift event ${event.id} requires a positive integer quantity`,
    );
  }

  let unitPrice = metadataNumber(event, ["unitPrice", "unit_price"]);
  let totalPrice = metadataNumber(event, ["totalPrice", "total_price"]);
  if (unitPrice === undefined && totalPrice === undefined) {
    throw new EngagementError(
      "INVALID_GIFT_EVENT",
      `gift event ${event.id} requires unitPrice or totalPrice metadata when gift persistence or integral is enabled`,
    );
  }
  if (unitPrice === undefined && totalPrice !== undefined) {
    unitPrice = totalPrice / quantity;
  }
  if (totalPrice === undefined && unitPrice !== undefined) {
    totalPrice = unitPrice * quantity;
  }
  if (
    unitPrice === undefined ||
    totalPrice === undefined ||
    unitPrice < 0 ||
    totalPrice < 0
  ) {
    throw new EngagementError(
      "INVALID_GIFT_EVENT",
      `gift event ${event.id} contains invalid monetary metadata`,
    );
  }

  const giftName =
    metadataString(event, ["giftName", "gift_name"]) ?? event.content.trim();
  if (giftName.length === 0) {
    throw new EngagementError(
      "INVALID_GIFT_EVENT",
      `gift event ${event.id} requires a gift name`,
    );
  }

  try {
    return {
      username: event.username,
      giftName,
      quantity,
      unitPrice: normalizeMoney(unitPrice),
      totalPrice: normalizeMoney(totalPrice),
      timestamp: eventDate(event),
    };
  } catch (error) {
    throw new EngagementError(
      "INVALID_GIFT_EVENT",
      `gift event ${event.id} contains unsupported monetary values`,
      { cause: error },
    );
  }
}

function eventStableUid(event: LiveEvent): string | undefined {
  return metadataString(event, ["userId", "uid", "user_id"]);
}

function eventUid(event: LiveEvent): string {
  return eventStableUid(event) ?? event.username;
}

/**
 * Matches Python's `int(proportion * total_price)`: fractional points are
 * truncated toward zero after validating both operands.
 */
export function calculateGiftPoints(
  totalPrice: number,
  pointsPerCurrencyUnit: number,
): number {
  if (
    !Number.isFinite(totalPrice) ||
    totalPrice < 0 ||
    !Number.isFinite(pointsPerCurrencyUnit) ||
    pointsPerCurrencyUnit < 0
  ) {
    throw new EngagementError(
      "POINTS_OUT_OF_RANGE",
      "gift price and point proportion must be finite non-negative numbers",
    );
  }
  const points = Math.trunc(totalPrice * pointsPerCurrencyUnit);
  if (!Number.isSafeInteger(points)) {
    throw new EngagementError(
      "POINTS_OUT_OF_RANGE",
      "gift points exceed JavaScript's safe integer range",
    );
  }
  return points;
}

function formatCurrentTime(value: Date): string {
  return `${value.getHours()}点${value.getMinutes()}分`;
}

export class EngagementService {
  private readonly repository: SqliteRepository;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(dependencies: EngagementDependencies) {
    this.repository = dependencies.repository;
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
  }

  handle(event: LiveEvent, config: JsonObject): EngagementResult {
    const integralEnabled = isEnabled(config, "integral", "enable");
    let gift: GiftDetails | undefined;

    if (event.type === "comment" && isEnabled(config, "database", "comment_enable")) {
      this.repository.recordComment({
        username: event.username,
        content: event.content,
        timestamp: eventDate(event),
      });
    } else if (
      event.type === "entrance" &&
      isEnabled(config, "database", "entrance_enable")
    ) {
      this.repository.recordEntrance({
        username: event.username,
        timestamp: eventDate(event),
      });
    } else if (event.type === "gift") {
      const persistenceEnabled = isEnabled(config, "database", "gift_enable");
      const giftIntegralEnabled =
        integralEnabled && isEnabled(config, "integral", "gift", "enable");
      if (persistenceEnabled || giftIntegralEnabled) {
        gift = parseGift(event);
      }
      if (persistenceEnabled && gift !== undefined) {
        this.repository.recordGift(gift);
      }
    }

    if (!integralEnabled) {
      return { type: "continue" };
    }
    const now = this.currentDate();

    if (event.type === "comment") {
      return this.handleComment(event, config, now);
    }
    if (
      event.type === "entrance" &&
      isEnabled(config, "integral", "entrance", "enable")
    ) {
      return this.handleEntrance(event, config, now);
    }
    if (
      event.type === "gift" &&
      isEnabled(config, "integral", "gift", "enable")
    ) {
      return this.handleGift(event, gift ?? parseGift(event), config, now);
    }
    return { type: "continue" };
  }

  private handleComment(
    event: LiveEvent,
    config: JsonObject,
    now: Date,
  ): EngagementResult {
    if (isEnabled(config, "integral", "sign", "enable")) {
      const commands = requiredCommands(config, ["integral", "sign", "cmd"]);
      if (commands.includes(event.content)) {
        const points = requiredPoints(config, [
          "integral",
          "sign",
          "get_integral",
        ]);
        const result = this.repository.awardDaily({
          type: "sign",
          platform: event.platform,
          username: event.username,
          uid: eventUid(event),
          uidIsStable: eventStableUid(event) !== undefined,
          points,
          occurredAt: now,
        });
        if (!result.awarded) {
          return {
            type: "reply",
            reason: "sign-duplicate",
            account: result.account,
            text: `${event.username}您今天已经签到过了，不能重复打卡哦~`,
          };
        }
        const text = this.render(
          intervalChoices(config, "sign", result.account.signCount),
          {
            username: event.username,
            get_integral: points,
            sign_num: result.account.signCount,
            cur_time: formatCurrentTime(now),
          },
        );
        return {
          type: "reply",
          reason: "sign",
          account: result.account,
          text,
        };
      }
    }

    if (isEnabled(config, "integral", "crud", "query", "enable")) {
      const commands = requiredCommands(config, [
        "integral",
        "crud",
        "query",
        "cmd",
      ]);
      if (commands.includes(event.content)) {
        const account = this.repository.getIntegralAccount(
          event.platform,
          event.username,
          eventStableUid(event),
        );
        const integral = account?.integral ?? 0;
        const text =
          integral === 0
            ? `${event.username}，查询到您无积分。`
            : this.render(
                requiredCopywriting(config, [
                  "integral",
                  "crud",
                  "query",
                  "copywriting",
                ]),
                { username: event.username, integral },
              );
        return account === undefined
          ? { type: "reply", reason: "query", text }
          : { type: "reply", reason: "query", account, text };
      }
    }

    return { type: "continue" };
  }

  private handleEntrance(
    event: LiveEvent,
    config: JsonObject,
    now: Date,
  ): EngagementResult {
    const points = requiredPoints(config, [
      "integral",
      "entrance",
      "get_integral",
    ]);
    const result = this.repository.awardDaily({
      type: "entrance",
      platform: event.platform,
      username: event.username,
      uid: eventUid(event),
      uidIsStable: eventStableUid(event) !== undefined,
      points,
      occurredAt: now,
    });
    if (!result.awarded) {
      return { type: "continue" };
    }
    const text = this.render(
      intervalChoices(config, "entrance", result.account.viewCount),
      {
        username: event.username,
        get_integral: points,
        entrance_num: result.account.viewCount,
        cur_time: formatCurrentTime(now),
      },
    );
    return {
      type: "reply",
      reason: "entrance",
      account: result.account,
      text,
    };
  }

  private handleGift(
    event: LiveEvent,
    gift: GiftDetails,
    config: JsonObject,
    now: Date,
  ): EngagementResult {
    const proportion = requiredFiniteNumber(config, [
      "integral",
      "gift",
      "get_integral_proportion",
    ]);
    const points = calculateGiftPoints(gift.totalPrice, proportion);
    const account = this.repository.applyGiftIntegral({
      platform: event.platform,
      username: event.username,
      uid: eventUid(event),
      uidIsStable: eventStableUid(event) !== undefined,
      points,
      totalPrice: gift.totalPrice,
      occurredAt: now,
    });
    const text = this.render(
      intervalChoices(config, "gift", gift.totalPrice),
      {
        username: event.username,
        gift_name: gift.giftName,
        gift_num: gift.quantity,
        unit_price: gift.unitPrice,
        total_price: gift.totalPrice,
        get_integral: points,
        integral: account.integral,
        cur_time: formatCurrentTime(now),
      },
    );
    return { type: "reply", reason: "gift", account, text };
  }

  private currentDate(): Date {
    const timestamp = this.now();
    const value = new Date(timestamp);
    if (!Number.isFinite(timestamp) || !Number.isFinite(value.getTime())) {
      throw new EngagementError(
        "INVALID_CLOCK",
        "engagement clock must return finite Unix milliseconds",
      );
    }
    return value;
  }

  private choose<T>(values: readonly T[]): T {
    const sample = this.random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new EngagementError(
        "INVALID_RANDOM_SOURCE",
        "engagement random source must return a finite number in [0, 1)",
      );
    }
    const value = values[Math.floor(sample * values.length)];
    if (value === undefined) {
      throw new EngagementError(
        "INVALID_CONFIG",
        "engagement copywriting choices cannot be empty",
      );
    }
    return value;
  }

  private render(
    choices: readonly string[],
    variables: Readonly<Record<string, unknown>>,
  ): string {
    const selected = this.choose(choices);
    const expanded = selected.replace(
      /\[([^\]]*)\]/gu,
      (_placeholder, contents: string) => this.choose(contents.split("|")),
    );
    return renderTemplate(expanded, variables);
  }
}

export function createEngagementMiddleware(
  dependencies: EngagementDependencies,
): EventMiddleware {
  const service = new EngagementService(dependencies);
  return (context) => {
    throwIfAborted(context.signal);
    const result = service.handle(context.event, context.config);
    if (result.type === "reply") {
      return { type: "reply", text: result.text, source: "command" };
    }
    return undefined;
  };
}
