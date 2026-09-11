import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "../src/config/config-store.js";
import type {
  AgentExecutor,
  SpeechService,
} from "../src/core/contracts.js";
import { EventProcessor } from "../src/core/event-processor.js";
import type {
  AppEvent,
  LiveEvent,
  Metadata,
  SpeechRequest,
} from "../src/domain/types.js";
import { AnalyticsService } from "../src/features/analytics/index.js";
import {
  EngagementService,
  createEngagementMiddleware,
} from "../src/features/engagement/index.js";
import {
  PersistenceError,
  SqliteRepository,
} from "../src/persistence/index.js";
import { normalizeLivePayload } from "../src/platforms/index.js";

const temporaryDirectories: string[] = [];
const repositories = new Set<SqliteRepository>();
let nextEventId = 0;

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ai-vtuber-persistence-"));
  temporaryDirectories.push(directory);
  return join(directory, "data.db");
}

function openRepository(path: string): SqliteRepository {
  const repository = new SqliteRepository(path);
  repositories.add(repository);
  return repository;
}

function event(
  type: LiveEvent["type"],
  username: string,
  content: string,
  metadata: Metadata = {},
  timestamp = new Date(2026, 0, 15, 12, 0, 0).getTime(),
): LiveEvent {
  nextEventId += 1;
  return {
    id: `test-event-${nextEventId}`,
    type,
    platform: "test-platform",
    username,
    content,
    timestamp,
    metadata,
  };
}

function config(databaseEnabled = true): JsonObject {
  return {
    database: {
      comment_enable: databaseEnabled,
      entrance_enable: databaseEnabled,
      gift_enable: databaseEnabled,
    },
    integral: {
      enable: true,
      sign: {
        enable: true,
        cmd: ["签到", "打卡"],
        get_integral: 2,
        copywriting: [
          {
            sign_num_interval: "0-1000",
            copywriting: [
              "{username}签到成功，获得{get_integral}积分，第{sign_num}天[甲|乙]",
            ],
          },
        ],
      },
      entrance: {
        enable: true,
        get_integral: 3,
        copywriting: [
          {
            entrance_num_interval: "0-1000",
            copywriting: ["欢迎{username}，第{entrance_num}次观看"],
          },
        ],
      },
      gift: {
        enable: true,
        get_integral_proportion: 10,
        copywriting: [
          {
            gift_price_interval: "0-1000000",
            copywriting: [
              "感谢{username}的{gift_name}，{gift_num}个，共{total_price}元，获得{get_integral}积分",
            ],
          },
        ],
      },
      crud: {
        query: {
          enable: true,
          cmd: ["我的积分", "查询积分"],
          copywriting: ["{username}，您当前的积分是{integral}"],
        },
      },
    },
  };
}

function scalarCount(path: string, table: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
      | { readonly count: number }
      | undefined;
    return row?.count ?? 0;
  } finally {
    database.close();
  }
}

function closeRepository(repository: SqliteRepository): void {
  repository.close();
  repositories.delete(repository);
}

