import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { Disposable } from "../domain/types.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const EMPTY_LEGACY_TIMESTAMP = "1970-01-01 00:00:00.000";
const MONEY_SCALE = 1_000_000;

export type PersistenceErrorCode =
  | "INVALID_DATABASE_PATH"
  | "OPEN_FAILED"
  | "DATABASE_CONFIGURATION_FAILED"
  | "MIGRATION_FAILED"
  | "INCOMPATIBLE_SCHEMA"
  | "DATABASE_CLOSED"
  | "INVALID_INPUT"
  | "TRANSACTION_FAILED";

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PersistenceError";
    this.code = code;
  }
}

export interface SqliteRepositoryOptions {
  readonly busyTimeoutMs?: number;
  /** WAL is useful for file-backed databases and is skipped for `:memory:`. */
  readonly enableWal?: boolean;
}

export interface CommentRecord {
  readonly username: string;
  readonly content: string;
  readonly timestamp: Date;
}

export interface EntranceRecord {
  readonly username: string;
  readonly timestamp: Date;
}

export interface GiftRecord {
  readonly username: string;
  readonly giftName: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly totalPrice: number;
  readonly timestamp: Date;
}

export interface IntegralIdentity {
  readonly platform: string;
  readonly username: string;
  readonly uid: string;
}

export interface IntegralAccount extends IntegralIdentity {
  readonly integral: number;
  readonly viewCount: number;
  readonly signCount: number;
  readonly lastSignAt: string;
  readonly totalPrice: number;
  readonly lastEntranceAt: string;
}

export type DailyAwardType = "sign" | "entrance";

export interface DailyAwardRequest extends IntegralIdentity {
  /** False when uid is a username fallback rather than a platform identifier. */
  readonly uidIsStable?: boolean;
  readonly type: DailyAwardType;
  readonly points: number;
  readonly occurredAt: Date;
}

export interface DailyAwardResult {
  readonly awarded: boolean;
  readonly account: IntegralAccount;
}

export interface GiftIntegralRequest extends IntegralIdentity {
  /** False when uid is a username fallback rather than a platform identifier. */
  readonly uidIsStable?: boolean;
  readonly points: number;
  readonly totalPrice: number;
  readonly occurredAt: Date;
}

export type IntegralRankingMetric =
  | "integral"
  | "view_num"
  | "sign_num"
  | "total_price";

export type IntegralRankingRow = IntegralAccount;

export interface GiftAggregateRow {
  readonly username: string;
  readonly eventCount: number;
  readonly giftCount: number;
  readonly totalPrice: number;
  readonly lastGiftAt: string;
}

interface StoredIntegralAccount extends IntegralAccount {
  readonly rowId: number | bigint;
}

interface RepositoryStatements {
  readonly insertComment: StatementSync;
  readonly insertEntrance: StatementSync;
  readonly insertGift: StatementSync;
  readonly findAccountByUsername: StatementSync;
  readonly findAccountByUid: StatementSync;
  readonly insertAccount: StatementSync;
  readonly updateIdentity: StatementSync;
  readonly updateSign: StatementSync;
  readonly updateEntrance: StatementSync;
  readonly updateGift: StatementSync;
  readonly findDailyAward: StatementSync;
  readonly insertDailyAward: StatementSync;
  readonly copyDailyAwardsIdentity: StatementSync;
  readonly deleteDailyAwardsIdentity: StatementSync;
  readonly recentComments: StatementSync;
  readonly integralRankings: Readonly<Record<IntegralRankingMetric, StatementSync>>;
  readonly giftAggregates: StatementSync;
}

type SqlRow = Readonly<Record<string, unknown>>;

function assertNonEmptyString(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new PersistenceError(
      "INVALID_INPUT",
      `${field} must be a non-empty string`,
    );
  }
}

function assertDate(value: Date, field: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new PersistenceError("INVALID_INPUT", `${field} must be a valid Date`);
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PersistenceError(
      "INVALID_INPUT",
      `${field} must be a non-negative safe integer`,
    );
  }
}

