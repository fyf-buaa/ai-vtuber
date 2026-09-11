import { lookup } from "node:dns/promises";
import {
  request as requestHttp,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as requestHttps } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

import {
  ContentServiceError,
  type ContentServiceName,
  throwIfAborted,
} from "./errors.js";

export interface ValidatedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type ValidatedAddressSet = readonly ValidatedAddress[];

export interface ContentFetchContext {
  readonly service: ContentServiceName;
  readonly validatedAddresses: ValidatedAddressSet;
  readonly proxyUrl?: string;
}

declare const pinnedContentFetchBrand: unique symbol;

export interface ContentFetch {
  (
    url: URL,
    init: RequestInit,
    context: ContentFetchContext,
  ): Promise<Response>;
  readonly [pinnedContentFetchBrand]: true;
}

export type ContentFetchImplementation = (
  url: URL,
  init: RequestInit,
  context: ContentFetchContext,
) => Promise<Response>;

export type HostnameResolver = (
  hostname: string,
  signal: AbortSignal | undefined,
  service?: ContentServiceName,
) => Promise<readonly string[]>;

interface ContentFetchCapabilities {
  readonly pinsProxyRequests: boolean;
}

const contentFetchCapabilities = new WeakMap<ContentFetch, ContentFetchCapabilities>();

/**
 * Attests that a transport connects only to `context.validatedAddresses`.
 * Proxy capability additionally attests that the target remains pinned through the proxy.
 */
export function createPinnedContentFetch(
  implementation: ContentFetchImplementation,
  options: { readonly pinsProxyRequests?: boolean } = {},
): ContentFetch {
  const transport = implementation as ContentFetch;
  contentFetchCapabilities.set(
    transport,
    Object.freeze({ pinsProxyRequests: options.pinsProxyRequests === true }),
  );
  return transport;
}

export interface UrlSafetyPolicy {
  readonly allowPrivateUrls?: boolean;
  readonly allowedPrivateHosts?: readonly string[];
  readonly resolver?: HostnameResolver;
}

export interface BoundedRequest {
  readonly service: ContentServiceName;
  readonly fetch: ContentFetch;
  readonly url: URL;
  readonly init?: RequestInit;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects?: number;
  readonly proxyUrl?: string;
  readonly urlPolicy?: UrlSafetyPolicy;
}

export interface BoundedResponse {
  readonly response: Response;
  readonly bytes: Uint8Array;
  readonly url: URL;
}

export const defaultHostnameResolver: HostnameResolver = async (
  hostname,
  signal,
  service = "online-search",
) => {
  throwIfAborted(signal, service);
  const pendingLookup = lookup(hostname, { all: true, verbatim: true }).then(
    (addresses) => addresses.map(({ address }) => address),
  );

  if (signal === undefined) {
    return pendingLookup;
  }

  return await new Promise<readonly string[]>((resolvePromise, rejectPromise) => {
    const abort = (): void => {
      rejectPromise(
        new ContentServiceError(
          service,
          "ABORTED",
          "Hostname resolution was cancelled",
          { cause: signal.reason },
        ),
      );
    };
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    pendingLookup.then(
      (addresses) => {
        cleanup();
        resolvePromise(addresses);
      },
      (error: unknown) => {
        cleanup();
        rejectPromise(error);
      },
    );
    if (signal.aborted) {
      abort();
    }
  });
};

export const defaultContentFetch: ContentFetch = createPinnedContentFetch(
  async (url, init, context) => {
    if (context.proxyUrl !== undefined && context.proxyUrl.length > 0) {
      throw new ContentServiceError(
        context.service,
        "INVALID_CONFIG",
        `${context.service} proxy transport does not enforce validated-address pinning`,
      );
    }
    return await requestDirect(url, init, context);
  },
);

function normalizedHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/u, "");
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [first, second, third] = octets as [number, number, number, number];

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  if (normalized === "::" || normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) !== 4 || isPrivateIpv4(mapped);
  }

  const firstGroupText = normalized.split(":", 1)[0] ?? "";
  const firstGroup = Number.parseInt(firstGroupText, 16);
  return (
    !Number.isFinite(firstGroup) ||
    (firstGroup & 0xfe00) === 0xfc00 ||
    (firstGroup & 0xffc0) === 0xfe80 ||
    (firstGroup & 0xff00) === 0xff00 ||
    normalized.startsWith("2001:db8:")
  );
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isPrivateIpv4(address);
  }
  if (version === 6) {
    return isPrivateIpv6(address);
  }
  return true;
}

