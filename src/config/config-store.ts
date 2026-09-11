import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type ConfigPathSegment = string | number;
export type ConfigPath = readonly ConfigPathSegment[];

function displayPath(path: readonly (string | number)[]): string {
  if (path.length === 0) {
    return "$";
  }

  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number") {
      return `${result}[${segment}]`;
    }

    return /^[A-Za-z_$][\w$]*$/u.test(segment)
      ? `${result}.${segment}`
      : `${result}[${JSON.stringify(segment)}]`;
  }, "$");
}

function assertJsonValue(
  value: unknown,
  path: readonly (string | number)[],
  ancestors: Set<object>,
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${displayPath(path)} must contain a finite number`);
    }
    return;
  }

  if (typeof value !== "object") {
    throw new TypeError(`${displayPath(path)} is not JSON-serializable`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`${displayPath(path)} contains a circular reference`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError(`${displayPath([...path, index])} is an array hole`);
        }
        assertJsonValue(value[index], [...path, index], ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${displayPath(path)} must be a plain JSON object`);
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${displayPath(path)} contains a symbol key`);
    }

    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, [...path, key], ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}


function parseConfig(source: string, filePath: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.replace(/^\uFEFF/u, "")) as unknown;
  } catch (error) {
    throw new SyntaxError(`Invalid JSON in config file ${filePath}`, {
      cause: error,
    });
  }

  assertJsonValue(parsed, [], new Set<object>());
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError(`Config file ${filePath} must contain a JSON object`);
  }

  return parsed;
}

async function readConfig(filePath: string): Promise<JsonObject> {
  const source = await readFile(filePath, "utf8");
  return parseConfig(source, filePath);
}

async function initializeConfig(filePath: string, config: JsonObject): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // Publish a complete file without replacing another process's configuration.
      await link(temporaryPath, filePath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
export class ConfigGenerationConflictError extends Error {
  readonly expectedGeneration: number;
  readonly currentGeneration: number;

  constructor(expectedGeneration: number, currentGeneration: number) {
    super(
      `Configuration generation ${String(expectedGeneration)} is stale; current generation is ${String(currentGeneration)}`,
    );
    this.name = "ConfigGenerationConflictError";
    this.expectedGeneration = expectedGeneration;
    this.currentGeneration = currentGeneration;
  }
}



export class ConfigStore {
  readonly path: string;

  #data: JsonObject;
  #operationTail: Promise<void> = Promise.resolve();
  #generation = 0;

  private constructor(filePath: string, data: JsonObject) {
    this.path = filePath;
    this.#data = data;
  }

  static async load(filePath: string | URL): Promise<ConfigStore> {
    const normalizedPath = resolve(
      typeof filePath === "string" ? filePath : fileURLToPath(filePath),
    );
    const data = await readConfig(normalizedPath);
    return new ConfigStore(normalizedPath, data);
  }

  static async loadDefault(directory: string): Promise<ConfigStore> {
    const localPath = resolve(directory, "config.local.json");
    try {
      return await ConfigStore.load(localPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    const templatePath = resolve(directory, "config.example.json");
    const [config, backup] = await Promise.all([
      readConfig(templatePath),
      readConfig(`${templatePath}.bak`),
    ]);
    await initializeConfig(`${localPath}.bak`, backup);
    await initializeConfig(localPath, config);
    return ConfigStore.load(localPath);
  }
  get generation(): number {
    return this.#generation;
  }


  get<T>(...path: ConfigPathSegment[]): T | undefined {
    let current: unknown = this.#data;

    for (const segment of path) {
      if (
        current === null ||
        typeof current !== "object" ||
        !Object.prototype.hasOwnProperty.call(current, segment)
      ) {
        return undefined;
      }

      current = (current as Record<string | number, unknown>)[segment];
    }

    return structuredClone(current) as T;
  }

  getOr<T>(path: ConfigPath, fallback: T): T {
    const value = this.get<T>(...path);
    return value === undefined ? fallback : value;
  }

  snapshot(): JsonObject {
    return structuredClone(this.#data);
  }

  restoreSnapshot(snapshot: JsonObject, expectedGeneration?: number): void {
    assertJsonValue(snapshot, [], new Set<object>());
    this.#assertExpectedGeneration(expectedGeneration);
    this.#assertCanAdvanceGeneration();
    this.#data = structuredClone(snapshot);
    this.#generation += 1;
  }

  save(next: JsonObject, expectedGeneration?: number): Promise<void> {
    assertJsonValue(next, [], new Set<object>());
    const snapshot = structuredClone(next);

    return this.#enqueue(async () => {
      this.#assertExpectedGeneration(expectedGeneration);
      this.#assertCanAdvanceGeneration();
      const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
      const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      let temporaryCreated = false;

      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        temporaryCreated = true;
        try {
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }

        await rename(temporaryPath, this.path);
        temporaryCreated = false;
        this.#data = snapshot;
        this.#generation += 1;
      } finally {
        if (temporaryCreated) {
          await rm(temporaryPath, { force: true });
        }
      }
    });
  }

  reload(expectedGeneration?: number): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertExpectedGeneration(expectedGeneration);
      this.#assertCanAdvanceGeneration();
      this.#data = await readConfig(this.path);
      this.#generation += 1;
    });
  }

  #assertExpectedGeneration(expectedGeneration: number | undefined): void {
    if (expectedGeneration === undefined) {
      return;
    }
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new TypeError("Expected configuration generation must be a non-negative safe integer");
    }
    if (expectedGeneration !== this.#generation) {
      throw new ConfigGenerationConflictError(
        expectedGeneration,
        this.#generation,
      );
    }
  }

  #assertCanAdvanceGeneration(): void {
    if (this.#generation === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Configuration generation limit reached");
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
