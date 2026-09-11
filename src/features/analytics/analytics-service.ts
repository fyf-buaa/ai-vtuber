import type {
  GiftAggregateRow,
  IntegralRankingMetric,
  IntegralRankingRow,
  SqliteRepository,
} from "../../persistence/sqlite-repository.js";

const DEFAULT_TOP_LIMIT = 10;
const MAX_TOP_LIMIT = 100;
const DEFAULT_COMMENT_SAMPLE_LIMIT = 10_000;
const MAX_COMMENT_SAMPLE_LIMIT = 50_000;
const RANKING_METRICS = new Set<IntegralRankingMetric>([
  "integral",
  "view_num",
  "sign_num",
  "total_price",
]);

export type AnalyticsErrorCode = "INVALID_LIMIT" | "INVALID_METRIC";

export class AnalyticsError extends Error {
  readonly code: AnalyticsErrorCode;

  constructor(code: AnalyticsErrorCode, message: string) {
    super(message);
    this.name = "AnalyticsError";
    this.code = code;
  }
}

export type AnalyticsRepository = Pick<
  SqliteRepository,
  "listRecentCommentContent" | "listIntegralRanking" | "listGiftAggregates"
>;

export interface WordFrequencyItem {
  readonly name: string;
  readonly value: number;
}

export interface CommentWordFrequencyResult {
  readonly type: "commentWordFrequency";
  readonly sampleSize: number;
  readonly sampleLimit: number;
  readonly items: readonly WordFrequencyItem[];
}

export interface IntegralRankingItem extends IntegralRankingRow {
  readonly rank: number;
}

export interface IntegralRankingResult {
  readonly type: "integralRanking";
  readonly metric: IntegralRankingMetric;
  readonly limit: number;
  readonly items: readonly IntegralRankingItem[];
}

export interface GiftAggregateItem extends GiftAggregateRow {
  readonly rank: number;
}

export interface GiftAggregatesResult {
  readonly type: "giftAggregates";
  readonly limit: number;
  readonly items: readonly GiftAggregateItem[];
}

export interface CommentWordFrequencyOptions {
  readonly limit?: number;
  /** Maximum number of newest comments read from SQLite before segmentation. */
  readonly sampleLimit?: number;
}

export interface AnalyticsServiceOptions {
  readonly locale?: string;
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new AnalyticsError(
      "INVALID_LIMIT",
      `${name} must be a positive safe integer`,
    );
  }
  return Math.min(selected, maximum);
}

export class AnalyticsService {
  private readonly repository: AnalyticsRepository;
  private readonly locale: string;
  private readonly segmenter: Intl.Segmenter;

  constructor(
    repository: AnalyticsRepository,
    options: AnalyticsServiceOptions = {},
  ) {
    this.repository = repository;
    this.locale = options.locale ?? "zh-CN";
    this.segmenter = new Intl.Segmenter(this.locale, { granularity: "word" });
  }

  commentWordFrequency(
    options: CommentWordFrequencyOptions = {},
  ): CommentWordFrequencyResult {
    const limit = boundedLimit(
      options.limit,
      DEFAULT_TOP_LIMIT,
      MAX_TOP_LIMIT,
      "word frequency limit",
    );
    const sampleLimit = boundedLimit(
      options.sampleLimit,
      DEFAULT_COMMENT_SAMPLE_LIMIT,
      MAX_COMMENT_SAMPLE_LIMIT,
      "comment sample limit",
    );
    const comments = this.repository.listRecentCommentContent(sampleLimit);
    const counts = new Map<string, number>();

    for (const comment of comments) {
      for (const part of this.segmenter.segment(comment)) {
        if (part.isWordLike !== true) {
          continue;
        }
        const word = part.segment.trim().toLocaleLowerCase(this.locale);
        // Preserve the legacy analytics rule that ignored one-character tokens.
        if (Array.from(word).length <= 1) {
          continue;
        }
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }

    const items = Array.from(counts, ([name, value]) => ({ name, value }))
      .sort(
        (left, right) =>
          right.value - left.value ||
          left.name.localeCompare(right.name, this.locale),
      )
      .slice(0, limit);

    return {
      type: "commentWordFrequency",
      sampleSize: comments.length,
      sampleLimit,
      items,
    };
  }

  integralRanking(
    metric: IntegralRankingMetric = "integral",
    requestedLimit?: number,
  ): IntegralRankingResult {
    if (!RANKING_METRICS.has(metric)) {
      throw new AnalyticsError(
        "INVALID_METRIC",
        `unsupported integral ranking metric: ${String(metric)}`,
      );
    }
    const limit = boundedLimit(
      requestedLimit,
      DEFAULT_TOP_LIMIT,
      MAX_TOP_LIMIT,
      "integral ranking limit",
    );
    const rows = this.repository.listIntegralRanking(metric, limit);
    const items = rows.map((row, index) => ({ ...row, rank: index + 1 }));
    return { type: "integralRanking", metric, limit, items };
  }

  giftAggregates(requestedLimit?: number): GiftAggregatesResult {
    const limit = boundedLimit(
      requestedLimit,
      DEFAULT_TOP_LIMIT,
      MAX_TOP_LIMIT,
      "gift aggregate limit",
    );
    const rows = this.repository.listGiftAggregates(limit);
    const items = rows.map((row, index) => ({ ...row, rank: index + 1 }));
    return { type: "giftAggregates", limit, items };
  }
}