function immutableValidatedAddresses(
  addresses: readonly ValidatedAddress[],
): ValidatedAddressSet {
  const unique = new Map<string, ValidatedAddress>();
  for (const candidate of addresses) {
    const key = `${candidate.family}:${candidate.address.toLowerCase()}`;
    if (!unique.has(key)) {
      unique.set(
        key,
        Object.freeze({ address: candidate.address, family: candidate.family }),
      );
    }
  }
  return Object.freeze([...unique.values()]);
}

export async function assertSafeHttpUrl(
  url: URL,
  service: ContentServiceName,
  policy: UrlSafetyPolicy = {},
  signal?: AbortSignal,
): Promise<ValidatedAddressSet> {
  throwIfAborted(signal, service);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ContentServiceError(
      service,
      "UNSAFE_URL",
      `${service} only permits http(s) URLs`,
      { details: { protocol: url.protocol } },
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new ContentServiceError(
      service,
      "UNSAFE_URL",
      `${service} URLs must not contain credentials`,
    );
  }

  const hostname = normalizedHostname(url.hostname);
  if (hostname.length === 0) {
    throw new ContentServiceError(service, "UNSAFE_URL", `${service} URL has no hostname`);
  }

  const allowedPrivateHosts = new Set(
    (policy.allowedPrivateHosts ?? []).map(normalizedHostname),
  );
  const privateAddressesAllowed =
    policy.allowPrivateUrls === true || allowedPrivateHosts.has(hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!privateAddressesAllowed && isPrivateAddress(hostname)) {
      throw new ContentServiceError(
        service,
        "UNSAFE_URL",
        `${service} blocked a non-public IP address`,
        { details: { hostname } },
      );
    }
    return immutableValidatedAddresses([{ address: hostname, family: literalFamily }]);
  }

  if (
    !privateAddressesAllowed &&
    (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname === "home.arpa" ||
      hostname.endsWith(".home.arpa") ||
      !hostname.includes(".")
    )
  ) {
    throw new ContentServiceError(
      service,
      "UNSAFE_URL",
      `${service} blocked a local hostname`,
      { details: { hostname } },
    );
  }

  const resolver = policy.resolver ?? defaultHostnameResolver;
  let addresses: readonly string[];
  try {
    addresses = await resolver(hostname, signal, service);
  } catch (error) {
    if (error instanceof ContentServiceError) {
      throw error;
    }
    if (signal?.aborted === true) {
      throw new ContentServiceError(
        service,
        "ABORTED",
        `${service} operation was cancelled`,
        { cause: signal.reason },
      );
    }
    throw new ContentServiceError(
      service,
      "NETWORK_ERROR",
      `${service} could not resolve ${hostname}`,
      { cause: error, details: { hostname } },
    );
  }
  throwIfAborted(signal, service);

  const resolvedAddresses = [...addresses];
  const addressRecords: ValidatedAddress[] = [];
  let invalidAddress = false;
  let blockedPrivateAddress = false;
  for (const address of resolvedAddresses) {
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      invalidAddress = true;
      continue;
    }
    if (!privateAddressesAllowed && isPrivateAddress(address)) {
      blockedPrivateAddress = true;
    }
    addressRecords.push({ address, family });
  }
  if (
    addressRecords.length === 0 ||
    invalidAddress ||
    blockedPrivateAddress
  ) {
    throw new ContentServiceError(
      service,
      "UNSAFE_URL",
      `${service} blocked a hostname resolving to a non-public address`,
      { details: { hostname, addresses: resolvedAddresses } },
    );
  }
  return immutableValidatedAddresses(addressRecords);
}

export interface PinnedConnectionOptions {
  readonly agent: false;
  readonly lookup: LookupFunction;
  readonly servername?: string;
}