function assertNonNegativeFiniteNumber(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new PersistenceError(
      "INVALID_INPUT",
      `${field} must be a finite non-negative number`,
    );
  }
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Formats a Date like Python sqlite3's legacy local DATETIME values. */
export function toLegacyDateTime(value: Date): string {
  assertDate(value, "timestamp");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`;
}

/** The host's local calendar date, deliberately independent of UTC. */
export function toLocalDateKey(value: Date): string {
  assertDate(value, "timestamp");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/**
 * Legacy monetary columns are REAL. Six decimal places retain sub-cent platform
 * units while preventing unbounded binary floating-point drift on accumulation.
 */
export function normalizeMoney(value: number): number {
  assertNonNegativeFiniteNumber(value, "money");
  const scaled = Math.round(value * MONEY_SCALE);
  if (!Number.isSafeInteger(scaled)) {
    throw new PersistenceError(
      "INVALID_INPUT",
      "money exceeds the supported six-decimal safe range",
    );
  }
  return scaled / MONEY_SCALE;
}

function asRow(value: unknown, operation: string): SqlRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PersistenceError(
      "INCOMPATIBLE_SCHEMA",
      `${operation} returned an invalid SQLite row`,
    );
  }
  return value as SqlRow;
}

function rowString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new PersistenceError(
      "INCOMPATIBLE_SCHEMA",
      `column ${key} must contain text`,
    );
  }
  return value;
}

function rowNumber(row: SqlRow, key: string): number {
  const value = row[key];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new PersistenceError(
      "INCOMPATIBLE_SCHEMA",
      `column ${key} must contain a finite number`,
    );
  }
  return number;
}

function rowInteger(row: SqlRow, key: string): number {
  const value = rowNumber(row, key);
  if (!Number.isSafeInteger(value)) {
    throw new PersistenceError(
      "INCOMPATIBLE_SCHEMA",
      `column ${key} must contain a safe integer`,
    );
  }
  return value;
}

function mapIntegralAccount(value: unknown): StoredIntegralAccount {
  const row = asRow(value, "integral account query");
  const rowId = row["row_id"];
  if (typeof rowId !== "number" && typeof rowId !== "bigint") {
    throw new PersistenceError(
      "INCOMPATIBLE_SCHEMA",
      "integral rowid must contain an integer",
    );
  }
  return {
    rowId,
    platform: rowString(row, "platform"),
    username: rowString(row, "username"),
    uid: rowString(row, "uid"),
    integral: rowInteger(row, "integral"),
    viewCount: rowInteger(row, "view_num"),
    signCount: rowInteger(row, "sign_num"),
    lastSignAt: rowString(row, "last_sign_ts"),
    totalPrice: rowNumber(row, "total_price"),
    lastEntranceAt: rowString(row, "last_ts"),
  };
}

function publicAccount(account: StoredIntegralAccount): IntegralAccount {
  return {
    platform: account.platform,
    username: account.username,
    uid: account.uid,
    integral: account.integral,
    viewCount: account.viewCount,
    signCount: account.signCount,
    lastSignAt: account.lastSignAt,
    totalPrice: account.totalPrice,
    lastEntranceAt: account.lastEntranceAt,
  };
}

function isSameLocalDate(timestamp: string, localDate: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}/u.test(timestamp) &&
    timestamp.slice(0, 10) === localDate
  );
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PersistenceError(
      "INVALID_INPUT",
      "query limit must be a positive safe integer",
    );
  }
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as unknown[];
  return new Set(
    rows.map((value) =>
      rowString(asRow(value, `${table} schema query`), "name"),
    ),
  );
}

function requiredColumns(
  database: DatabaseSync,
  table: string,
  expected: readonly string[],
): void {
  const actual = tableColumns(database, table);
  const missing = expected.filter((column) => !actual.has(column));
  if (missing.length > 0) {
    throw new PersistenceError(
      "INCOMPATIBLE_SCHEMA",
      `legacy table ${table} is missing required columns: ${missing.join(", ")}`,
    );
  }
}

function migrateDailyAwardTable(database: DatabaseSync): void {
  if (tableColumns(database, "engagement_daily_award").has("uid")) {
    return;
  }
  requiredColumns(database, "engagement_daily_award", [
    "platform",
    "username",
    "award_type",
    "local_date",
    "awarded_at",
    "points",
  ]);
  database.exec(`
    DROP INDEX IF EXISTS idx_avt_daily_award_date;
    ALTER TABLE engagement_daily_award
      RENAME TO engagement_daily_award_legacy;
    CREATE TABLE engagement_daily_award (
      platform TEXT NOT NULL,
      uid TEXT NOT NULL,
      username TEXT NOT NULL,
      award_type TEXT NOT NULL CHECK (award_type IN ('sign', 'entrance')),
      local_date TEXT NOT NULL,
      awarded_at DATETIME NOT NULL,
      points INT NOT NULL,
      PRIMARY KEY (platform, uid, award_type, local_date)
    );
    INSERT OR IGNORE INTO engagement_daily_award
      (platform, uid, username, award_type, local_date, awarded_at, points)
    SELECT
      award.platform,
      COALESCE(
        NULLIF((
          SELECT account.uid
          FROM integral AS account
          WHERE account.platform = award.platform
            AND account.username = award.username
          ORDER BY account.rowid ASC
          LIMIT 1
        ), ''),
        award.username
      ),
      award.username,
      award.award_type,
      award.local_date,
      award.awarded_at,
      award.points
    FROM engagement_daily_award_legacy AS award
    ORDER BY award.rowid ASC;
    DROP TABLE engagement_daily_award_legacy;
  `);
}

function migrate(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS danmu (
        username TEXT NOT NULL,
        content TEXT NOT NULL,
        ts DATETIME NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entrance (
        username TEXT NOT NULL,
        ts DATETIME NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gift (
        username TEXT NOT NULL,
        gift_name TEXT NOT NULL,
        gift_num INT NOT NULL,
        unit_price REAL NOT NULL,
        total_price REAL NOT NULL,
        ts DATETIME NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integral (
        platform TEXT NOT NULL,
        username TEXT NOT NULL,
        uid TEXT NOT NULL,
        integral INT NOT NULL,
        view_num INT NOT NULL,
        sign_num INT NOT NULL,
        last_sign_ts DATETIME NOT NULL,
        total_price REAL NOT NULL,
        last_ts DATETIME NOT NULL
      );
      CREATE TABLE IF NOT EXISTS engagement_daily_award (
        platform TEXT NOT NULL,
        uid TEXT NOT NULL,
        username TEXT NOT NULL,
        award_type TEXT NOT NULL CHECK (award_type IN ('sign', 'entrance')),
        local_date TEXT NOT NULL,
        awarded_at DATETIME NOT NULL,
        points INT NOT NULL,
        PRIMARY KEY (platform, uid, award_type, local_date)
      );
    `);

    requiredColumns(database, "danmu", ["username", "content", "ts"]);
    requiredColumns(database, "entrance", ["username", "ts"]);
    requiredColumns(database, "gift", [
      "username",
      "gift_name",
      "gift_num",
      "unit_price",
      "total_price",
      "ts",
    ]);
    requiredColumns(database, "integral", [
      "platform",
      "username",
      "uid",
      "integral",
      "view_num",
      "sign_num",
      "last_sign_ts",
      "total_price",
      "last_ts",
    ]);
    migrateDailyAwardTable(database);
    requiredColumns(database, "engagement_daily_award", [
      "platform",
      "uid",
      "username",
      "award_type",
      "local_date",
      "awarded_at",
      "points",
    ]);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_avt_danmu_ts
        ON danmu(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_avt_entrance_ts
        ON entrance(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_avt_gift_ts
        ON gift(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_avt_gift_username_total
        ON gift(username, total_price DESC);
      CREATE INDEX IF NOT EXISTS idx_avt_integral_identity
        ON integral(username, platform);
      CREATE INDEX IF NOT EXISTS idx_avt_integral_points
        ON integral(integral DESC);
      CREATE INDEX IF NOT EXISTS idx_avt_daily_award_date
        ON engagement_daily_award(local_date, award_type);
    `);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure, which is more actionable.
    }
    throw error;
  }
}

function prepareStatements(database: DatabaseSync): RepositoryStatements {
  const rankingSql = (metric: IntegralRankingMetric): StatementSync =>
    database.prepare(`
      SELECT
        rowid AS row_id,
        platform,
        username,
        uid,
        integral,
        view_num,
        sign_num,
        last_sign_ts,
        total_price,
        last_ts
      FROM integral
      ORDER BY ${metric} DESC, username COLLATE NOCASE ASC, rowid ASC
      LIMIT ?
    `);

  return {
    insertComment: database.prepare(
      "INSERT INTO danmu (username, content, ts) VALUES (?, ?, ?)",
    ),
    insertEntrance: database.prepare(
      "INSERT INTO entrance (username, ts) VALUES (?, ?)",
    ),
    insertGift: database.prepare(`
      INSERT INTO gift
        (username, gift_name, gift_num, unit_price, total_price, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    findAccountByUsername: database.prepare(`
      SELECT
        rowid AS row_id,
        platform,
        username,
        uid,
        integral,
        view_num,
        sign_num,
        last_sign_ts,
        total_price,
        last_ts
      FROM integral
      WHERE platform = ? AND username = ?
      ORDER BY rowid ASC
      LIMIT 1
    `),
    findAccountByUid: database.prepare(`
      SELECT
        rowid AS row_id,
        platform,
        username,
        uid,
        integral,
        view_num,
        sign_num,
        last_sign_ts,
        total_price,
        last_ts
      FROM integral
      WHERE platform = ? AND uid = ?
      ORDER BY rowid ASC
      LIMIT 1
    `),
    insertAccount: database.prepare(`
      INSERT INTO integral
        (platform, username, uid, integral, view_num, sign_num,
         last_sign_ts, total_price, last_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateIdentity: database.prepare(`
      UPDATE integral
      SET username = ?, uid = ?
      WHERE rowid = ?
    `),
    updateSign: database.prepare(`
      UPDATE integral
      SET integral = ?, sign_num = ?, last_sign_ts = ?
      WHERE rowid = ?
    `),
    updateEntrance: database.prepare(`
      UPDATE integral
      SET integral = ?, view_num = ?, last_ts = ?
      WHERE rowid = ?
    `),
    updateGift: database.prepare(`
      UPDATE integral
      SET integral = ?, total_price = ?
      WHERE rowid = ?
    `),
    findDailyAward: database.prepare(`
      SELECT 1 AS found
      FROM engagement_daily_award
      WHERE platform = ? AND uid = ? AND award_type = ? AND local_date = ?
      LIMIT 1
    `),
    insertDailyAward: database.prepare(`
      INSERT OR IGNORE INTO engagement_daily_award
        (platform, uid, username, award_type, local_date, awarded_at, points)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    copyDailyAwardsIdentity: database.prepare(`
      INSERT OR IGNORE INTO engagement_daily_award
        (platform, uid, username, award_type, local_date, awarded_at, points)
      SELECT platform, ?, ?, award_type, local_date, awarded_at, points
      FROM engagement_daily_award
      WHERE platform = ? AND uid = ?
    `),
    deleteDailyAwardsIdentity: database.prepare(`
      DELETE FROM engagement_daily_award
      WHERE platform = ? AND uid = ?
    `),
    recentComments: database.prepare(`
      SELECT content
      FROM danmu
      ORDER BY rowid DESC
      LIMIT ?
    `),
    integralRankings: {
      integral: rankingSql("integral"),
      view_num: rankingSql("view_num"),
      sign_num: rankingSql("sign_num"),
      total_price: rankingSql("total_price"),
    },
    giftAggregates: database.prepare(`
      SELECT
        username,
        COUNT(*) AS event_count,
        COALESCE(SUM(gift_num), 0) AS gift_count,
        COALESCE(SUM(total_price), 0.0) AS total_price,
        MAX(ts) AS last_gift_at
      FROM gift
      GROUP BY username
      ORDER BY total_price DESC, username COLLATE NOCASE ASC
      LIMIT ?
    `),
  };
}

export class SqliteRepository implements Disposable {
  readonly path: string;
  private database: DatabaseSync | undefined;
  private readonly statements: RepositoryStatements;

  constructor(path: string, options: SqliteRepositoryOptions = {}) {
    if (path.trim().length === 0) {
      throw new PersistenceError(
        "INVALID_DATABASE_PATH",
        "database path must be a non-empty string",
      );
    }

    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new PersistenceError(
        "INVALID_INPUT",
        "busyTimeoutMs must be a non-negative safe integer",
      );
    }

    this.path = path;
    if (path !== ":memory:") {
      try {
        mkdirSync(dirname(resolve(path)), { recursive: true });
      } catch (error) {
        throw new PersistenceError(
          "OPEN_FAILED",
          `failed to create the database directory for ${path}`,
          error,
        );
      }
    }

    let database: DatabaseSync;
    try {
      database = new DatabaseSync(path, {
        enableForeignKeyConstraints: true,
        timeout: busyTimeoutMs,
      });
    } catch (error) {
      throw new PersistenceError(
        "OPEN_FAILED",
        `failed to open SQLite database ${path}`,
        error,
      );
    }
    this.database = database;

    try {
      if (path !== ":memory:" && options.enableWal !== false) {
        const result = asRow(
          database.prepare("PRAGMA journal_mode = WAL").get(),
          "journal mode configuration",
        );
        const mode = rowString(result, "journal_mode").toLowerCase();
        if (mode !== "wal") {
          throw new PersistenceError(
            "DATABASE_CONFIGURATION_FAILED",
            `SQLite refused WAL mode for ${path}; active mode is ${mode}`,
          );
        }
        database.exec("PRAGMA synchronous = NORMAL");
      }
      database.exec("PRAGMA foreign_keys = ON");
    } catch (error) {
      database.close();
      this.database = undefined;
      if (error instanceof PersistenceError) {
        throw error;
      }
      throw new PersistenceError(
        "DATABASE_CONFIGURATION_FAILED",
        `failed to configure SQLite database ${path}`,
        error,
      );
    }

    try {
      migrate(database);
      this.statements = prepareStatements(database);
    } catch (error) {
      database.close();
      this.database = undefined;
      if (
        error instanceof PersistenceError &&
        error.code === "INCOMPATIBLE_SCHEMA"
      ) {
        throw error;
      }
      throw new PersistenceError(
        "MIGRATION_FAILED",
        `failed to migrate SQLite database ${path}`,
        error,
      );
    }
  }

  recordComment(record: CommentRecord): void {
    this.assertOpen();
    assertNonEmptyString(record.username, "username");
    assertDate(record.timestamp, "timestamp");
    this.statements.insertComment.run(
      record.username,
      record.content,
      toLegacyDateTime(record.timestamp),
    );
  }

  recordEntrance(record: EntranceRecord): void {
    this.assertOpen();
    assertNonEmptyString(record.username, "username");
    assertDate(record.timestamp, "timestamp");
    this.statements.insertEntrance.run(
      record.username,
      toLegacyDateTime(record.timestamp),
    );
  }

  recordGift(record: GiftRecord): void {
    this.assertOpen();
    assertNonEmptyString(record.username, "username");
    assertNonEmptyString(record.giftName, "giftName");
    assertNonNegativeSafeInteger(record.quantity, "quantity");
    if (record.quantity < 1) {
      throw new PersistenceError(
        "INVALID_INPUT",
        "quantity must be greater than zero",
      );
    }
    assertDate(record.timestamp, "timestamp");
    this.statements.insertGift.run(
      record.username,
      record.giftName,
      record.quantity,
      normalizeMoney(record.unitPrice),
      normalizeMoney(record.totalPrice),
      toLegacyDateTime(record.timestamp),
    );
  }

  getIntegralAccount(
    platform: string,
    username: string,
    uid?: string,
  ): IntegralAccount | undefined {
    this.assertOpen();
    assertNonEmptyString(platform, "platform");
    assertNonEmptyString(username, "username");
    if (uid === undefined) {
      const account = this.findStoredAccountByUsername(platform, username);
      return account === undefined ? undefined : publicAccount(account);
    }
    assertNonEmptyString(uid, "uid");
    return this.transaction("integral identity resolution", () => {
      const account = this.resolveStoredAccount({ platform, username, uid });
      return account === undefined ? undefined : publicAccount(account);
    });
  }

  awardDaily(request: DailyAwardRequest): DailyAwardResult {
    this.assertOpen();
    this.assertIdentity(request);
    assertNonNegativeSafeInteger(request.points, "points");
    assertDate(request.occurredAt, "occurredAt");

    return this.transaction("daily integral award", () => {
      const localDate = toLocalDateKey(request.occurredAt);
      let account = this.resolveStoredAccount(
        request,
        request.uidIsStable !== false,
      );
      const accountUid = account?.uid ?? request.uid;
      const alreadyClaimed =
        this.statements.findDailyAward.get(
          request.platform,
          accountUid,
          request.type,
          localDate,
        ) !== undefined;

      const legacyTimestamp =
        request.type === "sign" ? account?.lastSignAt : account?.lastEntranceAt;
      const legacyCount =
        request.type === "sign" ? account?.signCount : account?.viewCount;
      const legacyAlreadyClaimed =
        account !== undefined &&
        (legacyCount ?? 0) > 0 &&
        legacyTimestamp !== undefined &&
        isSameLocalDate(legacyTimestamp, localDate);

      if (alreadyClaimed || legacyAlreadyClaimed) {
        if (account === undefined) {
          throw new PersistenceError(
            "INCOMPATIBLE_SCHEMA",
            "a daily award exists without its integral account",
          );
        }
        if (!alreadyClaimed) {
          this.statements.insertDailyAward.run(
            request.platform,
            accountUid,
            request.username,
            request.type,
            localDate,
            toLegacyDateTime(request.occurredAt),
            0,
          );
        }
        return { awarded: false, account: publicAccount(account) };
      }

      const claim = this.statements.insertDailyAward.run(
        request.platform,
        accountUid,
        request.username,
        request.type,
        localDate,
        toLegacyDateTime(request.occurredAt),
        request.points,
      );
      if (Number(claim.changes) !== 1) {
        account = this.findStoredAccountByUid(request.platform, accountUid);
        if (account === undefined) {
          throw new PersistenceError(
            "INCOMPATIBLE_SCHEMA",
            "daily award conflict occurred without an integral account",
          );
        }
        return { awarded: false, account: publicAccount(account) };
      }

      if (account === undefined) {
        const isSign = request.type === "sign";
        this.statements.insertAccount.run(
          request.platform,
          request.username,
          request.uid,
          request.points,
          isSign ? 0 : 1,
          isSign ? 1 : 0,
          isSign
            ? toLegacyDateTime(request.occurredAt)
            : EMPTY_LEGACY_TIMESTAMP,
          0,
          isSign
            ? EMPTY_LEGACY_TIMESTAMP
            : toLegacyDateTime(request.occurredAt),
        );
      } else if (request.type === "sign") {
        this.statements.updateSign.run(
          account.integral + request.points,
          account.signCount + 1,
          toLegacyDateTime(request.occurredAt),
          account.rowId,
        );
      } else {
        this.statements.updateEntrance.run(
          account.integral + request.points,
          account.viewCount + 1,
          toLegacyDateTime(request.occurredAt),
          account.rowId,
        );
      }

      account = this.findStoredAccountByUid(request.platform, accountUid);
      if (account === undefined) {
        throw new PersistenceError(
          "TRANSACTION_FAILED",
          "daily award did not produce an integral account",
        );
      }
      return { awarded: true, account: publicAccount(account) };
    });
  }

  applyGiftIntegral(request: GiftIntegralRequest): IntegralAccount {
    this.assertOpen();
    this.assertIdentity(request);
    assertNonNegativeSafeInteger(request.points, "points");
    assertDate(request.occurredAt, "occurredAt");
    const giftPrice = normalizeMoney(request.totalPrice);

    return this.transaction("gift integral update", () => {
      let account = this.resolveStoredAccount(
        request,
        request.uidIsStable !== false,
      );
      const accountUid = account?.uid ?? request.uid;
      if (account === undefined) {
        this.statements.insertAccount.run(
          request.platform,
          request.username,
          request.uid,
          request.points,
          0,
          0,
          EMPTY_LEGACY_TIMESTAMP,
          giftPrice,
          EMPTY_LEGACY_TIMESTAMP,
        );
      } else {
        this.statements.updateGift.run(
          account.integral + request.points,
          normalizeMoney(account.totalPrice + giftPrice),
          account.rowId,
        );
      }

      account = this.findStoredAccountByUid(request.platform, accountUid);
      if (account === undefined) {
        throw new PersistenceError(
          "TRANSACTION_FAILED",
          "gift update did not produce an integral account",
        );
      }
      return publicAccount(account);
    });
  }

  listRecentCommentContent(limit: number): readonly string[] {
    this.assertOpen();
    assertLimit(limit);
    const rows = this.statements.recentComments.all(limit) as unknown[];
    return rows.map((value) =>
      rowString(asRow(value, "recent comments query"), "content"),
    );
  }

  listIntegralRanking(
    metric: IntegralRankingMetric,
    limit: number,
  ): readonly IntegralRankingRow[] {
    this.assertOpen();
    assertLimit(limit);
    const statement = this.statements.integralRankings[metric];
    if (statement === undefined) {
      throw new PersistenceError(
        "INVALID_INPUT",
        `unsupported integral ranking metric: ${String(metric)}`,
      );
    }
    const rows = statement.all(limit) as unknown[];
    return rows.map((value) => publicAccount(mapIntegralAccount(value)));
  }

  listGiftAggregates(limit: number): readonly GiftAggregateRow[] {
    this.assertOpen();
    assertLimit(limit);
    const rows = this.statements.giftAggregates.all(limit) as unknown[];
    return rows.map((value) => {
      const row = asRow(value, "gift aggregate query");
      return {
        username: rowString(row, "username"),
        eventCount: rowInteger(row, "event_count"),
        giftCount: rowInteger(row, "gift_count"),
        totalPrice: normalizeMoney(rowNumber(row, "total_price")),
        lastGiftAt: rowString(row, "last_gift_at"),
      };
    });
  }

  close(): void {
    const database = this.database;
    if (database === undefined) {
      return;
    }
    this.database = undefined;
    database.close();
  }

  async dispose(): Promise<void> {
    this.close();
  }

  private assertOpen(): DatabaseSync {
    const database = this.database;
    if (database === undefined) {
      throw new PersistenceError(
        "DATABASE_CLOSED",
        `SQLite database ${this.path} is closed`,
      );
    }
    return database;
  }

  private assertIdentity(identity: IntegralIdentity): void {
    assertNonEmptyString(identity.platform, "platform");
    assertNonEmptyString(identity.username, "username");
    assertNonEmptyString(identity.uid, "uid");
  }

  private findStoredAccountByUsername(
    platform: string,
    username: string,
  ): StoredIntegralAccount | undefined {
    const row = this.statements.findAccountByUsername.get(platform, username);
    return row === undefined ? undefined : mapIntegralAccount(row);
  }

  private findStoredAccountByUid(
    platform: string,
    uid: string,
  ): StoredIntegralAccount | undefined {
    const row = this.statements.findAccountByUid.get(platform, uid);
    return row === undefined ? undefined : mapIntegralAccount(row);
  }

  private resolveStoredAccount(
    identity: IntegralIdentity,
    uidIsStable = true,
  ): StoredIntegralAccount | undefined {
    if (!uidIsStable) {
      return this.findStoredAccountByUsername(
        identity.platform,
        identity.username,
      );
    }

    const byUid = this.findStoredAccountByUid(identity.platform, identity.uid);
    if (byUid !== undefined) {
      return this.synchronizeIdentity(byUid, identity);
    }

    const byUsername = this.findStoredAccountByUsername(
      identity.platform,
      identity.username,
    );
    if (
      byUsername === undefined ||
      (byUsername.uid !== identity.uid && byUsername.uid !== byUsername.username)
    ) {
      return undefined;
    }
    return this.synchronizeIdentity(byUsername, identity);
  }

  private synchronizeIdentity(
    account: StoredIntegralAccount,
    identity: IntegralIdentity,
  ): StoredIntegralAccount {
    if (
      account.username === identity.username &&
      account.uid === identity.uid
    ) {
      return account;
    }
    if (account.uid !== identity.uid) {
      this.statements.copyDailyAwardsIdentity.run(
        identity.uid,
        identity.username,
        identity.platform,
        account.uid,
      );
      this.statements.deleteDailyAwardsIdentity.run(
        identity.platform,
        account.uid,
      );
    }
    this.statements.updateIdentity.run(
      identity.username,
      identity.uid,
      account.rowId,
    );
    return {
      ...account,
      username: identity.username,
      uid: identity.uid,
    };
  }

  private transaction<T>(operation: string, callback: () => T): T {
    const database = this.assertOpen();
    try {
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw new PersistenceError(
        "TRANSACTION_FAILED",
        `failed to begin ${operation}`,
        error,
      );
    }

    try {
      const result = callback();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the operation failure rather than masking it with rollback.
      }
      if (error instanceof PersistenceError) {
        throw error;
      }
      throw new PersistenceError(
        "TRANSACTION_FAILED",
        `${operation} failed`,
        error,
      );
    }
  }
}
