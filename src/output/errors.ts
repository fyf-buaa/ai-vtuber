import type { EventPublisher } from "../domain/types.js";

export type OutputErrorCode =
  | "OUTPUT_ABORTED"
  | "OUTPUT_CONFIG_INVALID"
  | "OUTPUT_PATH_INVALID"
  | "OUTPUT_REQUEST_FAILED"
  | "OUTPUT_RESPONSE_INVALID"
  | "OUTPUT_TIMEOUT"
  | "OUTPUT_UNSUPPORTED";

export interface OutputBridgeErrorOptions {
  readonly code: OutputErrorCode;
  readonly component: string;
  readonly cause?: unknown;
  readonly status?: number;
}

export class OutputBridgeError extends Error {
  readonly code: OutputErrorCode;
  readonly component: string;
  readonly status: number | undefined;

  constructor(message: string, options: OutputBridgeErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "OutputBridgeError";
    this.code = options.code;
    this.component = options.component;
    this.status = options.status;
  }
}

export class OutputConfigError extends OutputBridgeError {
  constructor(component: string, message: string, cause?: unknown) {
    super(message, {
      code: "OUTPUT_CONFIG_INVALID",
      component,
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "OutputConfigError";
  }
}

export class OutputPathError extends OutputBridgeError {
  constructor(component: string, message: string, cause?: unknown) {
    super(message, {
      code: "OUTPUT_PATH_INVALID",
      component,
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "OutputPathError";
  }
}

const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/iu;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|authorization|cookie|password|secret|token)\s*([=:])\s*([^\s,;]+)/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const PUBLISHED_FAILURES = new WeakSet<OutputBridgeError>();


function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username.length > 0) {
      url.username = "[REDACTED]";
    }
    if (url.password.length > 0) {
      url.password = "[REDACTED]";
    }
    for (const key of url.searchParams.keys()) {
      if (SECRET_KEY.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactText(value: string): string {
  const assigned = value.replace(
    SECRET_ASSIGNMENT,
    (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`,
  );
  const withoutBearer = assigned.replace(BEARER, "Bearer [REDACTED]");
  return withoutBearer.replace(/https?:\/\/[^\s"'<>]+/giu, (url) => redactUrl(url));
}

export function redactSecrets(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (SECRET_KEY.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, "", seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    redacted[entryKey] = redactSecrets(entryValue, entryKey, seen);
  }
  return redacted;
}

export function asOutputBridgeError(
  component: string,
  error: unknown,
  fallbackMessage: string,
): OutputBridgeError {
  if (error instanceof OutputBridgeError) {
    return error;
  }
  return new OutputBridgeError(fallbackMessage, {
    code: "OUTPUT_REQUEST_FAILED",
    component,
    cause: error,
  });
}

export type OutputClock = () => number;

export function publishOutputFailure(
  publisher: EventPublisher | undefined,
  error: OutputBridgeError,
  clock: OutputClock = Date.now,
  metadata?: Readonly<Record<string, unknown>>,
): void {
  if (publisher === undefined || PUBLISHED_FAILURES.has(error)) {
    return;
  }
  PUBLISHED_FAILURES.add(error);
  const safeMetadata = redactSecrets({
    code: error.code,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...metadata,
  });

  try {
    publisher.publish({
      type: "system.status",
      component: error.component,
      status: "degraded",
      message: redactText(error.message),
      metadata: safeMetadata as Readonly<Record<string, unknown>>,
      timestamp: clock(),
    });
  } catch {
    // Reporting must never replace the bridge failure that callers must handle.
  }
}
