import type { LookupAddress } from "node:dns";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import {
  assertSafeHttpUrl,
  createPinnedConnectionOptions,
  createPinnedContentFetch,
  decodeUtf8,
  defaultContentFetch,
  defaultHostnameResolver,
  requestBounded,
  type ContentFetch,
  type ContentFetchContext,
  type PinnedConnectionOptions,
} from "../src/features/content/http.js";

async function lookupAll(
  options: PinnedConnectionOptions,
  hostname: string,
): Promise<readonly LookupAddress[]> {
  return await new Promise<readonly LookupAddress[]>((resolvePromise, rejectPromise) => {
    options.lookup(hostname, { all: true }, (error, result) => {
      if (error !== null) {
        rejectPromise(error);
        return;
      }
      if (!Array.isArray(result)) {
        rejectPromise(new TypeError("Pinned lookup did not return an address list"));
        return;
      }
      resolvePromise(result);
    });
  });
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP test server did not expose a TCP address");
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        rejectPromise(error);
      }
    });
  });
}

describe("content HTTP address pinning", () => {
  it("uses only the validated DNS result when ambient DNS resolves the host differently", async () => {
    const ambientAddresses = await defaultHostnameResolver(
      "localhost",
      undefined,
      "online-search",
    );
    expect(ambientAddresses.some((address) => address === "127.0.0.1" || address === "::1"))
      .toBe(true);

    let validationLookups = 0;
    const url = new URL("https://localhost/resource");
    const validatedAddresses = await assertSafeHttpUrl(
      url,
      "online-search",
      {
        allowedPrivateHosts: ["localhost"],
        resolver: async () => {
          validationLookups += 1;
          return ["93.184.216.34"];
        },
      },
    );
    const connection = createPinnedConnectionOptions(url, validatedAddresses);

    await expect(lookupAll(connection, "localhost")).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
    await expect(lookupAll(connection, "attacker.invalid")).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
    expect(validationLookups).toBe(1);
    expect(connection.servername).toBe("localhost");
    expect(connection.agent).toBe(false);
    expect(Object.isFrozen(validatedAddresses)).toBe(true);
    expect(validatedAddresses.every(Object.isFrozen)).toBe(true);
  });

  it("repins redirects and preserves each HTTPS certificate hostname", async () => {
    const contexts: ContentFetchContext[] = [];
    const urls: URL[] = [];
    const resolverCalls: string[] = [];
    const transport = createPinnedContentFetch(async (url, _init, context) => {
      urls.push(new URL(url));
      contexts.push(context);
      if (url.hostname === "search.example" && url.pathname === "/query") {
        return new Response(null, {
          status: 302,
          headers: { location: "/next" },
        });
      }
      if (url.hostname === "search.example") {
        return new Response(null, {
          status: 307,
          headers: { location: "https://result.example/article" },
        });
      }
      return new Response("streamed result", {
        headers: { "content-type": "text/plain" },
      });
    });

    const result = await requestBounded({
      service: "online-search",
      fetch: transport,
      url: new URL("https://search.example/query"),
      timeoutMs: 1_000,
      maxBytes: 64,
      urlPolicy: {
        resolver: async (hostname) => {
          resolverCalls.push(hostname);
          if (resolverCalls.length === 1) {
            return ["1.1.1.1"];
          }
          return resolverCalls.length === 2
            ? ["8.8.8.8"]
            : ["9.9.9.9"];
        },
      },
    });

    expect(decodeUtf8(result.bytes)).toBe("streamed result");
    expect(resolverCalls).toEqual([
      "search.example",
      "search.example",
      "result.example",
    ]);
    expect(contexts.map(({ validatedAddresses }) => validatedAddresses)).toEqual([
      [{ address: "1.1.1.1", family: 4 }],
      [{ address: "8.8.8.8", family: 4 }],
      [{ address: "9.9.9.9", family: 4 }],
    ]);
    expect(
      urls.map((url, index) =>
        createPinnedConnectionOptions(
          url,
          contexts[index]?.validatedAddresses ?? [],
        ).servername,
      ),
    ).toEqual(["search.example", "search.example", "result.example"]);
  });

  it("streams a direct response through the pinned Node transport with the original Host", async () => {
    let receivedHost: string | undefined;
    const server = createServer((request, response) => {
      receivedHost = request.headers.host;
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("bounded ");
      setImmediate(() => response.end("stream"));
    });
    const port = await listen(server);

    try {
      const result = await requestBounded({
        service: "online-search",
        fetch: defaultContentFetch,
        url: new URL(`http://localhost:${port}/article`),
        timeoutMs: 1_000,
        maxBytes: 32,
        urlPolicy: {
          allowedPrivateHosts: ["localhost"],
          resolver: async () => ["127.0.0.1"],
        },
      });

      expect(decodeUtf8(result.bytes)).toBe("bounded stream");
      expect(receivedHost).toBe(`localhost:${port}`);
    } finally {
      await close(server);
    }
  });

  it("closes the direct response stream when its lifecycle signal is aborted", async () => {
    const responseStarted = Promise.withResolvers<void>();
    const responseClosed = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      response.once("close", () => responseClosed.resolve());
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      responseStarted.resolve();
    });
    const port = await listen(server);
    const controller = new AbortController();

    try {
      const pending = requestBounded({
        service: "online-search",
        fetch: defaultContentFetch,
        url: new URL(`http://localhost:${port}/slow`),
        signal: controller.signal,
        timeoutMs: 1_000,
        maxBytes: 32,
        urlPolicy: {
          allowedPrivateHosts: ["localhost"],
          resolver: async () => ["127.0.0.1"],
        },
      });
      await responseStarted.promise;
      controller.abort(new Error("test cancellation"));

      await expect(pending).rejects.toMatchObject({
        code: "ABORTED",
        service: "online-search",
      });
      await responseClosed.promise;
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });

  it("pins public IP literals without consulting DNS", async () => {
    let resolverCalled = false;
    const addresses = await assertSafeHttpUrl(
      new URL("https://1.1.1.1/path"),
      "online-search",
      {
        resolver: async () => {
          resolverCalled = true;
          return ["127.0.0.1"];
        },
      },
    );

    expect(resolverCalled).toBe(false);
    expect(addresses).toEqual([{ address: "1.1.1.1", family: 4 }]);
    expect(createPinnedConnectionOptions(new URL("https://1.1.1.1/path"), addresses))
      .not.toHaveProperty("servername");
  });

  it("rejects unregistered lookalike transports and unpinned proxy routing", async () => {
    let called = false;
    const lookalike = Object.assign(
      async () => {
        called = true;
        return new Response("unsafe");
      },
      { pinsValidatedAddresses: true as const },
    ) as unknown as ContentFetch;
    const baseRequest = {
      service: "online-search" as const,
      url: new URL("https://1.1.1.1/"),
      timeoutMs: 100,
      maxBytes: 16,
    };

    await expect(requestBounded({ ...baseRequest, fetch: lookalike })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      service: "online-search",
    });
    expect(called).toBe(false);

    await expect(requestBounded({
      ...baseRequest,
      fetch: defaultContentFetch,
      proxyUrl: "https://proxy.example/",
    })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      service: "online-search",
    });
  });
  it("rejects proxy URLs with unsafe schemes, credentials, or fragments", async () => {
    let called = false;
    const transport = createPinnedContentFetch(
      async () => {
        called = true;
        return new Response("unsafe");
      },
      { pinsProxyRequests: true },
    );
    const baseRequest = {
      service: "online-search" as const,
      url: new URL("https://1.1.1.1/"),
      fetch: transport,
      timeoutMs: 100,
      maxBytes: 16,
    };

    for (const proxyUrl of [
      "socks://proxy.example:1080",
      "https://user:secret@proxy.example",
      "https://proxy.example/#fragment",
    ]) {
      await expect(requestBounded({
        ...baseRequest,
        proxyUrl,
      })).rejects.toMatchObject({
        code: "INVALID_CONFIG",
        service: "online-search",
      });
    }
    expect(called).toBe(false);
  });

});
