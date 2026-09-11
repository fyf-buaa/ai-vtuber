import { ContentServiceError, throwIfAborted } from "./errors.js";
import {
  decodeUtf8,
  defaultContentFetch,
  type ContentFetch,
  type HostnameResolver,
  requestBounded,
} from "./http.js";

export type SearchProvider = "tavily" | "exa" | "openai" | "zai" | "kimi";

export interface OnlineSearchConfig {
  readonly provider: SearchProvider;
  readonly apiKey: string;
  /** Full API endpoint; an empty value uses the provider's official endpoint. */
  readonly endpoint?: string;
  /** Only OpenAI and Kimi use a model. */
  readonly model?: string;
  readonly defaultCount?: number;
  readonly maxResults?: number;
  readonly httpProxyUrl?: string;
  readonly httpsProxyUrl?: string;
  readonly timeoutMs?: number;
  readonly maxQueryCharacters?: number;
  readonly maxSearchResponseBytes?: number;
  readonly maxExtractedCharacters?: number;
  readonly cacheMaxEntries?: number;
  readonly cacheTtlMs?: number;
}

export interface SearchOptions {
  readonly count?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface SearchSummary {
  readonly title: string;
  /** Empty for a synthesized answer without a source URL supplied by the API. */
  readonly url: string;
  readonly content: string;
}

export interface OnlineSearchService {
  search(query: string, options?: SearchOptions): Promise<readonly SearchSummary[]>;
}

export interface OnlineSearchDependencies {
  readonly fetch?: ContentFetch;
  readonly resolver?: HostnameResolver;
  readonly now?: () => number;
}

interface CachedSearch {
  readonly expiresAt: number;
  readonly summaries: readonly SearchSummary[];
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_ENDPOINTS: Readonly<Record<SearchProvider, string>> = {
  tavily: "https://api.tavily.com/search",
  exa: "https://api.exa.ai/search",
  openai: "https://api.openai.com/v1/responses",
  zai: "https://api.z.ai/api/paas/v4/web_search",
  kimi: "https://api.moonshot.cn/v1/chat/completions",
};
const DEFAULT_RESULT_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_EXTRACTED_LIMIT = 8_000;
const MAX_KIMI_ROUNDS = 5;

function invalidConfig(message: string): never {
  throw new ContentServiceError("online-search", "INVALID_CONFIG", message);
}

function malformed(message: string): never {
  throw new ContentServiceError("online-search", "MALFORMED_RESPONSE", message);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalidConfig(`Search ${field} must be a positive integer`);
  }
  return value;
}

function endpointUrl(config: OnlineSearchConfig): URL {
  let url: URL;
  try {
    url = new URL(config.endpoint?.trim() || DEFAULT_ENDPOINTS[config.provider]);
  } catch {
    return invalidConfig("search_online.endpoint 必须是完整的 http(s) API 地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
  ) {
    invalidConfig("search_online.endpoint 不得包含凭据、查询参数或片段，且必须使用 http(s)");
  }
  return url;
}

export function validateOnlineSearchConfig(config: OnlineSearchConfig): void {
  if (!Object.hasOwn(DEFAULT_ENDPOINTS, config.provider)) {
    invalidConfig("search_online.provider 必须选择 tavily / exa / openai / zai / kimi");
  }
  if (typeof config.apiKey !== "string" || config.apiKey.trim() === "" || config.apiKey === "[REDACTED]") {
    invalidConfig("启用联网搜索必须填写所选服务商的 search_online.api_key");
  }
  if (/[\r\n]/u.test(config.apiKey)) {
    invalidConfig("search_online.api_key 不得包含换行符");
  }
  endpointUrl(config);
  const maxResults = positiveInteger(config.maxResults ?? DEFAULT_RESULT_LIMIT, "result limit");
  const count = positiveInteger(config.defaultCount ?? Math.min(DEFAULT_RESULT_LIMIT, maxResults), "result count");
  if (maxResults > 20 || count > maxResults) {
    invalidConfig("search_online.count / max_count 必须在 1–20 范围内，且 count 不得超过 max_count");
  }
  positiveInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeout");
  positiveInteger(config.maxQueryCharacters ?? 500, "query character limit");
  positiveInteger(config.maxSearchResponseBytes ?? 1024 * 1024, "response byte limit");
  positiveInteger(config.maxExtractedCharacters ?? DEFAULT_EXTRACTED_LIMIT, "content character limit");
  if (
    !Number.isFinite(config.cacheTtlMs ?? 300_000) || (config.cacheTtlMs ?? 300_000) < 0 ||
    !Number.isSafeInteger(config.cacheMaxEntries ?? 100) || (config.cacheMaxEntries ?? 100) < 0
  ) {
    invalidConfig("Search cache limits are invalid");
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function resultList(value: unknown, provider: SearchProvider, count: number, limit: number): SearchSummary[] {
  if (!Array.isArray(value)) malformed(`${provider} search response is missing its result array`);
  const summaries: SearchSummary[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const entry = record(item);
    if (entry === undefined) malformed(`${provider} search result must be an object`);
    const url = sourceUrl(provider === "zai" ? entry.link : entry.url);
    const highlights = Array.isArray(entry.highlights)
      ? entry.highlights.filter((part): part is string => typeof part === "string").join("\n")
      : "";
    const content = provider === "exa"
      ? text(entry.text) || text(entry.summary) || highlights.trim()
      : text(entry.content);
    if (!url || !content || seen.has(url)) continue;
    seen.add(url);
    summaries.push({ title: text(entry.title) || new URL(url).hostname, url, content: content.slice(0, limit) });
    if (summaries.length >= count) break;
  }
  return summaries;
}

function openAiResults(payload: JsonRecord, limit: number): SearchSummary[] {
  if (payload.status !== "completed" || !Array.isArray(payload.output)) {
    malformed("OpenAI search response is incomplete or missing output");
  }
  const output = payload.output.map(record);
  if (!output.some((item) => item?.type === "web_search_call" && item.status === "completed")) {
    malformed("OpenAI did not complete a web search; refusing an ungrounded answer");
  }
  const parts: string[] = [];
  const citations = new Map<string, string>();
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      const entry = record(part);
      if (entry?.type !== "output_text") continue;
      if (text(entry.text)) parts.push(text(entry.text));
      if (!Array.isArray(entry.annotations)) continue;
      for (const annotation of entry.annotations) {
        const citation = record(annotation);
        if (citation?.type !== "url_citation") continue;
        const url = sourceUrl(citation.url);
        if (url) citations.set(url, text(citation.title) || url);
      }
    }
  }
  const answer = parts.join("\n");
  if (!answer) malformed("OpenAI search response has no answer text");
  const sources = [...citations].map(([url, title]) => `${title}: ${url}`).join("\n");
  return [{
    title: "OpenAI 联网搜索",
    url: citations.keys().next().value ?? "",
    content: `${answer}${sources ? `\n来源：\n${sources}` : ""}`.slice(0, limit),
  }];
}

function cloneSummaries(summaries: readonly SearchSummary[]): SearchSummary[] {
  return summaries.map((summary) => ({ ...summary }));
}

export class BoundedOnlineSearchService implements OnlineSearchService {
  readonly #config: OnlineSearchConfig;
  readonly #fetch: ContentFetch;
  readonly #resolver: HostnameResolver | undefined;
  readonly #now: () => number;
  readonly #cache = new Map<string, CachedSearch>();

  constructor(config: OnlineSearchConfig, dependencies: OnlineSearchDependencies = {}) {
    this.#config = { ...config };
    this.#fetch = dependencies.fetch ?? defaultContentFetch;
    this.#resolver = dependencies.resolver;
    this.#now = dependencies.now ?? Date.now;
  }

  async search(query: string, options: SearchOptions = {}): Promise<readonly SearchSummary[]> {
    throwIfAborted(options.signal, "online-search");
    validateOnlineSearchConfig(this.#config);
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new ContentServiceError("online-search", "EMPTY_QUERY", "Online search query must not be empty");
    }
    const queryLimit = this.#config.maxQueryCharacters ?? 500;
    if (normalizedQuery.length > queryLimit) {
      throw new ContentServiceError("online-search", "RESPONSE_TOO_LARGE", `Online search query exceeds the ${queryLimit}-character limit`);
    }
    const maxResults = this.#config.maxResults ?? DEFAULT_RESULT_LIMIT;
    const count = positiveInteger(options.count ?? this.#config.defaultCount ?? Math.min(DEFAULT_RESULT_LIMIT, maxResults), "requested result count");
    if (count > maxResults) invalidConfig(`Requested ${count} results exceeds the configured limit of ${maxResults}`);
    const cacheKey = `${count}\u0000${normalizedQuery}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) {
      this.#cache.delete(cacheKey);
      if (cached.expiresAt > this.#now()) {
        this.#cache.set(cacheKey, cached);
        return cloneSummaries(cached.summaries);
      }
    }

    const limit = this.#config.maxExtractedCharacters ?? DEFAULT_EXTRACTED_LIMIT;
    const deadline = Date.now() + (this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const request = (body: JsonRecord): Promise<JsonRecord> => this.#request(body, deadline, options.signal);
    let summaries: SearchSummary[];
    switch (this.#config.provider) {
      case "tavily": {
        const payload = await request({ query: normalizedQuery, max_results: count, search_depth: "basic", include_answer: false });
        summaries = resultList(payload.results, "tavily", count, limit);
        break;
      }
      case "exa": {
        const payload = await request({ query: normalizedQuery, numResults: count, type: "auto", contents: { text: { maxCharacters: limit } } });
        summaries = resultList(payload.results, "exa", count, limit);
        break;
      }
      case "zai": {
        const payload = await request({ search_engine: "search-prime", search_query: normalizedQuery, count });
        summaries = resultList(payload.search_result, "zai", count, limit);
        break;
      }
      case "openai": {
        const payload = await request({
          model: this.#config.model?.trim() || "gpt-5.4-mini",
          tools: [{ type: "web_search" }],
          tool_choice: "required",
          input: `请联网搜索以下问题，基于最多 ${count} 个可靠来源提供简明事实摘要并标注来源链接：\n${normalizedQuery}`,
          max_output_tokens: 4096,
          store: false,
        });
        summaries = openAiResults(payload, limit);
        break;
      }
      case "kimi":
        summaries = await this.#kimiSearch(normalizedQuery, count, limit, request);
        break;
    }

    const cacheTtlMs = this.#config.cacheTtlMs ?? 300_000;
    const cacheMaxEntries = this.#config.cacheMaxEntries ?? 100;
    if (cacheTtlMs > 0 && cacheMaxEntries > 0) {
      while (this.#cache.size >= cacheMaxEntries) {
        const oldest = this.#cache.keys().next().value;
        if (oldest === undefined) break;
        this.#cache.delete(oldest);
      }
      this.#cache.set(cacheKey, { expiresAt: this.#now() + cacheTtlMs, summaries: cloneSummaries(summaries) });
    }
    return summaries;
  }

  async #request(body: JsonRecord, deadline: number, signal?: AbortSignal): Promise<JsonRecord> {
    throwIfAborted(signal, "online-search");
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new ContentServiceError("online-search", "TIMEOUT", "Online search timed out");
    const url = endpointUrl(this.#config);
    const proxyUrl = url.protocol === "http:" ? this.#config.httpProxyUrl : this.#config.httpsProxyUrl;
    const key = this.#config.apiKey.trim();
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (this.#config.provider === "exa") headers["x-api-key"] = key;
    else headers.authorization = `Bearer ${key}`;
    const response = await requestBounded({
      service: "online-search",
      fetch: this.#fetch,
      url,
      init: { method: "POST", headers, body: JSON.stringify(body) },
      signal,
      timeoutMs,
      maxBytes: this.#config.maxSearchResponseBytes ?? 1024 * 1024,
      // Never forward a provider credential to a redirect target.
      maxRedirects: 0,
      ...(proxyUrl?.trim() ? { proxyUrl } : {}),
      urlPolicy: {
        allowedPrivateHosts: this.#config.endpoint?.trim() ? [url.hostname] : [],
        ...(this.#resolver === undefined ? {} : { resolver: this.#resolver }),
      },
    });
    let payload: JsonRecord | undefined;
    try {
      payload = record(JSON.parse(decodeUtf8(response.bytes)));
    } catch {
      // Do not echo response bodies: provider errors can contain credentials.
      malformed(`${this.#config.provider} search endpoint did not return valid JSON`);
    }
    if (payload === undefined) malformed(`${this.#config.provider} search response must be an object`);
    if (payload.error !== undefined) {
      throw new ContentServiceError("online-search", "HTTP_STATUS", `${this.#config.provider} search API returned an error`);
    }
    return payload;
  }

  async #kimiSearch(
    query: string,
    count: number,
    limit: number,
    request: (body: JsonRecord) => Promise<JsonRecord>,
  ): Promise<SearchSummary[]> {
    const messages: JsonRecord[] = [{
      role: "user",
      content: `必须使用 $web_search 联网搜索以下问题，基于最多 ${count} 个可靠来源给出简明事实摘要，并用 Markdown 链接标注来源：\n${query}`,
    }];
    let searched = false;
    for (let round = 0; round < MAX_KIMI_ROUNDS; round += 1) {
      const payload = await request({
        model: this.#config.model?.trim() || "kimi-k2.6",
        messages,
        tools: [{ type: "builtin_function", function: { name: "$web_search" } }],
        max_tokens: 16_384,
        stream: false,
      });
      const choice = Array.isArray(payload.choices) ? record(payload.choices[0]) : undefined;
      const message = record(choice?.message);
      if (message === undefined) malformed("Kimi search response is missing its assistant message");
      if (choice?.finish_reason === "tool_calls") {
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
          malformed("Kimi search response is missing its tool calls");
        }
        // Preserve reasoning_content and the complete assistant tool-call message.
        messages.push(message);
        for (const rawCall of message.tool_calls) {
          const call = record(rawCall);
          const fn = record(call?.function);
          if (fn?.name !== "$web_search" || !text(call?.id) || typeof fn.arguments !== "string") {
            malformed("Kimi returned an unsupported or malformed search tool call");
          }
          try {
            if (record(JSON.parse(fn.arguments)) === undefined) throw new Error();
          } catch {
            malformed("Kimi search tool arguments must be a JSON object");
          }
          // The official builtin protocol executes search when these arguments are returned unchanged.
          messages.push({ role: "tool", tool_call_id: call!.id, name: "$web_search", content: fn.arguments });
          searched = true;
        }
        continue;
      }
      if (choice?.finish_reason !== "stop" || !searched || !text(message.content)) {
        malformed("Kimi did not complete a web search answer");
      }
      return [{ title: "Kimi 联网搜索", url: "", content: text(message.content).slice(0, limit) }];
    }
    return malformed("Kimi search exceeded the tool-call round limit");
  }
}
