import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import {
  ContentServiceError,
  type ContentServiceName,
} from "../features/content/errors.js";
import type {
  OnlineSearchConfig,
  OnlineSearchService,
  SearchSummary,
} from "../features/content/search.js";

type SearchToolLimits = Pick<OnlineSearchConfig, "maxResults" | "maxQueryCharacters">;

export type OnlineSearchParameters = Type.TObject<{
  query: Type.TString;
  count: Type.TOptional<Type.TInteger>;
}>;

function onlineSearchParameters(limits: SearchToolLimits): OnlineSearchParameters {
  return Type.Object(
    {
      query: Type.String({
        minLength: 1,
        maxLength: limits.maxQueryCharacters ?? 500,
        description: "The question or subject to search for",
      }),
      count: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: limits.maxResults ?? 3,
        description: "Maximum sources to return; omit to use the operator's configured count",
      })),
    },
    { additionalProperties: false },
  );
}


export interface OnlineSearchToolDetails {
  readonly ok: true;
  readonly query: string;
  readonly results: readonly SearchSummary[];
}


export interface ContentToolsOptions {
  readonly search?: OnlineSearchService;
  readonly searchLimits?: SearchToolLimits;
}

function toolFailure(error: unknown, service: ContentServiceName): ContentServiceError {
  if (error instanceof ContentServiceError) {
    return error;
  }
  return new ContentServiceError(
    service,
    "NETWORK_ERROR",
    `${service} tool failed`,
    { cause: error },
  );
}

function formatSearchResults(query: string, results: readonly SearchSummary[]): string {
  if (results.length === 0) {
    return `No usable online sources were found for: ${query}`;
  }
  return results.map((result, index) => [
    `[${index + 1}] ${result.title}`,
    ...(result.url ? [`URL: ${result.url}`] : []),
    result.content,
  ].join("\n")).join("\n\n");
}

export function createOnlineSearchTool(
  search: OnlineSearchService,
  limits: SearchToolLimits = {},
): AgentTool<OnlineSearchParameters, OnlineSearchToolDetails> {
  return {
    name: "online_search",
    label: "Online Search",
    description: "Search the web for current information, recent events, or facts that need verification. Call only when external information is useful; no keyword prefix is required. Results include source URLs and bounded summaries to use in your answer. Provider and credentials are configured by the operator.",
    parameters: onlineSearchParameters(limits),
    executionMode: "parallel",
    async execute(_toolCallId, arguments_, signal): Promise<AgentToolResult<OnlineSearchToolDetails>> {
      let results: readonly SearchSummary[];
      try {
        results = await search.search(arguments_.query, {
          ...(arguments_.count === undefined ? {} : { count: arguments_.count }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        throw toolFailure(error, "online-search");
      }
      const details: OnlineSearchToolDetails = {
        ok: true,
        query: arguments_.query,
        results: results.map((result) => ({ ...result })),
      };
      return {
        content: [{ type: "text", text: formatSearchResults(arguments_.query, results) }],
        details,
      };
    },
  };
}


export function createContentTools(options: ContentToolsOptions): AgentTool[] {
  const tools: AgentTool[] = [];
  if (options.search !== undefined) {
    tools.push(createOnlineSearchTool(options.search, options.searchLimits));
  }
  return tools;
}
