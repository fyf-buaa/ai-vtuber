import {
  LifecycleOrder,
  type LifecyclePlugin,
} from "../runtime/application.js";

export const DEFAULT_LEGACY_UMS_CHECK_INTERVAL_SECONDS = 600;
export const DEFAULT_LEGACY_UMS_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_LEGACY_UMS_MAX_RESPONSE_BYTES = 64 * 1024;

const MAX_USERNAME_LENGTH = 1_024;
const MAX_PASSWORD_LENGTH = 8_192;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const MAX_API_URL_LENGTH = 2_048;
const MAX_EXPIRATION_LENGTH = 128;

export interface LegacyUmsLoginConfig {
  readonly enable?: boolean;
  readonly username?: string;
  readonly password?: string;
  readonly ums_api?: string;
  readonly check_interval_seconds?: number;
  readonly request_timeout_ms?: number;
  readonly max_response_bytes?: number;
  readonly allow_insecure_development_http?: boolean;
}

export interface LegacyUmsClock {
  now(): number;
}

export interface LegacyUmsTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type LegacyUmsFetch = typeof globalThis.fetch;

export type LegacyUmsState =
  | "disabled"
  | "idle"
  | "logging-in"
  | "checking"
  | "active"
  | "degraded"
  | "error"
  | "disposed";

export type LegacyUmsOperation = "login" | "expiration-check";

export type LegacyUmsFailureCode =
  | "invalid-configuration"
  | "not-authenticated"
  | "login-rejected"
  | "expiration-rejected"
  | "expired"
  | "http-status"
  | "malformed-response"
  | "response-too-large"
  | "timeout"
  | "aborted"
  | "network";

/** Status is intentionally limited to non-secret operational metadata. */
export interface LegacyUmsStatus {
  readonly enabled: boolean;
  readonly state: LegacyUmsState;
  readonly authenticated: boolean;
  readonly operation?: LegacyUmsOperation;
  readonly expirationAt?: number;
  readonly lastValidatedAt?: number;
  readonly nextCheckAt?: number;
  readonly failureCode?: LegacyUmsFailureCode;
  readonly httpStatus?: number;
}

export interface LegacyUmsDependencies {
  readonly stop: (status: LegacyUmsStatus) => void | Promise<void>;
  readonly publishStatus?: (status: LegacyUmsStatus) => void | Promise<void>;
  readonly fetch?: LegacyUmsFetch;
  readonly clock?: LegacyUmsClock;
  readonly timers?: LegacyUmsTimers;
}

/**
 * A positive decision means that a configured local bearer token was presented
 * and verified. Keeping `configured` separate prevents an optional bearer
 * setup from accidentally treating "no token configured" as authenticated.
 */
export interface LocalBearerAuthorization {
  readonly configured: boolean;
  readonly authorized: boolean;
}

export type LocalBearerAuthorizer<Request> = (
  request: Request,
) => LocalBearerAuthorization | Promise<LocalBearerAuthorization>;

export type LegacyUmsRequestAuthorizer<Request> = (
  request: Request,
) => Promise<boolean>;

interface ResolvedSettings {
  readonly loginUrl: string;
  readonly expirationUrl: string;
  readonly username: string;
  readonly password: string;
  readonly checkIntervalMs: number;
  readonly requestTimeoutMs: number;
  readonly maxResponseBytes: number;
}

interface ParsedLoginResponse {
  readonly accessToken: string;
  readonly expirationAt: number;
}

interface ParsedExpirationResponse {
  readonly expirationAt: number;
}

class LegacyUmsOperationError extends Error {
  constructor(
    readonly code: LegacyUmsFailureCode,
    readonly httpStatus?: number,
    readonly expirationAt?: number,
  ) {
    super(code);
    this.name = "LegacyUmsOperationError";
  }
}

const systemClock: LegacyUmsClock = {
  now: () => Date.now(),
};