afterEach(async () => {
  for (const repository of repositories) {
    repository.close();
  }
  repositories.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("SqliteRepository migrations", () => {
  it("preserves legacy comment rows across repeated migrations", async () => {
    const path = await temporaryDatabasePath();
    const rows = [
      { username: "旧用户", content: "历史记录一", ts: "2025-01-01 12:00:00.000" },
      { username: "另一用户", content: "历史记录二", ts: "2025-01-02 12:00:00.000" },
    ];
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        CREATE TABLE danmu (
          username TEXT NOT NULL,
          content TEXT NOT NULL,
          ts DATETIME NOT NULL
        );
      `);
      const insert = legacy.prepare("INSERT INTO danmu VALUES (?, ?, ?)");
      for (const row of rows) insert.run(row.username, row.content, row.ts);
    } finally {
      legacy.close();
    }

    for (let opening = 0; opening < 2; opening += 1) {
      const repository = openRepository(path);
      expect(repository.listRecentCommentContent(5)).toEqual(["历史记录二", "历史记录一"]);
      closeRepository(repository);
    }

    const migrated = new DatabaseSync(path, { readOnly: true });
    try {
      expect(migrated.prepare("SELECT username, content, ts FROM danmu ORDER BY rowid").all())
        .toEqual(rows);
    } finally {
      migrated.close();
    }
  });

  it("migrates daily claims to stable user ids across nickname changes", async () => {
    const path = await temporaryDatabasePath();
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        CREATE TABLE integral (
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
        INSERT INTO integral VALUES (
          'bilibili-web',
          '旧昵称',
          '1001',
          5,
          0,
          1,
          '2026-09-05 10:00:00.000',
          0,
          '1970-01-01 00:00:00.000'
        );
        CREATE TABLE engagement_daily_award (
          platform TEXT NOT NULL,
          username TEXT NOT NULL,
          award_type TEXT NOT NULL CHECK (award_type IN ('sign', 'entrance')),
          local_date TEXT NOT NULL,
          awarded_at DATETIME NOT NULL,
          points INT NOT NULL,
          PRIMARY KEY (platform, username, award_type, local_date)
        );
        INSERT INTO engagement_daily_award VALUES (
          'bilibili-web',
          '旧昵称',
          'sign',
          '2026-09-06',
          '2026-09-06 08:00:00.000',
          2
        );
      `);
    } finally {
      legacy.close();
    }

    const repository = openRepository(path);
    const duplicate = repository.awardDaily({
      platform: "bilibili-web",
      username: "新昵称",
      uid: "1001",
      type: "sign",
      points: 2,
      occurredAt: new Date(2026, 8, 6, 20, 0),
    });
    expect(duplicate).toMatchObject({
      awarded: false,
      account: {
        username: "新昵称",
        uid: "1001",
        integral: 5,
        signCount: 1,
      },
    });
    closeRepository(repository);

    const migrated = new DatabaseSync(path, { readOnly: true });
    try {
      const columns = migrated
        .prepare("PRAGMA table_info(engagement_daily_award)")
        .all();
      const claims = migrated
        .prepare(`
          SELECT uid, username, points
          FROM engagement_daily_award
          WHERE platform = ? AND award_type = ? AND local_date = ?
        `)
        .all("bilibili-web", "sign", "2026-09-06");
      expect(columns.map(({ name }) => name)).toContain("uid");
      expect(claims).toEqual([{ uid: "1001", username: "旧昵称", points: 2 }]);
    } finally {
      migrated.close();
    }
  });

  it("creates every legacy table in a new database and disposes idempotently", async () => {
    const path = await temporaryDatabasePath();
    const repository = openRepository(path);
    expect(repository.listRecentCommentContent(10)).toEqual([]);

    closeRepository(repository);
    repository.close();
    await repository.dispose();
    expect(() => repository.listRecentCommentContent(1)).toThrowError(
      expect.objectContaining({ code: "DATABASE_CLOSED" }),
    );

    for (const table of ["danmu", "entrance", "gift", "integral"] as const) {
      expect(scalarCount(path, table)).toBe(0);
    }
  });
});

