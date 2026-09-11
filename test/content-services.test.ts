
import { describe, expect, it } from "vitest";

import { ContentServiceError } from "../src/features/content/errors.js";
import {
  createPinnedContentFetch,
  type ContentFetchContext,
} from "../src/features/content/http.js";
import { mapOnlineSearchConfig } from "../src/features/content/legacy-config.js";
import { BoundedOnlineSearchService } from "../src/features/content/search.js";
import { createOnlineSearchTool } from "../src/tools/content-tools.js";

const PUBLIC_RESOLVER = async (): Promise<readonly string[]> => ["93.184.216.34"];


describe("content services", () => {



  it("bounds API snippets, isolates cached results, and keeps the configured proxy", async () => {
    const contexts: ContentFetchContext[] = [];
    let now = 100;
    const service = new BoundedOnlineSearchService(
      {
        provider: "tavily",
        apiKey: "test-search-key",
        defaultCount: 1,
        maxResults: 1,
        httpsProxyUrl: "https://proxy.test:8443",
        maxExtractedCharacters: 32,
        cacheTtlMs: 1_000,
      },
      {
        fetch: createPinnedContentFetch(async (_url, _init, context) => {
          contexts.push(context);
          return Response.json({ results: [{ title: "Source", url: "https://page.test/article", content: "x".repeat(200) }] });
        }, { pinsProxyRequests: true }),
        resolver: PUBLIC_RESOLVER,
        now: () => now,
      },
    );
    const first = await service.search("bounded");
    expect(first[0]?.content).toBe("x".repeat(32));
    Object.assign(first[0]!, { content: "caller mutation" });
    expect((await service.search("bounded"))[0]?.content).toBe("x".repeat(32));
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.proxyUrl).toBe("https://proxy.test:8443/");
    now += 1_000;
    await service.search("bounded");
    expect(contexts).toHaveLength(2);
  });

  it("never forwards a search API credential through a redirect", async () => {
    const requested: string[] = [];
    const service = new BoundedOnlineSearchService(
      { provider: "exa", apiKey: "private-search-key" },
      {
        fetch: createPinnedContentFetch(async (url) => {
          requested.push(url.href);
          return new Response(null, { status: 307, headers: { location: "https://collector.test/" } });
        }),
        resolver: PUBLIC_RESOLVER,
      },
    );
    await expect(service.search("redirect")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(requested).toEqual(["https://api.exa.ai/search"]);
  });

  it("fails explicitly when a search response exceeds its byte cap", async () => {
    const service = new BoundedOnlineSearchService(
      {
        provider: "tavily",
        apiKey: "test-search-key",
        defaultCount: 1,
        maxResults: 1,
        maxSearchResponseBytes: 8,
      },
      {
        fetch: createPinnedContentFetch(async () => new Response("0123456789", {
          headers: { "content-type": "application/json" },
        })),
        resolver: PUBLIC_RESOLVER,
      },
    );

    await expect(service.search("oversized")).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
      service: "online-search",
    });
  });

  it.each([
    { provider: "tavily" as const, body: { query: "news", max_results: 1 }, response: { results: [{ title: "News", url: "https://source.test/", content: "verified facts" }] } },
    { provider: "exa" as const, body: { query: "news", numResults: 1, contents: { text: { maxCharacters: 8000 } } }, response: { results: [{ title: "News", url: "https://source.test/", text: "verified facts" }] } },
    { provider: "zai" as const, body: { search_query: "news", search_engine: "search-prime", count: 1 }, response: { search_result: [{ title: "News", link: "https://source.test/", content: "verified facts" }] } },
  ])("reads $provider API results without crawling returned links", async ({ provider, body, response }) => {
    let calls = 0;
    const service = new BoundedOnlineSearchService(
      { provider, apiKey: "test-search-key", defaultCount: 1 },
      {
        resolver: PUBLIC_RESOLVER,
        fetch: createPinnedContentFetch(async (_url, init) => {
          calls += 1;
          const headers = new Headers(init.headers);
          expect(init.method).toBe("POST");
          expect(headers.get(provider === "exa" ? "x-api-key" : "authorization"))
            .toBe(provider === "exa" ? "test-search-key" : "Bearer test-search-key");
          expect(JSON.parse(String(init.body))).toMatchObject(body);
          return Response.json(response);
        }),
      },
    );
    expect(await service.search("news")).toEqual([{ title: "News", url: "https://source.test/", content: "verified facts" }]);
    expect(calls).toBe(1);
  });

  it("requires an actual OpenAI search and retains source citations", async () => {
    let searched = true;
    const service = new BoundedOnlineSearchService(
      { provider: "openai", apiKey: "test-search-key", cacheTtlMs: 0 },
      {
        resolver: PUBLIC_RESOLVER,
        fetch: createPinnedContentFetch(async (_url, init) => {
          expect(JSON.parse(String(init.body))).toMatchObject({
            tools: [{ type: "web_search" }], tool_choice: "required",
          });
          return Response.json({
            status: "completed",
            output: [
              ...(searched ? [{ type: "web_search_call", status: "completed" }] : []),
              { type: "message", content: [{
                type: "output_text", text: "Grounded answer",
                annotations: [{ type: "url_citation", title: "Source", url: "https://source.test/fact" }],
              }] },
            ],
          });
        }),
      },
    );
    const results = await service.search("news");
    expect(results[0]?.content).toContain("Grounded answer");
    expect(results[0]?.content).toContain("https://source.test/fact");
    searched = false;
    await expect(service.search("news")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("completes Kimi builtin search by returning unchanged arguments and reasoning context", async () => {
    const assistant = {
      role: "assistant", content: null, reasoning_content: "Search first",
      tool_calls: [{ id: "search-1", type: "function", function: {
        name: "$web_search", arguments: '{ "search_query": "news", "opaque": "retain" }',
      } }],
    };
    let calls = 0;
    const service = new BoundedOnlineSearchService(
      { provider: "kimi", apiKey: "test-search-key" },
      {
        resolver: PUBLIC_RESOLVER,
        fetch: createPinnedContentFetch(async (_url, init) => {
          const body = JSON.parse(String(init.body));
          expect(body.tools).toEqual([{ type: "builtin_function", function: { name: "$web_search" } }]);
          calls += 1;
          if (calls === 1) return Response.json({ choices: [{ finish_reason: "tool_calls", message: assistant }] });
          expect(body.messages.slice(1)).toEqual([
            assistant,
            { role: "tool", tool_call_id: "search-1", name: "$web_search", content: assistant.tool_calls[0]!.function.arguments },
          ]);
          return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Facts [source](https://source.test/)" } }] });
        }),
      },
    );
    expect((await service.search("news"))[0]?.content).toBe("Facts [source](https://source.test/)");
    expect(calls).toBe(2);
  });

  it("bounds repeated Kimi tool calls instead of looping or returning tool arguments as facts", async () => {
    let calls = 0;
    const service = new BoundedOnlineSearchService(
      { provider: "kimi", apiKey: "test-search-key" },
      {
        resolver: PUBLIC_RESOLVER,
        fetch: createPinnedContentFetch(async () => {
          calls += 1;
          return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
            role: "assistant",
            tool_calls: [{ id: `call-${calls}`, function: { name: "$web_search", arguments: "{}" } }],
          } }] });
        }),
      },
    );
    await expect(service.search("news")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(calls).toBe(5);
  });

  it("requires explicit credentials when enabled but permits an unconfigured disabled search", () => {
    expect(mapOnlineSearchConfig({ search_online: { enable: false, provider: "tavily", api_key: "" } }).enabled).toBe(false);
    expect(() => mapOnlineSearchConfig({ search_online: { enable: true, provider: "tavily", api_key: "  " } }))
      .toThrow(/api_key/u);
    expect(() => mapOnlineSearchConfig({ search_online: { enable: true, engine: "baidu" } }))
      .toThrow(/provider.*api_key/u);
  });

  it.each([
    { response: () => new Response(null, { status: 401 }), code: "HTTP_STATUS" },
    { response: () => new Response("<html>not an API</html>"), code: "MALFORMED_RESPONSE" },
    { response: () => Response.json({ unexpected: [] }), code: "MALFORMED_RESPONSE" },
  ])("surfaces API failures as $code without pretending there are no results", async ({ response, code }) => {
    const service = new BoundedOnlineSearchService(
      { provider: "tavily", apiKey: "private-search-key" },
      { resolver: PUBLIC_RESOLVER, fetch: createPinnedContentFetch(async () => response()) },
    );
    await expect(service.search("news")).rejects.toMatchObject({ code });
  });



  it("returns stable AgentTool success details and typed errors", async () => {
    const searchTool = createOnlineSearchTool({
      async search(query) {
        return [{
          title: "Result",
          url: "https://result.test/",
          content: `Summary for ${query}`,
        }];
      },
    });
    const searchResult = await searchTool.execute("call-1", { query: "topic" });
    expect(searchResult).toEqual({
      content: [{
        type: "text",
        text: "[1] Result\nURL: https://result.test/\nSummary for topic",
      }],
      details: {
        ok: true,
        query: "topic",
        results: [{
          title: "Result",
          url: "https://result.test/",
          content: "Summary for topic",
        }],
      },
    });

    const failingTool = createOnlineSearchTool({
      async search() {
        throw new ContentServiceError(
          "online-search",
          "TIMEOUT",
          "search timed out",
        );
      },
    });
    await expect(failingTool.execute("call-2", { query: "topic" })).rejects.toMatchObject({
      name: "ContentServiceError",
      service: "online-search",
      code: "TIMEOUT",
      message: "search timed out",
    });

  });
});
