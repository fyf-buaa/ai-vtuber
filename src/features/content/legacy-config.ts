
import { ContentServiceError } from "./errors.js";
import { validateOnlineSearchConfig, type OnlineSearchConfig, type SearchProvider } from "./search.js";

export interface LegacySearchFeatureConfig {
  readonly enabled: boolean;
  readonly service: OnlineSearchConfig;
}


function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}


function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function searchProvider(value: unknown): SearchProvider {
  if (value === undefined) return "tavily";
  if (value === "tavily" || value === "exa" || value === "openai" || value === "zai" || value === "kimi") {
    return value;
  }
  throw new ContentServiceError(
    "online-search",
    "INVALID_CONFIG",
    "search_online.provider 必须选择 tavily / exa / openai / zai / kimi",
  );
}



export function mapOnlineSearchConfig(config: Readonly<Record<string, unknown>>): LegacySearchFeatureConfig {
  const search = objectValue(config.search_online);
  const enabled = booleanValue(search.enable, false);
  const count = numberValue(search.count, 1);
  for (const field of ["engine", "engine_id", "endpoints", "google_endpoint", "bing_endpoint", "baidu_endpoint", "duckduckgo_endpoint"]) {
    if (Object.hasOwn(search, field)) {
      throw new ContentServiceError(
        "online-search",
        "INVALID_CONFIG",
        `search_online.${field} 已移除，请改用 provider 和 api_key 配置搜索 API`,
      );
    }
  }
  for (const field of ["keyword_enable", "before_keyword", "resp_template"]) {
    if (Object.hasOwn(search, field)) {
      throw new ContentServiceError(
        "online-search",
        "INVALID_CONFIG",
        `search_online.${field} 已移除；网页搜索现在由 Pi Agent 的 online_search 工具调用触发，请删除旧字段`,
      );
    }
  }
  const httpProxyUrl = optionalString(search.http_proxy);
  const httpsProxyUrl = optionalString(search.https_proxy);
  const endpoint = optionalString(search.endpoint);
  const model = optionalString(search.model);
  const service: OnlineSearchConfig = {
    provider: searchProvider(search.provider),
    apiKey: stringValue(search.api_key, ""),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(model === undefined ? {} : { model }),
    defaultCount: count,
    maxResults: numberValue(search.max_count, count),
    ...(httpProxyUrl === undefined ? {} : { httpProxyUrl }),
    ...(httpsProxyUrl === undefined ? {} : { httpsProxyUrl }),
    timeoutMs: numberValue(search.timeout_ms, 60_000),
    maxQueryCharacters: numberValue(search.max_query_characters, 500),
    maxSearchResponseBytes: numberValue(search.max_search_response_bytes, 1024 * 1024),
    maxExtractedCharacters: numberValue(search.max_content_characters, 8_000),
    cacheMaxEntries: numberValue(search.cache_max_entries, 100),
    cacheTtlMs: numberValue(search.cache_ttl_ms, 5 * 60_000),
  };
  if (enabled) validateOnlineSearchConfig(service);

  return {
    enabled,
    service,
  };
}