describe("EngagementService", () => {
  it("records comment, entrance, and gift events in the legacy tables", async () => {
    const path = await temporaryDatabasePath();
    const repository = openRepository(path);
    const service = new EngagementService({
      repository,
      now: () => new Date(2026, 0, 15, 12, 0).getTime(),
      random: () => 0,
    });
    const settings = config();

    expect(service.handle(event("comment", "小明", "普通弹幕"), settings)).toEqual({
      type: "continue",
    });
    expect(service.handle(event("entrance", "小明", "进入直播间"), settings).type).toBe(
      "reply",
    );
    expect(
      service.handle(
        event("gift", "小明", "小花", {
          giftName: "小花",
          quantity: 2,
          unitPrice: 1.25,
        }),
        settings,
      ).type,
    ).toBe("reply");

    closeRepository(repository);
    expect(scalarCount(path, "danmu")).toBe(1);
    expect(scalarCount(path, "entrance")).toBe(1);
    expect(scalarCount(path, "gift")).toBe(1);

    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const gift = database
        .prepare(
          "SELECT username, gift_name, gift_num, unit_price, total_price FROM gift",
        )
        .get() as Readonly<Record<string, string | number>>;
      expect(gift).toMatchObject({
        username: "小明",
        gift_name: "小花",
        gift_num: 2,
        unit_price: 1.25,
        total_price: 2.5,
      });
    } finally {
      database.close();
    }
  });

  it("awards sign-in and entrance at most once per local calendar day", async () => {
    const path = await temporaryDatabasePath();
    const repository = openRepository(path);
    let now = new Date(2026, 2, 8, 23, 59, 59).getTime();
    const service = new EngagementService({
      repository,
      now: () => now,
      random: () => 0,
    });
    const settings = config(false);
    const sign = event("comment", "alice", "签到");

    const first = service.handle(sign, settings);
    const duplicate = service.handle({ ...sign, id: "second-sign" }, settings);
    expect(first).toMatchObject({ type: "reply", reason: "sign" });
    expect(duplicate).toMatchObject({
      type: "reply",
      reason: "sign-duplicate",
    });
    expect(repository.getIntegralAccount("test-platform", "alice")).toMatchObject({
      integral: 2,
      signCount: 1,
    });

    now = new Date(2026, 2, 9, 0, 0, 1).getTime();
    expect(service.handle({ ...sign, id: "next-day-sign" }, settings)).toMatchObject({
      type: "reply",
      reason: "sign",
    });
    expect(repository.getIntegralAccount("test-platform", "alice")).toMatchObject({
      integral: 4,
      signCount: 2,
    });

    const entrance = event("entrance", "viewer", "进入直播间");
    expect(service.handle(entrance, settings)).toMatchObject({
      type: "reply",
      reason: "entrance",
    });
    expect(
      service.handle({ ...entrance, id: "same-day-entrance" }, settings),
    ).toEqual({ type: "continue" });
    expect(repository.getIntegralAccount("test-platform", "viewer")).toMatchObject({
      integral: 3,
      viewCount: 1,
    });
  });

  it("serializes daily claims made through separate SQLite connections", async () => {
    const path = await temporaryDatabasePath();
    const firstRepository = openRepository(path);
    const secondRepository = openRepository(path);
    const request = {
      type: "sign" as const,
      platform: "test-platform",
      username: "concurrent-user",
      uid: "uid-1",
      points: 7,
      occurredAt: new Date(2026, 5, 1, 8, 0),
    };

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => firstRepository.awardDaily(request)),
      Promise.resolve().then(() => secondRepository.awardDaily(request)),
    ]);

    expect([first.awarded, second.awarded].filter(Boolean)).toHaveLength(1);
    expect(
      firstRepository.getIntegralAccount("test-platform", "concurrent-user"),
    ).toMatchObject({ integral: 7, signCount: 1 });
  });

  it("converts gift money to points explicitly and serves legacy balance commands", async () => {
    const path = await temporaryDatabasePath();
    const repository = openRepository(path);
    const fixedNow = new Date(2026, 6, 1, 9, 5).getTime();
    const service = new EngagementService({
      repository,
      now: () => fixedNow,
      random: () => 0,
    });
    const settings = config();

    const first = service.handle(
      event("gift", "giver", "玫瑰", {
        giftName: "玫瑰",
        quantity: 2,
        unitPrice: 1.25,
      }),
      settings,
    );
    const second = service.handle(
      event("gift", "giver", "星星", {
        giftName: "星星",
        quantity: 1,
        totalPrice: 0.55,
      }),
      settings,
    );
    const query = service.handle(event("comment", "giver", "我的积分"), settings);

    expect(first).toMatchObject({
      type: "reply",
      reason: "gift",
      account: { integral: 25, totalPrice: 2.5 },
    });
    expect(second).toMatchObject({
      type: "reply",
      reason: "gift",
      account: { integral: 30, totalPrice: 3.05 },
    });
    expect(query).toMatchObject({
      type: "reply",
      reason: "query",
      text: "giver，您当前的积分是30",
    });
  });

  it.each([
    {
      platform: "bilibili-web",
      uid: "456",
      comment: (username: string, content: string) => ({
        cmd: "DANMU_MSG",
        info: [
          [0, 1, 25, 16_777_215, 1_780_000_000],
          content,
          [456, username],
        ],
      }),
      entrance: {
        cmd: "INTERACT_WORD",
        data: {
          msg_type: 1,
          uid: 456,
          uname: "新昵称",
          timestamp: 1_780_000_000,
        },
      },
      gift: {
        cmd: "SEND_GIFT",
        data: {
          tid: "web-gift",
          uid: 456,
          uname: "新昵称",
          giftName: "小花",
          num: 1,
          total_coin: 2_500,
          timestamp: 1_780_000_000,
        },
      },
    },
    {
      platform: "bilibili-platform",
      uid: "open-user-1",
      comment: (username: string, content: string) => ({
        cmd: "LIVE_OPEN_PLATFORM_DM",
        data: {
          msg_id: `${username}-${content}`,
          open_id: "open-user-1",
          uname: username,
          msg: content,
          timestamp: 1_780_000_000,
        },
      }),
      entrance: {
        cmd: "LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER",
        data: {
          msg_id: "platform-entrance",
          open_id: "open-user-1",
          uname: "新昵称",
          timestamp: 1_780_000_000,
        },
      },
      gift: {
        cmd: "LIVE_OPEN_PLATFORM_SEND_GIFT",
        data: {
          msg_id: "platform-gift",
          open_id: "open-user-1",
          uname: "新昵称",
          gift_name: "小花",
          gift_num: 1,
          gift_price: 2_500,
          timestamp: 1_780_000_000,
        },
      },
    },
  ])(
    "processes $platform events through the complete integral flow",
    async ({ platform, uid, comment, entrance, gift }) => {
      const path = await temporaryDatabasePath();
      const repository = openRepository(path);
      const occurredAt = new Date(2026, 8, 6, 12, 0).getTime();
      const service = new EngagementService({
        repository,
        now: () => occurredAt,
        random: () => 0,
      });
      const settings = config(false);
      const normalize = (payload: unknown): LiveEvent => {
        const events = normalizeLivePayload(payload, {
          platform,
          now: () => occurredAt,
        });
        expect(events).toHaveLength(1);
        return events[0]!;
      };

      expect(
        service.handle(normalize(comment("旧昵称", "签到")), settings),
      ).toMatchObject({ type: "reply", reason: "sign" });
      expect(
        service.handle(normalize(comment("新昵称", "签到")), settings),
      ).toMatchObject({ type: "reply", reason: "sign-duplicate" });
      expect(service.handle(normalize(entrance), settings)).toMatchObject({
        type: "reply",
        reason: "entrance",
      });
      expect(service.handle(normalize(gift), settings)).toMatchObject({
        type: "reply",
        reason: "gift",
      });
      expect(
        service.handle(normalize(comment("新昵称", "我的积分")), settings),
      ).toMatchObject({
        type: "reply",
        reason: "query",
        text: "新昵称，您当前的积分是30",
      });
      expect(repository.getIntegralAccount(platform, "新昵称", uid)).toMatchObject({
        username: "新昵称",
        uid,
        integral: 30,
        signCount: 1,
        viewCount: 1,
        totalPrice: 2.5,
      });
    },
  );

  it("isolates integral identities with the same username across platforms", async () => {
    const path = await temporaryDatabasePath();
    const repository = openRepository(path);
    const occurredAt = new Date(2026, 7, 2, 12, 0);
    const username = "shared-user";
    const firstPlatform = "platform-one";
    const secondPlatform = "platform-two";

    expect(
      repository.applyGiftIntegral({
        platform: firstPlatform,
        username,
        uid: "first-platform-id",
        points: 20,
        totalPrice: 1.25,
        occurredAt,
      }),
    ).toMatchObject({
      platform: firstPlatform,
      username,
      uid: "first-platform-id",
      integral: 20,
      totalPrice: 1.25,
    });
    expect(
      repository.applyGiftIntegral({
        platform: secondPlatform,
        username,
        uid: "second-platform-id",
        points: 4,
        totalPrice: 4.5,
        occurredAt,
      }),
    ).toMatchObject({
      platform: secondPlatform,
      username,
      uid: "second-platform-id",
      integral: 4,
      totalPrice: 4.5,
    });

    repository.applyGiftIntegral({
      platform: firstPlatform,
      username,
      uid: "first-platform-id",
      points: 5,
      totalPrice: 0.75,
      occurredAt,
    });
    repository.applyGiftIntegral({
      platform: secondPlatform,
      username,
      uid: "second-platform-id",
      points: 3,
      totalPrice: 1.5,
      occurredAt,
    });
    repository.awardDaily({
      type: "sign",
      platform: firstPlatform,
      username,
      uid: "first-platform-id",
      points: 2,
      occurredAt,
    });
    repository.awardDaily({
      type: "entrance",
      platform: secondPlatform,
      username,
      uid: "second-platform-id",
      points: 3,
      occurredAt,
    });

    expect(scalarCount(path, "integral")).toBe(2);
    expect(repository.getIntegralAccount(firstPlatform, username)).toMatchObject({
      platform: firstPlatform,
      username,
      uid: "first-platform-id",
      integral: 27,
      totalPrice: 2,
      signCount: 1,
      viewCount: 0,
    });
    expect(repository.getIntegralAccount(secondPlatform, username)).toMatchObject({
      platform: secondPlatform,
      username,
      uid: "second-platform-id",
      integral: 10,
      totalPrice: 6,
      signCount: 0,
      viewCount: 1,
    });
    expect(repository.getIntegralAccount("unregistered-platform", username)).toBe(
      undefined,
    );

    const service = new EngagementService({
      repository,
      now: () => occurredAt.getTime(),
      random: () => 0,
    });
    const settings = config(false);
    const query = (platform: string) =>
      service.handle(
        { ...event("comment", username, "我的积分"), platform },
        settings,
      );

    expect(query(firstPlatform)).toMatchObject({
      type: "reply",
      reason: "query",
      text: `${username}，您当前的积分是27`,
      account: { platform: firstPlatform, integral: 27, totalPrice: 2 },
    });
    expect(query(secondPlatform)).toMatchObject({
      type: "reply",
      reason: "query",
      text: `${username}，您当前的积分是10`,
      account: { platform: secondPlatform, integral: 10, totalPrice: 6 },
    });
    expect(query("unregistered-platform")).toEqual({
      type: "reply",
      reason: "query",
      text: `${username}，查询到您无积分。`,
    });

    expect(
      repository.listIntegralRanking("integral", 10).map((account) => ({
        platform: account.platform,
        username: account.username,
        integral: account.integral,
        totalPrice: account.totalPrice,
      })),
    ).toEqual([
      {
        platform: firstPlatform,
        username,
        integral: 27,
        totalPrice: 2,
      },
      {
        platform: secondPlatform,
        username,
        integral: 10,
        totalPrice: 6,
      },
    ]);
    expect(
      repository.listIntegralRanking("total_price", 10).map((account) => ({
        platform: account.platform,
        username: account.username,
        integral: account.integral,
        totalPrice: account.totalPrice,
      })),
    ).toEqual([
      {
        platform: secondPlatform,
        username,
        integral: 10,
        totalPrice: 6,
      },
      {
        platform: firstPlatform,
        username,
        integral: 27,
        totalPrice: 2,
      },
    ]);
  });

  it("returns middleware replies that bypass the executor but still reach hooks and speech", async () => {
    const path = await temporaryDatabasePath();
    const repository = openRepository(path);
    const settings = config(false);
    const now = new Date(2026, 7, 1, 10, 0).getTime();
    let executorCalls = 0;
    let hookCalls = 0;
    const spoken: SpeechRequest[] = [];
    const published: AppEvent[] = [];

    const executor: AgentExecutor = {
      async execute() {
        executorCalls += 1;
        return { text: "LLM must not run", model: "fake", provider: "fake" };
      },
      async *stream() {
        executorCalls += 1;
        yield "LLM must not run";
      },
      async reset() {},
    };
    const speech: SpeechService = {
      async enqueue(request) {
        spoken.push(request);
        return "speech-1";
      },
      async enqueueAudio(request) {
        spoken.push(request);
        return "speech-1";
      },
      async stop() {},
      status() {
        return { state: "idle", queued: 0 };
      },
      async dispose() {},
    };
    const processor = new EventProcessor({
      config: { path: join(path, "config.json"), snapshot: () => settings },
      executor,
      publisher: { publish: (appEvent) => published.push(appEvent) },
      speech,
      middleware: [
        createEngagementMiddleware({ repository, now: () => now, random: () => 0 }),
      ],
      replyHooks: [
        (reply) => {
          hookCalls += 1;
          return { ...reply, text: `${reply.text}，已确认` };
        },
      ],
      now: () => now,
    });

    const reply = await processor.process(event("comment", "hook-user", "签到"));

    expect(executorCalls).toBe(0);
    expect(hookCalls).toBe(1);
    expect(reply).toMatchObject({ source: "command", speechId: "speech-1" });
    expect(reply?.text.endsWith("，已确认")).toBe(true);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toBe(reply?.text);
    expect(published.some((appEvent) => appEvent.type === "agent.completed")).toBe(
      true,
    );
    await processor.dispose();
  });

  it("filters discarded and replaced sign-in input before engagement middleware", async () => {
    const path = await temporaryDatabasePath();
    const repository = openRepository(path);
    const now = new Date(2026, 7, 1, 10, 0).getTime();
    await writeFile(join(path, "..", "badwords.txt"), "坏\n");
    const settings = config(false);
    settings.filter = {
      badwords: {
        enable: true,
        discard: true,
        path: "badwords.txt",
        replace: "",
      },
    };
    const processor = new EventProcessor({
      config: { path: join(path, "..", "config.json"), snapshot: () => settings },
      executor: {
        async execute() {
          return { text: "LLM must not run", model: "fake", provider: "fake" };
        },
        async *stream() {},
        async reset() {},
      },
      publisher: { publish() {} },
      middleware: [
        createEngagementMiddleware({ repository, now: () => now, random: () => 0 }),
      ],
    });

    expect(await processor.process(event("comment", "坏alice", "签到"))).toBeUndefined();
    expect(repository.getIntegralAccount("test-platform", "坏alice")).toBeUndefined();

    settings.filter = {
      badwords: {
        enable: true,
        discard: false,
        path: "badwords.txt",
        replace: "",
      },
    };
    const reply = await processor.process(event("comment", "坏alice", "签坏到"));

    expect(reply).toMatchObject({ source: "command", text: expect.stringContaining("alice签到成功") });
    expect(repository.getIntegralAccount("test-platform", "alice")).toMatchObject({
      integral: 2,
      signCount: 1,
    });
    await processor.dispose();
  });
});

