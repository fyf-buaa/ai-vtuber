export const REDACTED_VALUE = "[REDACTED]";

const MAX_CONFIG_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const EXACT_SECRET_KEYS = new Set([
  "ac_time_value",
  "access_key",
  "access_key_id",
  "access_key_secret",
  "access_token",
  "api_key",
  "api_keys",
  "apikey",
  "app_key",
  "app_secret",
  "app_token",
  "auth_code",
  "auth_token",
  "authorization",
  "bearer_token",
  "client_secret",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "fd",
  "gt_token",
  "id_token",
  "passphrase",
  "passwd",
  "password",
  "private_key",
  "proxy_authorization",
  "refresh_token",
  "room_owner_auth_code",
  "secret",
  "secret_key",
  "session_token",
  "sessdata",
  "set_cookie",
  "signing_key",
  "subscription_key",
  "slack_user_token",
  "token",
  "webhook_secret",
]);

const HEADER_ASSIGNMENT =
  /(?:^|[^a-z\d_-])\s*["']?([!#$%&'*+.^_`|~\dA-Za-z-]+)["']?\s*[:=]/giu;
const EXACT_REDACTION_MARKER =
  /^(?:\[|<|\*{2,})?\s*redacted\s*(?:\]|>|\*{2,})?$/iu;
const REDACTION_MARKER_FRAGMENT = /\bredacted\b/iu;

export class ConfigDocumentError extends Error {
  readonly path: string;

  constructor(message: string, path = "$") {
    super(message);
    this.name = "ConfigDocumentError";
    this.path = path;
  }
}

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z\d]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (EXACT_SECRET_KEYS.has(normalized)) {
    return true;
  }

  return /(?:^|_)(?:api_key|access_key|auth_key|secret_key|access_token|refresh_token|auth_token|bearer_token|client_secret|private_key|signing_key|subscription_key|webhook_secret|password|passwd|passphrase|credential|secret|token)$/.test(
    normalized,
  );
}

export function containsEmbeddedSecret(value: string): boolean {
  if (/^\s*(?:bearer|basic)\s+\S+/i.test(value)) {
    return true;
  }

  for (const match of value.matchAll(HEADER_ASSIGNMENT)) {
    if (match[1] !== undefined && isSecretKey(match[1])) return true;
  }

  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    return false;
  }

  try {
    const parsed = new URL(value);
    if (parsed.username !== "" || parsed.password !== "") {
      return true;
    }
    for (const key of parsed.searchParams.keys()) {
      if (isSecretKey(key)) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

/** Produces a JSON-safe copy with credential-like fields removed. */
export function redactSecrets(value: unknown): unknown {
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, depth: number, parentKey?: string): unknown => {
    if (parentKey !== undefined && isSecretKey(parentKey)) {
      if (
        current === null ||
        (typeof current === "string" && current.trim() === "") ||
        (Array.isArray(current) && current.length === 0)
      ) {
        return current;
      }
      return REDACTED_VALUE;
    }
    if (typeof current === "string") {
      return containsEmbeddedSecret(current) ? REDACTED_VALUE : current;
    }
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "number"
    ) {
      return current;
    }
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (current === undefined || typeof current === "function" || typeof current === "symbol") {
      return null;
    }
    if (current instanceof Date) {
      return current.toISOString();
    }
    if (depth >= MAX_CONFIG_DEPTH) {
      return "[TRUNCATED]";
    }
    if (ancestors.has(current)) {
      return "[CIRCULAR]";
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((entry) => visit(entry, depth + 1));
      }

      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, entry] of Object.entries(current)) {
        output[key] = visit(entry, depth + 1, key);
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  };

  return visit(value, 0);
}

/** Restores only unambiguous placeholders from a redacted document. */
export function restoreRedactedValues(candidate: unknown, current: unknown): unknown {
  const visit = (
    next: unknown,
    previous: unknown,
    path: string,
    parentKey?: string,
  ): unknown => {
    if (typeof next === "string" && REDACTION_MARKER_FRAGMENT.test(next)) {
      const isExactMarker = EXACT_REDACTION_MARKER.test(next.trim());
      const protectsSecretKey =
        parentKey !== undefined && isSecretKey(parentKey);
      const protectsEmbeddedSecret =
        typeof previous === "string" && containsEmbeddedSecret(previous);

      if (isExactMarker || protectsSecretKey || protectsEmbeddedSecret) {
        const canRestore =
          previous !== undefined &&
          (parentKey === undefined ||
            protectsSecretKey ||
            protectsEmbeddedSecret);
        if (next !== REDACTED_VALUE || !canRestore) {
          throw new ConfigDocumentError(
            "脱敏占位符含义不明确；请保留原占位符，或使用空字符串显式清除密钥",
            path,
          );
        }
        return structuredClone(previous);
      }
    }

    if (Array.isArray(next)) {
      const currentArray = Array.isArray(previous) ? previous : [];
      return next.map((entry, index) =>
        visit(entry, currentArray[index], `${path}[${index}]`),
      );
    }

    if (isRecord(next)) {
      const currentRecord = isRecord(previous)
        ? previous
        : Object.create(null) as Record<string, unknown>;
      const output: Record<string, unknown> =
        Object.create(null) as Record<string, unknown>;
      for (const [key, entry] of Object.entries(next)) {
        output[key] = visit(
          entry,
          currentRecord[key],
          `${path}.${key}`,
          key,
        );
      }
      return output;
    }

    return next;
  };

  return visit(candidate, current, "$");
}

/** Validates the minimal invariants needed to save an unknown legacy schema safely. */
export function validateConfigDocument(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ConfigDocumentError("配置根节点必须是 JSON 对象");
  }

  const visit = (current: unknown, path: string, depth: number): void => {
    if (depth > MAX_CONFIG_DEPTH) {
      throw new ConfigDocumentError(`配置嵌套不能超过 ${MAX_CONFIG_DEPTH} 层`, path);
    }
    if (typeof current === "number" && !Number.isFinite(current)) {
      throw new ConfigDocumentError("数字必须是有限值", path);
    }
    if (current === null || typeof current !== "object") {
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, entry] of Object.entries(current)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ConfigDocumentError(`不允许配置键 ${key}`, `${path}.${key}`);
      }
      visit(entry, `${path}.${key}`, depth + 1);
    }
  };

  visit(value, "$", 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