const systemTimers: LegacyUmsTimers = {
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export class LegacyUmsService {
  readonly #config: Readonly<LegacyUmsLoginConfig>;
  readonly #stop: LegacyUmsDependencies["stop"];
  readonly #publishStatus: LegacyUmsDependencies["publishStatus"];
  readonly #fetch: LegacyUmsFetch;
  readonly #clock: LegacyUmsClock;
  readonly #timers: LegacyUmsTimers;

  #currentStatus: LegacyUmsStatus;
  #accessToken: string | undefined;
  #expirationAt: number | undefined;
  #lastValidatedAt: number | undefined;
  #checkIntervalMs: number | undefined;
  #scheduledCheck: unknown | undefined;
  #timerGeneration = 0;
  #requestController: AbortController | undefined;
  #externalSignal: AbortSignal | undefined;
  #externalAbortListener: (() => void) | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  readonly #pendingOperations = new Set<Promise<LegacyUmsStatus>>();
  #startPromise: Promise<LegacyUmsStatus> | undefined;
  #loginPromise: Promise<LegacyUmsStatus> | undefined;
  #checkPromise: Promise<LegacyUmsStatus> | undefined;
  #disposePromise: Promise<void> | undefined;
  #started = false;
  #disposed = false;
  #terminalFailure = false;
  #stopInvoked = false;

  constructor(
    config: LegacyUmsLoginConfig,
    dependencies: LegacyUmsDependencies,
  ) {
    if (typeof dependencies.stop !== "function") {
      throw new TypeError("Legacy UMS requires a stop callback");
    }

    this.#config = Object.freeze({ ...config });
    this.#stop = dependencies.stop;
    this.#publishStatus = dependencies.publishStatus;
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#clock = dependencies.clock ?? systemClock;
    this.#timers = dependencies.timers ?? systemTimers;

    const enabled = this.#config.enable === true;
    this.#currentStatus = freezeStatus({
      enabled,
      state: enabled ? "idle" : "disabled",
      authenticated: false,
    });
  }

  status(): LegacyUmsStatus {
    return freezeStatus(this.#currentStatus);
  }

  async start(signal?: AbortSignal): Promise<LegacyUmsStatus> {
    if (!this.#isEnabled() || this.#disposed) {
      return this.status();
    }
    if (this.#startPromise !== undefined) {
      return this.#startPromise;
    }
    if (this.#started) {
      return this.status();
    }

    this.#started = true;
    if (signal !== undefined) {
      if (signal.aborted) {
        await this.dispose();
        return this.status();
      }
      this.#externalSignal = signal;
      this.#externalAbortListener = () => {
        void this.dispose();
      };
      signal.addEventListener("abort", this.#externalAbortListener, {
        once: true,
      });
    }

    const operation = (async (): Promise<LegacyUmsStatus> => {
      if (this.#isLocallyAuthenticated()) {
        await this.#publishActiveStatus(
          this.#lastValidatedAt ?? this.#now(),
          this.#expirationAt!,
        );
        return this.status();
      }
      return this.login();
    })();
    this.#startPromise = operation;
    void operation.then(
      () => {
        if (this.#startPromise === operation) {
          this.#startPromise = undefined;
        }
      },
      () => {
        if (this.#startPromise === operation) {
          this.#startPromise = undefined;
        }
      },
    );
    return operation;
  }

  login(): Promise<LegacyUmsStatus> {
    if (!this.#isEnabled() || this.#disposed || this.#terminalFailure) {
      return Promise.resolve(this.status());
    }
    if (this.#loginPromise !== undefined) {
      return this.#loginPromise;
    }

    this.#clearScheduledCheck();
    const operation = this.#trackOperation(
      this.#enqueueOperation(async () => this.#performLogin()),
    );
    this.#loginPromise = operation;
    void operation.then(
      () => {
        if (this.#loginPromise === operation) {
          this.#loginPromise = undefined;
        }
      },
      () => {
        if (this.#loginPromise === operation) {
          this.#loginPromise = undefined;
        }
      },
    );
    return operation;
  }

  checkExpiration(): Promise<LegacyUmsStatus> {
    if (!this.#isEnabled() || this.#disposed || this.#terminalFailure) {
      return Promise.resolve(this.status());
    }
    if (this.#checkPromise !== undefined) {
      return this.#checkPromise;
    }

    this.#clearScheduledCheck();
    const operation = this.#trackOperation(
      this.#enqueueOperation(async () => this.#performExpirationCheck()),
    );
    this.#checkPromise = operation;
    void operation.then(
      () => {
        if (this.#checkPromise === operation) {
          this.#checkPromise = undefined;
        }
      },
      () => {
        if (this.#checkPromise === operation) {
          this.#checkPromise = undefined;
        }
      },
    );
    return operation;
  }

  createRequestAuthorizer<Request>(
    localBearerAuthorizer: LocalBearerAuthorizer<Request>,
  ): LegacyUmsRequestAuthorizer<Request> {
    if (typeof localBearerAuthorizer !== "function") {
      throw new TypeError("A local bearer authorizer is required");
    }

    return async (request: Request): Promise<boolean> => {
      let bearer: LocalBearerAuthorization;
      try {
        bearer = await localBearerAuthorizer(request);
      } catch {
        return false;
      }
      if (bearer.configured !== true || bearer.authorized !== true) {
        return false;
      }
      return this.#accountAllowsRequest();
    };
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) {
      return this.#disposePromise;
    }

    const operation = this.#dispose();
    this.#disposePromise = operation;
    return operation;
  }

  async #performLogin(): Promise<LegacyUmsStatus> {
    if (this.#disposed || this.#terminalFailure) {
      return this.status();
    }

    this.#clearScheduledCheck();
    this.#accessToken = undefined;
    this.#expirationAt = undefined;
    await this.#setStatus({
      enabled: true,
      state: "logging-in",
      authenticated: false,
      operation: "login",
    });

    try {
      const settings = this.#resolveSettings();
      this.#checkIntervalMs = settings.checkIntervalMs;
      const response = await this.#postJson(
        settings.loginUrl,
        {
          username: settings.username,
          password: settings.password,
        },
        undefined,
        settings,
      );
      const validatedAt = this.#now();
      const parsed = parseLoginResponse(response, validatedAt);
      if (this.#disposed) {
        return this.status();
      }

      this.#accessToken = parsed.accessToken;
      this.#expirationAt = parsed.expirationAt;
      this.#lastValidatedAt = validatedAt;
      await this.#publishActiveStatus(validatedAt, parsed.expirationAt);
      return this.status();
    } catch (error) {
      if (this.#disposed) {
        return this.status();
      }
      return this.#fail("login", normalizeFailure(error));
    }
  }

  async #performExpirationCheck(): Promise<LegacyUmsStatus> {
    if (this.#disposed || this.#terminalFailure) {
      return this.status();
    }

    this.#clearScheduledCheck();
    const accessToken = this.#accessToken;
    const expirationAt = this.#expirationAt;
    if (accessToken === undefined || expirationAt === undefined) {
      return this.#fail(
        "expiration-check",
        new LegacyUmsOperationError("not-authenticated"),
      );
    }

    let checkedAt: number;
    try {
      checkedAt = this.#now();
    } catch (error) {
      return this.#fail("expiration-check", normalizeFailure(error));
    }
    if (expirationAt <= checkedAt) {
      return this.#fail(
        "expiration-check",
        new LegacyUmsOperationError("expired", undefined, expirationAt),
      );
    }

    await this.#setStatus({
      enabled: true,
      state: "checking",
      authenticated: true,
      operation: "expiration-check",
      expirationAt,
      ...(this.#lastValidatedAt === undefined
        ? {}
        : { lastValidatedAt: this.#lastValidatedAt }),
    });

    try {
      const settings = this.#resolveSettings();
      this.#checkIntervalMs = settings.checkIntervalMs;
      const response = await this.#postJson(
        settings.expirationUrl,
        undefined,
        accessToken,
        settings,
      );
      const validatedAt = this.#now();
      const parsed = parseExpirationResponse(response, validatedAt);
      if (this.#disposed || this.#terminalFailure) {
        return this.status();
      }

      this.#expirationAt = parsed.expirationAt;
      this.#lastValidatedAt = validatedAt;
      await this.#publishActiveStatus(validatedAt, parsed.expirationAt);
      return this.status();
    } catch (error) {
      if (this.#disposed || this.#terminalFailure) {
        return this.status();
      }
      return this.#fail("expiration-check", normalizeFailure(error));
    }
  }

  async #postJson(
    url: string,
    body: Readonly<Record<string, string>> | undefined,
    accessToken: string | undefined,
    settings: ResolvedSettings,
  ): Promise<unknown> {
    const controller = new AbortController();
    this.#requestController = controller;
    const requestHeaders: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined) {
      requestHeaders["Content-Type"] = "application/json";
    }
    if (accessToken !== undefined) {
      requestHeaders.Authorization = `Bearer ${accessToken}`;
    }

    let timeoutHandle: unknown | undefined;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        reject(
          controller.signal.reason ??
            new LegacyUmsOperationError("aborted"),
        );
      };
      controller.signal.addEventListener("abort", abortListener, {
        once: true,
      });
    });

    try {
      timeoutHandle = this.#timers.setTimeout(() => {
        controller.abort(new LegacyUmsOperationError("timeout"));
      }, settings.requestTimeoutMs);
      if (controller.signal.aborted) {
        throw (
          controller.signal.reason ??
          new LegacyUmsOperationError("aborted")
        );
      }
      const transport = (async (): Promise<unknown> => {
        const response = await this.#fetch(url, {
          method: "POST",
          headers: requestHeaders,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: "error",
        });
        if (!isResponseLike(response)) {
          throw new LegacyUmsOperationError("malformed-response");
        }
        if (!response.ok || response.status < 200 || response.status >= 300) {
          throw new LegacyUmsOperationError("http-status", response.status);
        }
        const text = await readBoundedBody(
          response,
          settings.maxResponseBytes,
          controller,
        );
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new LegacyUmsOperationError("malformed-response");
        }
      })();
      return await Promise.race([transport, aborted]);
    } catch (error) {
      if (error instanceof LegacyUmsOperationError) {
        throw error;
      }
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof LegacyUmsOperationError) {
          throw reason;
        }
        throw new LegacyUmsOperationError("aborted");
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new LegacyUmsOperationError("aborted");
      }
      throw new LegacyUmsOperationError("network");
    } finally {
      if (timeoutHandle !== undefined) {
        this.#timers.clearTimeout(timeoutHandle);
      }
      if (abortListener !== undefined) {
        controller.signal.removeEventListener("abort", abortListener);
      }
      if (this.#requestController === controller) {
        this.#requestController = undefined;
      }
    }
  }

  async #publishActiveStatus(
    validatedAt: number,
    expirationAt: number,
  ): Promise<void> {
    let nextCheckAt: number | undefined;
    if (this.#started && !this.#disposed && !this.#terminalFailure) {
      const intervalMs = this.#checkIntervalMs;
      if (intervalMs === undefined) {
        throw new LegacyUmsOperationError("invalid-configuration");
      }
      const now = this.#now();
      const delayMs = Math.min(intervalMs, Math.max(0, expirationAt - now));
      nextCheckAt = now + delayMs;
      this.#scheduleCheck(delayMs);
    }

    await this.#setStatus({
      enabled: true,
      state: "active",
      authenticated: true,
      expirationAt,
      lastValidatedAt: validatedAt,
      ...(nextCheckAt === undefined ? {} : { nextCheckAt }),
    });
  }

  #scheduleCheck(delayMs: number): void {
    this.#clearScheduledCheck();
    const generation = ++this.#timerGeneration;
    const handle = this.#timers.setTimeout(() => {
      if (this.#timerGeneration !== generation || this.#disposed) {
        return;
      }
      this.#scheduledCheck = undefined;
      void this.checkExpiration().catch(() => undefined);
    }, delayMs);
    this.#scheduledCheck = handle;
  }

  #clearScheduledCheck(): void {
    ++this.#timerGeneration;
    if (this.#scheduledCheck !== undefined) {
      this.#timers.clearTimeout(this.#scheduledCheck);
      this.#scheduledCheck = undefined;
    }
  }

  async #accountAllowsRequest(): Promise<boolean> {
    if (this.#disposed) {
      return false;
    }
    if (!this.#isEnabled()) {
      return true;
    }
    if (
      (this.#currentStatus.state !== "active" &&
        this.#currentStatus.state !== "checking") ||
      !this.#currentStatus.authenticated ||
      this.#expirationAt === undefined ||
      this.#accessToken === undefined
    ) {
      return false;
    }

    let now: number;
    try {
      now = this.#now();
    } catch (error) {
      await this.#fail("expiration-check", normalizeFailure(error));
      return false;
    }
    if (this.#expirationAt <= now) {
      await this.#fail(
        "expiration-check",
        new LegacyUmsOperationError(
          "expired",
          undefined,
          this.#expirationAt,
        ),
      );
      return false;
    }
    return true;
  }

  async #fail(
    operation: LegacyUmsOperation,
    failure: LegacyUmsOperationError,
  ): Promise<LegacyUmsStatus> {
    if (this.#disposed || this.#terminalFailure) {
      return this.status();
    }

    this.#terminalFailure = true;
    this.#clearScheduledCheck();
    this.#requestController?.abort(failure);
    this.#requestController = undefined;
    this.#accessToken = undefined;
    this.#expirationAt = undefined;
    const status: LegacyUmsStatus = {
      enabled: true,
      state: failure.code === "expired" ? "degraded" : "error",
      authenticated: false,
      operation,
      failureCode: failure.code,
      ...(failure.expirationAt === undefined
        ? {}
        : { expirationAt: failure.expirationAt }),
      ...(failure.httpStatus === undefined
        ? {}
        : { httpStatus: failure.httpStatus }),
    };
    const publication = this.#setStatus(status);
    this.#invokeStop(status);
    await publication;
    return this.status();
  }

  #invokeStop(status: LegacyUmsStatus): void {
    if (this.#stopInvoked) {
      return;
    }
    this.#stopInvoked = true;
    try {
      const result = this.#stop(freezeStatus(status));
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // The account failure remains authoritative even if shutdown reporting fails.
    }
  }

  async #setStatus(status: LegacyUmsStatus): Promise<void> {
    this.#currentStatus = freezeStatus(status);
    if (this.#publishStatus === undefined) {
      return;
    }
    try {
      const publication = this.#publishStatus(this.status());
      void Promise.resolve(publication).catch(() => undefined);
    } catch {
      // Observability must not alter authorization or shutdown decisions.
    }
  }

  #resolveSettings(): ResolvedSettings {
    const username = requiredSecretString(
      this.#config.username,
      MAX_USERNAME_LENGTH,
    );
    const password = requiredSecretString(
      this.#config.password,
      MAX_PASSWORD_LENGTH,
    );
    const apiText = requiredString(this.#config.ums_api, MAX_API_URL_LENGTH);
    let baseUrl: URL;
    try {
      baseUrl = new URL(apiText);
    } catch {
      throw new LegacyUmsOperationError("invalid-configuration");
    }
    if (baseUrl.username !== "" || baseUrl.password !== "") {
      throw new LegacyUmsOperationError("invalid-configuration");
    }
    if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
      throw new LegacyUmsOperationError("invalid-configuration");
    }
    if (
      baseUrl.protocol === "http:" &&
      !isLoopbackHostname(baseUrl.hostname) &&
      this.#config.allow_insecure_development_http !== true
    ) {
      throw new LegacyUmsOperationError("invalid-configuration");
    }
    if (
      this.#config.allow_insecure_development_http !== undefined &&
      typeof this.#config.allow_insecure_development_http !== "boolean"
    ) {
      throw new LegacyUmsOperationError("invalid-configuration");
    }

    const checkIntervalSeconds = positiveNumber(
      this.#config.check_interval_seconds,
      DEFAULT_LEGACY_UMS_CHECK_INTERVAL_SECONDS,
    );
    const checkIntervalMs = checkIntervalSeconds * 1_000;
    if (!Number.isSafeInteger(checkIntervalMs)) {
      throw new LegacyUmsOperationError("invalid-configuration");
    }
    const requestTimeoutMs = positiveInteger(
      this.#config.request_timeout_ms,
      DEFAULT_LEGACY_UMS_REQUEST_TIMEOUT_MS,
    );
    const maxResponseBytes = positiveInteger(
      this.#config.max_response_bytes,
      DEFAULT_LEGACY_UMS_MAX_RESPONSE_BYTES,
    );

    return {
      loginUrl: new URL("/auth/login", baseUrl).toString(),
      expirationUrl: new URL("/auth/check_expiration", baseUrl).toString(),
      username,
      password,
      checkIntervalMs,
      requestTimeoutMs,
      maxResponseBytes,
    };
  }

  #now(): number {
    const now = this.#clock.now();
    if (!Number.isFinite(now)) {
      throw new LegacyUmsOperationError("invalid-configuration");
    }
    return now;
  }

  #isEnabled(): boolean {
    return this.#config.enable === true;
  }

  #isLocallyAuthenticated(): boolean {
    if (
      this.#accessToken === undefined ||
      this.#expirationAt === undefined ||
      this.#currentStatus.authenticated !== true
    ) {
      return false;
    }
    try {
      return this.#expirationAt > this.#now();
    } catch {
      return false;
    }
  }

  #enqueueOperation(
    operation: () => Promise<LegacyUmsStatus>,
  ): Promise<LegacyUmsStatus> {
    const previous = this.#operationTail;
    let release!: () => void;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return (async (): Promise<LegacyUmsStatus> => {
      await previous;
      try {
        if (this.#disposed || this.#terminalFailure) {
          return this.status();
        }
        return await operation();
      } finally {
        release();
      }
    })();
  }

  #trackOperation(
    operation: Promise<LegacyUmsStatus>,
  ): Promise<LegacyUmsStatus> {
    this.#pendingOperations.add(operation);
    void operation.then(
      () => this.#pendingOperations.delete(operation),
      () => this.#pendingOperations.delete(operation),
    );
    return operation;
  }

  async #dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#clearScheduledCheck();
    if (
      this.#externalSignal !== undefined &&
      this.#externalAbortListener !== undefined
    ) {
      this.#externalSignal.removeEventListener(
        "abort",
        this.#externalAbortListener,
      );
    }
    this.#externalSignal = undefined;
    this.#externalAbortListener = undefined;
    this.#accessToken = undefined;
    this.#expirationAt = undefined;
    this.#requestController?.abort(
      new DOMException("Legacy UMS disposed", "AbortError"),
    );
    this.#requestController = undefined;

    const publication = this.#setStatus({
      enabled: this.#isEnabled(),
      state: "disposed",
      authenticated: false,
    });
    const pending = [...this.#pendingOperations];
    await Promise.allSettled(pending);
    await publication;
  }
}

