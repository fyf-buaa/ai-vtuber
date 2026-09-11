import {
  spawn as spawnChildProcess,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { isIP } from "node:net";
import process from "node:process";

import type { JsonObject } from "../config/config-store.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8_081;

export type OperatorWebUiSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface OpenOperatorWebUiOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly spawn?: OperatorWebUiSpawn | undefined;
}

/** Opens the configured operator WebUI after its HTTP server is ready. */
export async function openOperatorWebUi(
  config: JsonObject,
  options: OpenOperatorWebUiOptions = {},
): Promise<string> {
  const webui = objectValue(config["webui"]);
  const hostname = normalizeHostname(
    webui?.["ip"] ?? config["api_ip"] ?? DEFAULT_HOST,
  );
  const port = normalizePort(
    webui?.["port"] ?? config["api_port"] ?? DEFAULT_PORT,
  );
  const url = `http://${hostname}:${port}/`;
  const platform = options.platform ?? process.platform;
  const command = platform === "win32"
    ? "explorer.exe"
    : platform === "darwin"
    ? "open"
    : "xdg-open";
  const spawn = options.spawn ?? defaultSpawn;
  const child = spawn(command, [url], {
    detached: true,
    shell: false,
    stdio: "ignore",
  });

  await childSpawned(child);
  return url;
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawnChildProcess(command, args, options);
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function normalizeHostname(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("Operator WebUI host must be a non-empty string");
  }

  let host = value.trim();
  if (host.startsWith("[") || host.endsWith("]")) {
    if (!host.startsWith("[") || !host.endsWith("]")) {
      throw invalidHost();
    }
    host = host.slice(1, -1);
  }
  if (host === "0.0.0.0") {
    host = "127.0.0.1";
  } else if (host === "::") {
    host = "::1";
  }

  const ipVersion = isIP(host);
  if (
    host === "" ||
    /[\u0000-\u0020\u007f/\\?#@\[\]]/u.test(host) ||
    (host.includes(":") && ipVersion !== 6)
  ) {
    throw invalidHost();
  }

  const authority = ipVersion === 6 ? `[${host}]` : host;
  let parsed: URL;
  try {
    parsed = new URL(`http://${authority}/`);
  } catch {
    throw invalidHost();
  }
  if (
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw invalidHost();
  }
  return parsed.hostname;
}

function invalidHost(): TypeError {
  return new TypeError("Operator WebUI host must be a valid hostname or IP address");
}

function normalizePort(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 65_535
  ) {
    throw new TypeError("Operator WebUI port must be an integer from 1 through 65535");
  }
  return value;
}

function childSpawned(child: ChildProcess): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;

  function onError(error: Error): void {
    if (settled) return;
    settled = true;
    child.off("spawn", onSpawn);
    reject(error);
  }

  function onSpawn(): void {
    if (settled) return;
    settled = true;
    try {
      child.unref();
    } catch (error) {
      reject(error);
      return;
    }
    resolve();
  }

  child.once("error", onError);
  child.once("spawn", onSpawn);
  return promise;
}