function pinnedLookupError(hostname: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`No validated address is eligible for ${hostname}`),
    { code: "ENOTFOUND", hostname },
  );
}

export function createPinnedConnectionOptions(
  url: URL,
  validatedAddresses: ValidatedAddressSet,
): PinnedConnectionOptions {
  const expectedHostname = normalizedHostname(url.hostname);
  const addresses = immutableValidatedAddresses(validatedAddresses);
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => isIP(address) !== family)
  ) {
    throw new TypeError("Pinned HTTP requests require at least one validated IP address");
  }

  const literalFamily = isIP(expectedHostname);
  if (
    (literalFamily === 4 || literalFamily === 6) &&
    !addresses.some(
      ({ address, family }) =>
        family === literalFamily && address.toLowerCase() === expectedHostname,
    )
  ) {
    throw new TypeError("The URL's literal IP address is not in its validated address set");
  }

  const pinnedLookup: LookupFunction = (hostname, options, callback) => {
    if (normalizedHostname(hostname) !== expectedHostname) {
      callback(pinnedLookupError(hostname), "", 0);
      return;
    }

    const requestedFamily =
      options.family === 4 || options.family === "IPv4"
        ? 4
        : options.family === 6 || options.family === "IPv6"
          ? 6
          : undefined;
    const eligible = requestedFamily === undefined
      ? addresses
      : addresses.filter(({ family }) => family === requestedFamily);
    if (eligible.length === 0) {
      callback(pinnedLookupError(hostname), "", 0);
      return;
    }
    if (options.all === true) {
      callback(
        null,
        eligible.map(({ address, family }) => ({ address, family })),
      );
      return;
    }
    const selected = eligible[0];
    if (selected === undefined) {
      callback(pinnedLookupError(hostname), "", 0);
      return;
    }
    callback(null, selected.address, selected.family);
  };

  if (url.protocol === "https:" && literalFamily === 0) {
    return Object.freeze({
      agent: false,
      lookup: pinnedLookup,
      servername: url.hostname,
    });
  }
  return Object.freeze({ agent: false, lookup: pinnedLookup });
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("HTTP transport failed", { cause: error });
}

function waitForDrain(request: ClientRequest): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    if (request.destroyed) {
      rejectPromise(new Error("HTTP request closed while sending its body"));
      return;
    }
    const cleanup = (): void => {
      request.removeListener("drain", drained);
      request.removeListener("error", failed);
      request.removeListener("close", closed);
    };
    const drained = (): void => {
      cleanup();
      resolvePromise();
    };
    const failed = (error: Error): void => {
      cleanup();
      rejectPromise(error);
    };
    const closed = (): void => {
      cleanup();
      rejectPromise(new Error("HTTP request closed while sending its body"));
    };
    request.once("drain", drained);
    request.once("error", failed);
    request.once("close", closed);
  });
}

