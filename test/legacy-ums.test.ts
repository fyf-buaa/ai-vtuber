import { describe, expect, it, vi } from "vitest";

import {
  LegacyUmsService,
  type LegacyUmsClock,
  type LegacyUmsFetch,
  type LegacyUmsLoginConfig,
  type LegacyUmsStatus,
  type LegacyUmsTimers,
} from "../src/security/legacy-ums.js";

const START_TIME = Date.parse("2032-01-01T00:00:00.000Z");
const USERNAME = "legacy-account@example.test";
const PASSWORD = "not-for-status-or-headers";
const ACCESS_TOKEN = "ums-access-token.secret";

class FakeClock implements LegacyUmsClock {
  value = START_TIME;

  now(): number {
    return this.value;
  }
}

interface TimerEntry {
  readonly callback: () => void;
  readonly dueAt: number;
}

class FakeTimers implements LegacyUmsTimers {
  readonly entries = new Map<number, TimerEntry>();
  #nextId = 1;

  constructor(readonly clock: FakeClock) {}

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.entries.set(id, {
      callback,
      dueAt: this.clock.value + delayMs,
    });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.entries.delete(handle);
    }
  }

  delays(): number[] {
    return [...this.entries.values()]
      .map((entry) => entry.dueAt - this.clock.value)
      .sort((left, right) => left - right);
  }

  fireEarliest(): TimerEntry {
    const candidate = [...this.entries.entries()].sort(
      (left, right) => left[1].dueAt - right[1].dueAt,
    )[0];
    if (candidate === undefined) {
      throw new Error("Expected a pending timer");
    }
    const [id, entry] = candidate;
    this.entries.delete(id);
    this.clock.value = entry.dueAt;
    entry.callback();
    return entry;
  }
}

function enabledConfig(
  overrides: Partial<LegacyUmsLoginConfig> = {},
): LegacyUmsLoginConfig {
  return {
    enable: true,
    username: USERNAME,
    password: PASSWORD,
    ums_api: "http://127.0.0.1:1119/ignored-base-path?ignored=yes",
    ...overrides,
  };
}

function successfulLogin(expirationAt: number): Response {
  return Response.json({
    code: 0,
    success: true,
    data: {
      accessToken: ACCESS_TOKEN,
      expiration_ts: new Date(expirationAt).toISOString(),
    },
  });
}

