import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";


export type ConfigPathSegment = string | number;
export type TemplateVariables = Readonly<Record<string, unknown>>;

export function getConfigValue<T>(
  config: unknown,
  ...path: readonly ConfigPathSegment[]
): T | undefined {
  let current = config;

  for (const segment of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }

    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }

    current = (current as Record<string | number, unknown>)[segment];
  }

  return current as T;
}

export function toFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function toStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

export function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw abortError(signal);
  }
}

export function waitForWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }

  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = (): void => {
      rejectPromise(abortError(signal));
    };

    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        rejectPromise(error);
      },
    );
  });
}

export function renderTemplate(
  template: string,
  variables: TemplateVariables,
): string {
  return template.replace(/\{([A-Za-z_]\w*)\}/gu, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name)
      ? String(variables[name])
      : placeholder,
  );
}

export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function selectDeterministic<T>(
  values: readonly T[],
  seed: string,
): T | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return values[stableHash(seed) % values.length];
}

export function expandBracketChoices(text: string, seed: string): string {
  let occurrence = 0;
  return text.replace(/\[([^\]]*)\]/gu, (_placeholder, contents: string) => {
    const choices = contents.split("|");
    const choice = selectDeterministic(choices, `${seed}:${occurrence}`) ?? "";
    occurrence += 1;
    return choice;
  });
}

export function formatBeijingTime(timestamp: number): string {
  const utcPlusEight = new Date(timestamp + 8 * 60 * 60 * 1_000);
  return `${utcPlusEight.getUTCHours()}点${utcPlusEight.getUTCMinutes()}分`;
}

function removeTaggedSections(text: string): string {
  let result = text;

  for (let pass = 0; pass < 16; pass += 1) {
    const next = result.replace(
      /<([A-Za-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
      "",
    );
    if (next === result) {
      break;
    }
    result = next;
  }

  return result.replace(/<(?:think|analysis)\b[^>]*>[\s\S]*$/giu, "");
}

export class ContentFilters {
  readonly #baseDirectory: string;
  readonly #wordLists = new Map<string, Promise<readonly string[]>>();

  constructor(baseDirectory: string) {
    this.#baseDirectory = resolve(baseDirectory);
  }

  async applyProhibitions(
    text: string,
    config: unknown,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    throwIfAborted(signal);

    const enabled =
      getConfigValue(config, "filter", "badwords", "enable") === true;
    if (!enabled) {
      return text;
    }

    const configuredPath = getConfigValue<unknown>(
      config,
      "filter",
      "badwords",
      "path",
    );
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
      throw new Error(
        "filter.badwords.path must be a non-empty string when badword filtering is enabled",
      );
    }

    const terms = await this.#loadWordList(configuredPath, signal);
    const discard =
      getConfigValue(config, "filter", "badwords", "discard") === true;
    const replacement =
      getConfigValue<string>(config, "filter", "badwords", "replace") ?? "*";
    let filtered = text;

    for (const term of terms) {
      if (!filtered.includes(term)) {
        continue;
      }
      if (discard) {
        return undefined;
      }
      filtered = filtered.replaceAll(term, replacement);
    }

    return filtered;
  }

  cleanupResponse(text: string): string {
    return removeTaggedSections(text)
      .replace(/\\n|\r\n?|\n/gu, "。")
      .trim();
  }

  clearCache(): void {
    this.#wordLists.clear();
  }

  #loadWordList(
    configuredPath: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const filePath = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(this.#baseDirectory, configuredPath);
    let pending = this.#wordLists.get(filePath);

    if (pending === undefined) {
      pending = readFile(filePath, "utf8")
        .then((contents) => {
          const unique = new Set<string>();
          for (const line of contents.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
            const term = line.trim();
            if (term.length > 0) {
              unique.add(term);
            }
          }
          return [...unique];
        })
        .catch((error: unknown) => {
          if (this.#wordLists.get(filePath) === pending) {
            this.#wordLists.delete(filePath);
          }
          throw new Error(`Unable to read prohibited-terms file: ${filePath}`, {
            cause: error,
          });
        });
      this.#wordLists.set(filePath, pending);
    }

    return waitForWithSignal(pending, signal);
  }
}