async function writeRequestBody(
  body: ReadableStream<Uint8Array<ArrayBuffer>> | null,
  request: ClientRequest,
  signal: AbortSignal,
): Promise<void> {
  if (body === null) {
    request.end();
    return;
  }

  const reader = body.getReader();
  const abort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        request.end();
        return;
      }
      if (!request.write(next.value)) {
        await waitForDrain(request);
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function webResponse(
  response: IncomingMessage,
  method: string,
  signal: AbortSignal,
): Response {
  const status = response.statusCode;
  if (status === undefined || status < 200 || status > 599) {
    response.destroy();
    throw new Error("HTTP transport returned an invalid response status");
  }

  const abort = (): void => {
    response.destroy(errorFromUnknown(signal.reason));
  };
  const cleanup = (): void => signal.removeEventListener("abort", abort);
  signal.addEventListener("abort", abort, { once: true });
  response.once("end", cleanup);
  response.once("close", cleanup);
  if (signal.aborted) {
    abort();
  }

  const responseMustNotHaveBody =
    method === "HEAD" || status === 204 || status === 205 || status === 304;
  if (responseMustNotHaveBody) {
    response.resume();
  }
  try {
    return new Response(
      responseMustNotHaveBody
        ? null
        : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array<ArrayBuffer>>,
      {
        status,
        statusText: response.statusMessage ?? "",
        headers: responseHeaders(response),
      },
    );
  } catch (error) {
    cleanup();
    response.destroy(errorFromUnknown(error));
    throw error;
  }
}

async function requestDirect(
  url: URL,
  init: RequestInit,
  context: ContentFetchContext,
): Promise<Response> {
  throwIfAborted(init.signal ?? undefined, context.service);
  const normalizedRequest = new Request(url, init);
  const requestHeaders = new Headers(normalizedRequest.headers);
  if (!requestHeaders.has("accept-encoding")) {
    requestHeaders.set("accept-encoding", "identity");
  }
  requestHeaders.delete("host");
  const connection = createPinnedConnectionOptions(url, context.validatedAddresses);
  const commonOptions: RequestOptions = {
    agent: connection.agent,
    headers: Object.fromEntries(requestHeaders.entries()),
    lookup: connection.lookup,
    method: normalizedRequest.method,
    signal: normalizedRequest.signal,
  };

  return await new Promise<Response>((resolvePromise, rejectPromise) => {
    let responseReceived = false;
    const receiveResponse = (incoming: IncomingMessage): void => {
      responseReceived = true;
      try {
        resolvePromise(
          webResponse(incoming, normalizedRequest.method, normalizedRequest.signal),
        );
      } catch (error) {
        rejectPromise(error);
      }
    };

    const outgoing = url.protocol === "https:"
      ? requestHttps(
        url,
        connection.servername === undefined
          ? commonOptions
          : { ...commonOptions, servername: connection.servername },
        receiveResponse,
      )
      : requestHttp(url, commonOptions, receiveResponse);
    outgoing.once("error", (error) => {
      if (!responseReceived) {
        rejectPromise(error);
      }
    });
    void writeRequestBody(
      normalizedRequest.body,
      outgoing,
      normalizedRequest.signal,
    ).catch((error: unknown) => outgoing.destroy(errorFromUnknown(error)));
  });
}

function parseContentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  service: ContentServiceName,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declaredLength = parseContentLength(response);
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new ContentServiceError(
      service,
      "RESPONSE_TOO_LARGE",
      `${service} response exceeds the ${maxBytes}-byte limit`,
      { details: { declaredLength, maxBytes } },
    );
  }

  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      throwIfAborted(signal, service);
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ContentServiceError(
          service,
          "RESPONSE_TOO_LARGE",
          `${service} response exceeds the ${maxBytes}-byte limit`,
          { details: { receivedBytes: size, maxBytes } },
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function redirectedMethod(status: number, method: string): string {
  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    return "GET";
  }
  return method;
}

function normalizeProxyUrl(
  value: string | undefined,
  service: ContentServiceName,
): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  let proxy: URL;
  try {
    proxy = new URL(value);
  } catch (error) {
    throw new ContentServiceError(
      service,
      "INVALID_CONFIG",
      `${service} proxy must be a valid HTTP(S) URL`,
      { cause: error },
    );
  }
  if (
    (proxy.protocol !== "http:" && proxy.protocol !== "https:") ||
    proxy.username.length > 0 ||
    proxy.password.length > 0 ||
    proxy.hash.length > 0
  ) {
    throw new ContentServiceError(
      service,
      "INVALID_CONFIG",
      `${service} proxy must be an HTTP(S) URL without credentials or fragments`,
    );
  }
  return proxy.href;
}