function successfulCheck(expirationAt: number): Response {
  return Response.json({
    code: 0,
    success: true,
    data: {
      expiration_ts: new Date(expirationAt).toISOString(),
    },
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function assertRedacted(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(USERNAME);
  expect(serialized).not.toContain(PASSWORD);
  expect(serialized).not.toContain(ACCESS_TOKEN);
}

describe("LegacyUmsService", () => {
  it("is inert when login.enable is disabled and still requires local bearer authorization", async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const fetch = vi.fn<LegacyUmsFetch>();
    const stop = vi.fn();
    const publishStatus = vi.fn();
    const service = new LegacyUmsService(
      { enable: false },
      { fetch, clock, timers, stop, publishStatus },
    );

    expect(await service.start()).toEqual({
      enabled: false,
      state: "disabled",
      authenticated: false,
    });
    expect(await service.login()).toEqual(service.status());
    expect(await service.checkExpiration()).toEqual(service.status());
    expect(fetch).not.toHaveBeenCalled();
    expect(timers.entries.size).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    expect(publishStatus).not.toHaveBeenCalled();

    const missingBearer = service.createRequestAuthorizer(() => ({
      configured: false,
      authorized: true,
    }));
    const rejectedBearer = service.createRequestAuthorizer(() => ({
      configured: true,
      authorized: false,
    }));
    const acceptedBearer = service.createRequestAuthorizer(() => ({
      configured: true,
      authorized: true,
    }));
    expect(await missingBearer("request")).toBe(false);
    expect(await rejectedBearer("request")).toBe(false);
    expect(await acceptedBearer("request")).toBe(true);
  });

  it("logs in explicitly with credentials only in the body, then schedules non-overlapping checks", async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const statuses: LegacyUmsStatus[] = [];
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    let resolveCheck!: (response: Response) => void;
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetch: LegacyUmsFetch = async (input, init) => {
      if (init === undefined) {
        throw new Error("Expected request options");
      }
      requests.push({ url: String(input), init });
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      try {
        if (requests.length === 1) {
          return successfulLogin(START_TIME + 3_600_000);
        }
        return await new Promise<Response>((resolve) => {
          resolveCheck = resolve;
        });
      } finally {
        activeRequests -= 1;
      }
    };
    const stop = vi.fn();
    const service = new LegacyUmsService(enabledConfig(), {
      fetch,
      clock,
      timers,
      stop,
      publishStatus: (status) => {
        statuses.push(status);
      },
    });

    const loginStatus = await service.login();
    expect(loginStatus).toMatchObject({
      state: "active",
      authenticated: true,
      expirationAt: START_TIME + 3_600_000,
    });
    expect(timers.entries.size).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:1119/auth/login");
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[0]!.init.redirect).toBe("error");
    expect(requests[0]!.init.body).toBe(
      JSON.stringify({ username: USERNAME, password: PASSWORD }),
    );
    const loginHeaders = new Headers(requests[0]!.init.headers);
    expect(loginHeaders.get("authorization")).toBeNull();
    expect(JSON.stringify([...loginHeaders])).not.toContain(USERNAME);
    expect(JSON.stringify([...loginHeaders])).not.toContain(PASSWORD);
    expect(requests[0]!.url).not.toContain(USERNAME);
    expect(requests[0]!.url).not.toContain(PASSWORD);

    await service.start();
    expect(requests).toHaveLength(1);
    expect(timers.delays()).toEqual([600_000]);

    const periodicTimer = timers.fireEarliest();
    await flushMicrotasks();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe(
      "http://127.0.0.1:1119/auth/check_expiration",
    );
    expect(requests[1]!.init.body).toBeUndefined();
    expect(new Headers(requests[1]!.init.headers).get("authorization")).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );

    periodicTimer.callback();
    const sharedCheck = service.checkExpiration();
    await flushMicrotasks();
    expect(requests).toHaveLength(2);
    expect(maximumActiveRequests).toBe(1);

    resolveCheck(successfulCheck(START_TIME + 7_200_000));
    await sharedCheck;
    expect(service.status()).toMatchObject({
      state: "active",
      authenticated: true,
      expirationAt: START_TIME + 7_200_000,
    });
    expect(timers.delays()).toEqual([600_000]);
    expect(stop).not.toHaveBeenCalled();

    const noConfiguredBearer = service.createRequestAuthorizer(() => ({
      configured: false,
      authorized: true,
    }));
    const wrongBearer = service.createRequestAuthorizer(() => ({
      configured: true,
      authorized: false,
    }));
    const validBearer = service.createRequestAuthorizer(() => ({
      configured: true,
      authorized: true,
    }));
    expect(await noConfiguredBearer({})).toBe(false);
    expect(await wrongBearer({})).toBe(false);
    expect(await validBearer({})).toBe(true);

    assertRedacted(service.status());
    assertRedacted(statuses);
    await service.dispose();
    periodicTimer.callback();
    await flushMicrotasks();
    expect(timers.entries.size).toBe(0);
    expect(requests).toHaveLength(2);
  });

  it("rejects non-loopback HTTP unless the explicit development flag is enabled", async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const blockedFetch = vi.fn<LegacyUmsFetch>();
    const blockedStop = vi.fn();
    const blocked = new LegacyUmsService(
      enabledConfig({ ums_api: "http://127.attacker.example:1119" }),
      { fetch: blockedFetch, clock, timers, stop: blockedStop },
    );

    expect(await blocked.start()).toMatchObject({
      state: "error",
      failureCode: "invalid-configuration",
      authenticated: false,
    });
    expect(blockedFetch).not.toHaveBeenCalled();
    expect(blockedStop).toHaveBeenCalledOnce();

    const allowedFetch: LegacyUmsFetch = async () =>
      successfulLogin(START_TIME + 3_600_000);
    const allowedTimers = new FakeTimers(clock);
    const allowed = new LegacyUmsService(
      enabledConfig({
        ums_api: "http://ums.example.test:1119",
        allow_insecure_development_http: true,
        check_interval_seconds: 30,
      }),
      { fetch: allowedFetch, clock, timers: allowedTimers, stop: vi.fn() },
    );
    expect(await allowed.start()).toMatchObject({
      state: "active",
      authenticated: true,
    });
    expect(allowedTimers.delays()).toEqual([30_000]);
    await allowed.dispose();
  });

  it("stops with a redacted degraded status when a remote or local timestamp is expired", async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const statuses: LegacyUmsStatus[] = [];
    const stop = vi.fn();
    let requestCount = 0;
    const fetch: LegacyUmsFetch = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return successfulLogin(START_TIME + 3_600_000);
      }
      return successfulCheck(clock.value - 1);
    };
    const service = new LegacyUmsService(enabledConfig(), {
      fetch,
      clock,
      timers,
      stop,
      publishStatus: (status) => {
        statuses.push(status);
      },
    });

    await service.start();
    const status = await service.checkExpiration();
    expect(status).toEqual({
      enabled: true,
      state: "degraded",
      authenticated: false,
      operation: "expiration-check",
      failureCode: "expired",
      expirationAt: clock.value - 1,
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(status);
    expect(timers.entries.size).toBe(0);
    assertRedacted(statuses);
    assertRedacted(stop.mock.calls);

    const authorizer = service.createRequestAuthorizer(() => ({
      configured: true,
      authorized: true,
    }));
    expect(await authorizer("request")).toBe(false);
  });

  it.each([
    {
      name: "malformed response",
      response: () =>
        Response.json({
          code: 0,
          success: true,
          data: { message: `${USERNAME}:${PASSWORD}:${ACCESS_TOKEN}` },
        }),
      expected: "malformed-response",
    },
    {
      name: "non-2xx response",
      response: () => new Response("untrusted body", { status: 503 }),
      expected: "http-status",
    },
    {
      name: "oversized response",
      response: () => new Response("x".repeat(200)),
      expected: "response-too-large",
      max_response_bytes: 32,
    },
  ])("fails closed for $name", async ({ response, expected, max_response_bytes }) => {
    const clock = new FakeClock();
    const statuses: LegacyUmsStatus[] = [];
    const stop = vi.fn();
    const service = new LegacyUmsService(
      enabledConfig({
        ...(max_response_bytes === undefined ? {} : { max_response_bytes }),
      }),
      {
        fetch: async () => response(),
        clock,
        timers: new FakeTimers(clock),
        stop,
        publishStatus: (status) => {
          statuses.push(status);
        },
      },
    );

    expect(await service.start()).toMatchObject({
      state: "error",
      authenticated: false,
      operation: "login",
      failureCode: expected,
    });
    expect(stop).toHaveBeenCalledOnce();
    assertRedacted(service.status());
    assertRedacted(statuses);
    assertRedacted(stop.mock.calls);
  });

  it("turns network errors into deterministic redacted failure status", async () => {
    const clock = new FakeClock();
    const stop = vi.fn();
    const service = new LegacyUmsService(enabledConfig(), {
      fetch: async () => {
        throw new Error(`network failed for ${USERNAME} with ${PASSWORD}`);
      },
      clock,
      timers: new FakeTimers(clock),
      stop,
    });

    expect(await service.start()).toEqual({
      enabled: true,
      state: "error",
      authenticated: false,
      operation: "login",
      failureCode: "network",
    });
    expect(stop).toHaveBeenCalledOnce();
    assertRedacted(service.status());
    assertRedacted(stop.mock.calls);
  });

  it("bounds hung requests with the injected timeout timer", async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const stop = vi.fn();
    const fetch: LegacyUmsFetch = async () =>
      new Promise<Response>(() => undefined);
    const service = new LegacyUmsService(
      enabledConfig({ request_timeout_ms: 25 }),
      { fetch, clock, timers, stop },
    );

    const starting = service.start();
    await flushMicrotasks();
    expect(timers.delays()).toEqual([25]);
    timers.fireEarliest();
    expect(await starting).toEqual({
      enabled: true,
      state: "error",
      authenticated: false,
      operation: "login",
      failureCode: "timeout",
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(timers.entries.size).toBe(0);
  });

  it("aborts an in-flight request and removes timers when its lifecycle signal is disposed", async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const lifecycle = new AbortController();
    const stop = vi.fn();
    let requestSignal: AbortSignal | undefined;
    const fetch: LegacyUmsFetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    };
    const service = new LegacyUmsService(enabledConfig(), {
      fetch,
      clock,
      timers,
      stop,
    });

    const starting = service.start(lifecycle.signal);
    await flushMicrotasks();
    expect(requestSignal?.aborted).toBe(false);
    lifecycle.abort(new DOMException("runtime stopping", "AbortError"));
    await starting;

    expect(requestSignal?.aborted).toBe(true);
    expect(service.status()).toEqual({
      enabled: true,
      state: "disposed",
      authenticated: false,
    });
    expect(timers.entries.size).toBe(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it("expires locally in the request authorizer without waiting for another network check", async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const stop = vi.fn();
    const service = new LegacyUmsService(enabledConfig(), {
      fetch: async () => successfulLogin(START_TIME + 1_000),
      clock,
      timers,
      stop,
    });
    await service.login();
    const authorizer = service.createRequestAuthorizer(() => ({
      configured: true,
      authorized: true,
    }));

    clock.value += 1_001;
    expect(await authorizer("request")).toBe(false);
    expect(service.status()).toMatchObject({
      state: "degraded",
      failureCode: "expired",
      authenticated: false,
    });
    expect(stop).toHaveBeenCalledOnce();
  });
});
