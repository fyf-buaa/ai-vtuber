export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: LogFields | undefined;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(message: string, context?: LogFields): void;
  info(message: string, context?: LogFields): void;
  warn(message: string, context?: LogFields): void;
  error(message: string, context?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel | undefined;
  readonly bindings?: LogFields | undefined;
  readonly sink?: LogSink | undefined;
}

const REDACTED = "[REDACTED]";
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "credential" ||
    normalized === "credentials" ||
    normalized === "password" ||
    normalized === "passwd" ||
    normalized === "secret" ||
    normalized.endsWith("token") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("authtoken") ||
    normalized.endsWith("bearertoken") ||
    normalized.endsWith("idtoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secret")
  );
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, `Bearer ${REDACTED}`)
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/giu,
      REDACTED,
    )
    .replace(
      /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/gu,
      REDACTED,
    )
    .replace(
      /\b(authorization|api[_-]?key|token|access[_-]?token|auth[_-]?token|password|refresh[_-]?token|secret)(\s*[:=]\s*)([^&\s,;]+)/giu,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED}`,
    );
}

function redactValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "[undefined]";
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }

  ancestors.add(value);
  try {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof URL) {
      return redactText(value.toString());
    }
    if (value instanceof Error) {
      const errorDetails: Record<string, unknown> = {
        name: redactText(value.name),
        message: redactText(value.message),
      };
      if (value.stack !== undefined) {
        errorDetails.stack = redactText(value.stack);
      }
      if (value.cause !== undefined) {
        errorDetails.cause = redactValue(value.cause, ancestors);
      }
      for (const [key, child] of Object.entries(value)) {
        errorDetails[key] = isSensitiveKey(key)
          ? REDACTED
          : redactValue(child, ancestors);
      }
      return errorDetails;
    }
    if (ArrayBuffer.isView(value)) {
      return `[${value.constructor.name} ${value.byteLength} bytes]`;
    }
    if (Array.isArray(value)) {
      return value.map((child) => redactValue(child, ancestors));
    }

    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      redacted[key] = isSensitiveKey(key)
        ? REDACTED
        : redactValue(child, ancestors);
    }
    return redacted;
  } finally {
    ancestors.delete(value);
  }
}

export function redact(value: unknown): unknown {
  return redactValue(value, new Set<object>());
}

function writeJsonLine(record: LogRecord): void {
  const destination =
    record.level === "warn" || record.level === "error"
      ? process.stderr
      : process.stdout;
  destination.write(`${JSON.stringify(record)}\n`);
}

export class StructuredLogger implements Logger {
  readonly #level: LogLevel;
  readonly #bindings: LogFields;
  readonly #sink: LogSink;

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#bindings = options.bindings ?? {};
    this.#sink = options.sink ?? writeJsonLine;
  }

  debug(message: string, context?: LogFields): void {
    this.#write("debug", message, context);
  }

  info(message: string, context?: LogFields): void {
    this.#write("info", message, context);
  }

  warn(message: string, context?: LogFields): void {
    this.#write("warn", message, context);
  }

  error(message: string, context?: LogFields): void {
    this.#write("error", message, context);
  }

  child(bindings: LogFields): Logger {
    return new StructuredLogger({
      level: this.#level,
      bindings: { ...this.#bindings, ...bindings },
      sink: this.#sink,
    });
  }

  #write(level: LogLevel, message: string, context?: LogFields): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.#level]) {
      return;
    }

    const fields = context
      ? { ...this.#bindings, ...context }
      : this.#bindings;
    const redactedContext = redact(fields) as LogFields;
    const baseRecord = {
      timestamp: new Date().toISOString(),
      level,
      message: redactText(message),
    } satisfies Omit<LogRecord, "context">;
    const record: LogRecord =
      Object.keys(redactedContext).length === 0
        ? baseRecord
        : { ...baseRecord, context: redactedContext };

    this.#sink(record);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}