export function createLegacyUmsLifecyclePlugin(
  service: LegacyUmsService,
): LifecyclePlugin {
  return {
    name: "legacy-ums",
    order: LifecycleOrder.extension,
    start: async (context) => {
      await service.start(context.signal);
    },
    stop: async () => {
      await service.dispose();
    },
    status: () => service.status(),
  };
}

function parseLoginResponse(value: unknown, now: number): ParsedLoginResponse {
  const envelope = parseEnvelope(value, "login", now);
  const accessToken = envelope.data["accessToken"];
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
    !/^[\x21-\x7e]+$/u.test(accessToken)
  ) {
    throw new LegacyUmsOperationError("malformed-response");
  }
  return {
    accessToken,
    expirationAt: envelope.expirationAt,
  };
}

function parseExpirationResponse(
  value: unknown,
  now: number,
): ParsedExpirationResponse {
  const envelope = parseEnvelope(value, "expiration-check", now);
  return { expirationAt: envelope.expirationAt };
}

function parseEnvelope(
  value: unknown,
  operation: LegacyUmsOperation,
  now: number,
): {
  readonly data: Readonly<Record<string, unknown>>;
  readonly expirationAt: number;
} {
  if (!isRecord(value)) {
    throw new LegacyUmsOperationError("malformed-response");
  }
  const code = value["code"];
  const success = value["success"];
  const data = value["data"];
  if (
    typeof code !== "number" ||
    !Number.isFinite(code) ||
    typeof success !== "boolean" ||
    !isRecord(data)
  ) {
    throw new LegacyUmsOperationError("malformed-response");
  }

  const expirationAt = parseExpiration(data["expiration_ts"]);
  if (expirationAt <= now) {
    throw new LegacyUmsOperationError("expired", undefined, expirationAt);
  }
  if (code !== 0 || success !== true) {
    throw new LegacyUmsOperationError(
      operation === "login" ? "login-rejected" : "expiration-rejected",
    );
  }
  return { data, expirationAt };
}