export async function requestBounded(request: BoundedRequest): Promise<BoundedResponse> {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
    throw new ContentServiceError(
      request.service,
      "INVALID_CONFIG",
      "HTTP response byte limit must be a positive integer",
    );
  }
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new ContentServiceError(
      request.service,
      "INVALID_CONFIG",
      "HTTP timeout must be positive",
    );
  }
  const proxyUrl = normalizeProxyUrl(request.proxyUrl, request.service);
  const capabilities = typeof request.fetch === "function"
    ? contentFetchCapabilities.get(request.fetch)
    : undefined;
  if (capabilities === undefined) {
    throw new ContentServiceError(
      request.service,
      "INVALID_CONFIG",
      `${request.service} fetch transport has not declared validated-address pinning`,
    );
  }
  const hasProxy = proxyUrl !== undefined;
  if (hasProxy && !capabilities.pinsProxyRequests) {
    throw new ContentServiceError(
      request.service,
      "INVALID_CONFIG",
      `${request.service} fetch transport cannot pin target addresses through its proxy`,
    );
  }
  throwIfAborted(request.signal, request.service);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${request.service} request timed out`));
  }, request.timeoutMs);

  try {
    const maxRedirects = request.maxRedirects ?? 3;
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
      throw new ContentServiceError(
        request.service,
        "INVALID_CONFIG",
        "HTTP redirect limit must be a non-negative integer",
      );
    }
    let currentUrl = new URL(request.url.href);
    let currentInit: RequestInit = { ...request.init };

    for (let redirectCount = 0; ; redirectCount += 1) {
      const validatedAddresses = await assertSafeHttpUrl(
        currentUrl,
        request.service,
        request.urlPolicy,
        controller.signal,
      );
      const fetchContext: ContentFetchContext = Object.freeze(
        proxyUrl === undefined
          ? { service: request.service, validatedAddresses }
          : { service: request.service, validatedAddresses, proxyUrl },
      );

      let response: Response;
      try {
        response = await request.fetch(
          currentUrl,
          { ...currentInit, redirect: "manual", signal: controller.signal },
          fetchContext,
        );
      } catch (error) {
        if (timedOut) {
          throw new ContentServiceError(
            request.service,
            "TIMEOUT",
            `${request.service} request timed out after ${request.timeoutMs}ms`,
            { cause: error },
          );
        }
        if (request.signal?.aborted === true || controller.signal.aborted) {
          throw new ContentServiceError(
            request.service,
            "ABORTED",
            `${request.service} operation was cancelled`,
            { cause: request.signal?.reason ?? error },
          );
        }
        if (error instanceof ContentServiceError) {
          throw error;
        }
        throw new ContentServiceError(
          request.service,
          "NETWORK_ERROR",
          `${request.service} request failed`,
          { cause: error, details: { url: currentUrl.href } },
        );
      }

      if (response.status >= 300 && response.status <= 399) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (location === null) {
          throw new ContentServiceError(
            request.service,
            "MALFORMED_RESPONSE",
            `${request.service} redirect response has no Location header`,
          );
        }
        if (redirectCount >= maxRedirects) {
          throw new ContentServiceError(
            request.service,
            "MALFORMED_RESPONSE",
            `${request.service} exceeded the redirect limit`,
            { details: { maxRedirects } },
          );
        }

        try {
          currentUrl = new URL(location, currentUrl);
        } catch (error) {
          throw new ContentServiceError(
            request.service,
            "MALFORMED_RESPONSE",
            `${request.service} redirect contains an invalid Location URL`,
            { cause: error },
          );
        }
        const oldMethod = (currentInit.method ?? "GET").toUpperCase();
        const nextMethod = redirectedMethod(response.status, oldMethod);
        if (nextMethod === "GET" && oldMethod !== "GET") {
          const headers = new Headers(currentInit.headers);
          headers.delete("content-length");
          headers.delete("content-type");
          currentInit = { ...currentInit, method: "GET", body: null, headers };
        }
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new ContentServiceError(
          request.service,
          "HTTP_STATUS",
          `${request.service} request failed with HTTP ${response.status}`,
          { details: { status: response.status, url: currentUrl.href } },
        );
      }

      const bytes = await readBoundedBody(
        response,
        request.maxBytes,
        request.service,
        controller.signal,
      );
      return { response, bytes, url: currentUrl };
    }
  } catch (error) {
    if (timedOut && !(error instanceof ContentServiceError && error.code === "TIMEOUT")) {
      throw new ContentServiceError(
        request.service,
        "TIMEOUT",
        `${request.service} request timed out after ${request.timeoutMs}ms`,
        { cause: error },
      );
    }
    if (
      request.signal?.aborted === true &&
      !(error instanceof ContentServiceError && error.code === "ABORTED")
    ) {
      throw new ContentServiceError(
        request.service,
        "ABORTED",
        `${request.service} operation was cancelled`,
        { cause: request.signal.reason ?? error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