describe("AnalyticsService", () => {
  it("returns bounded, stable word, integral, and gift aggregate shapes", async () => {
    const path = await temporaryDatabasePath();
    const repository = openRepository(path);
    const timestamp = new Date(2026, 0, 1, 12, 0);
    repository.recordComment({
      username: "one",
      content: "hello world hello",
      timestamp,
    });
    repository.recordComment({
      username: "two",
      content: "hello there",
      timestamp,
    });
    repository.recordGift({
      username: "alice",
      giftName: "rose",
      quantity: 2,
      unitPrice: 1,
      totalPrice: 2,
      timestamp,
    });
    repository.recordGift({
      username: "alice",
      giftName: "star",
      quantity: 1,
      unitPrice: 1,
      totalPrice: 1,
      timestamp,
    });
    repository.recordGift({
      username: "bob",
      giftName: "crown",
      quantity: 1,
      unitPrice: 5,
      totalPrice: 5,
      timestamp,
    });
    repository.applyGiftIntegral({
      platform: "test-platform",
      username: "alice",
      uid: "alice-id",
      points: 50,
      totalPrice: 3,
      occurredAt: timestamp,
    });
    repository.applyGiftIntegral({
      platform: "test-platform",
      username: "bob",
      uid: "bob-id",
      points: 20,
      totalPrice: 5,
      occurredAt: timestamp,
    });

    const analytics = new AnalyticsService(repository, { locale: "en" });
    expect(
      analytics.commentWordFrequency({ limit: 10, sampleLimit: 10 }),
    ).toEqual({
      type: "commentWordFrequency",
      sampleSize: 2,
      sampleLimit: 10,
      items: [
        { name: "hello", value: 3 },
        { name: "there", value: 1 },
        { name: "world", value: 1 },
      ],
    });
    expect(analytics.integralRanking("integral", 10)).toMatchObject({
      type: "integralRanking",
      metric: "integral",
      limit: 10,
      items: [
        { rank: 1, username: "alice", integral: 50 },
        { rank: 2, username: "bob", integral: 20 },
      ],
    });
    expect(analytics.giftAggregates(10)).toEqual({
      type: "giftAggregates",
      limit: 10,
      items: [
        {
          rank: 1,
          username: "bob",
          eventCount: 1,
          giftCount: 1,
          totalPrice: 5,
          lastGiftAt: "2026-01-01 12:00:00.000",
        },
        {
          rank: 2,
          username: "alice",
          eventCount: 2,
          giftCount: 3,
          totalPrice: 3,
          lastGiftAt: "2026-01-01 12:00:00.000",
        },
      ],
    });
    expect(analytics.integralRanking("integral", 10_000).limit).toBe(100);
    expect(
      analytics.commentWordFrequency({ sampleLimit: 100_000 }).sampleLimit,
    ).toBe(50_000);
  });
});