function parseExpiration(value: unknown): number {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EXPIRATION_LENGTH
  ) {
    throw new LegacyUmsOperationError("malformed-response");
  }
  const expirationAt = Date.parse(value);
  if (!Number.isFinite(expirationAt)) {
    throw new LegacyUmsOperationError("malformed-response");
  }
  return expirationAt;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength)) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      const failure = new LegacyUmsOperationError("response-too-large");
      controller.abort(failure);
      throw failure;
    }
  }

  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) {
        throw new LegacyUmsOperationError("malformed-response");
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        const failure = new LegacyUmsOperationError("response-too-large");
        controller.abort(failure);
        throw failure;
      }
      try {
        parts.push(decoder.decode(chunk.value, { stream: true }));
      } catch {
        throw new LegacyUmsOperationError("malformed-response");
      }
    }
    try {
      parts.push(decoder.decode());
    } catch {
      throw new LegacyUmsOperationError("malformed-response");
    }
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}

function isResponseLike(value: unknown): value is Response {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["ok"] === "boolean" &&
    typeof value["status"] === "number" &&
    Number.isInteger(value["status"]) &&
    isRecord(value["headers"]) &&
    typeof value["headers"]["get"] === "function" &&
    (value["body"] === null ||
      (isRecord(value["body"]) &&
        typeof value["body"]["getReader"] === "function"))
  );
}

function normalizeFailure(error: unknown): LegacyUmsOperationError {
  if (error instanceof LegacyUmsOperationError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new LegacyUmsOperationError("aborted");
  }
  return new LegacyUmsOperationError("network");
}

function requiredString(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maxLength
  ) {
    throw new LegacyUmsOperationError("invalid-configuration");
  }
  return value.trim();
}

function requiredSecretString(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new LegacyUmsOperationError("invalid-configuration");
  }
  return value;
}

function positiveNumber(value: unknown, fallback: number): number {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
    throw new LegacyUmsOperationError("invalid-configuration");
  }
  return candidate;
}

function positiveInteger(value: unknown, fallback: number): number {
  const candidate = positiveNumber(value, fallback);
  if (!Number.isSafeInteger(candidate)) {
    throw new LegacyUmsOperationError("invalid-configuration");
  }
  return candidate;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.$/u, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1"
  ) {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeStatus(status: LegacyUmsStatus): LegacyUmsStatus {
  return Object.freeze({ ...status });
}
