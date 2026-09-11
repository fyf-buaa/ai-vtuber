import {
  spawn as spawnChildProcess,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import process from "node:process";

import { withDeadline, type ActionClock } from "./async.js";
import { ActionExecutionError } from "./errors.js";

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_TERMINATE_GRACE_MS = 2_000;

export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly stdin?: string;
  readonly detached?: boolean;
  readonly captureOutput?: boolean;
  readonly maxOutputBytes?: number;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnedProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessExit>;
  terminate(force?: boolean): Promise<void>;
}

export interface ProcessSpawner {
  spawn(request: ProcessRequest): SpawnedProcess;
}

export interface RunProcessOptions {
  readonly operation: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly clock?: ActionClock;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentSize: number,
  limit: number,
): number {
  if (currentSize >= limit) {
    return currentSize;
  }

  const remaining = limit - currentSize;
  chunks.push(chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining));
  return currentSize + Math.min(chunk.byteLength, remaining);
}

type ChildSettlement =
  | {
      readonly type: "error";
      readonly error: Error;
    }
  | {
      readonly type: "exit" | "close";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

interface ChildSettlementObserver {
  readonly promise: Promise<ChildSettlement>;
  isSettled(): boolean;
}

function observeChildSettlement(
  child: ChildProcess,
): ChildSettlementObserver {
  const exitCode = child.exitCode;
  const signalCode = child.signalCode;
  if (exitCode !== null || signalCode !== null) {
    return {
      promise: Promise.resolve({
        type: "exit",
        code: exitCode,
        signal: signalCode,
      }),
      isSettled: () => true,
    };
  }

  const deferred = Promise.withResolvers<ChildSettlement>();
  let settled = false;

  const cleanup = (): void => {
    child.off("error", onError);
    child.off("exit", onExit);
    child.off("close", onClose);
  };
  const settle = (result: ChildSettlement): void => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    deferred.resolve(result);
  };
  const onError = (error: Error): void => {
    settle({ type: "error", error });
  };
  const onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    settle({ type: "exit", code, signal });
  };
  const onClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    settle({ type: "close", code, signal });
  };

  child.on("error", onError);
  child.on("exit", onExit);
  child.on("close", onClose);

  return {
    promise: deferred.promise,
    isSettled: () => settled,
  };
}

async function killWindowsTree(pid: number, force: boolean): Promise<void> {
  const args = ["/PID", String(pid), "/T"];
  if (force) {
    args.push("/F");
  }

  const killer = spawnChildProcess("taskkill.exe", args, {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  await observeChildSettlement(killer).promise;
}

class NodeSpawnedProcess implements SpawnedProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessExit>;

  readonly #child: ChildProcess;
  readonly #detached: boolean;
  #termination: Promise<void> | undefined;
  readonly #settlement: ChildSettlementObserver;

  constructor(child: ChildProcess, request: ProcessRequest) {
    this.#child = child;
    this.#detached = request.detached === true;
    this.pid = child.pid;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const outputLimit = request.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;
    let stdoutSize = 0;
    let stderrSize = 0;

    const onStdoutData = (value: Buffer | string): void => {
      stdoutSize = appendBounded(
        stdoutChunks,
        Buffer.isBuffer(value) ? value : Buffer.from(value),
        stdoutSize,
        outputLimit,
      );
    };
    const onStderrData = (value: Buffer | string): void => {
      stderrSize = appendBounded(
        stderrChunks,
        Buffer.isBuffer(value) ? value : Buffer.from(value),
        stderrSize,
        outputLimit,
      );
    };
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);

    this.#settlement = observeChildSettlement(child);
    this.exited = this.#settlement.promise.then((settlement) => {
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);

      if (settlement.type === "error") {
        throw new ActionExecutionError(
          `Failed to start executable '${request.executable}'`,
          { executable: request.executable },
          { cause: settlement.error },
        );
      }

      return {
        code: settlement.code,
        signal: settlement.signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      };
    });
  }

  terminate(force = false): Promise<void> {
    if (this.#termination !== undefined) {
      return this.#termination;
    }

    this.#termination = this.#terminate(force);
    return this.#termination;
  }

  async #terminate(force: boolean): Promise<void> {
    if (this.#settlement.isSettled()) {
      return;
    }

    const pid = this.#child.pid;
    if (pid === undefined) {
      await this.#settlement.promise;
      return;
    }

    if (process.platform === "win32") {
      await killWindowsTree(pid, force);
    } else if (this.#detached) {
      try {
        process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    } else {
      this.#child.kill(force ? "SIGKILL" : "SIGTERM");
    }

    if (force) {
      await this.#settlement.promise;
      return;
    }

    let graceTimer: NodeJS.Timeout | undefined;
    const graceElapsed = new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, DEFAULT_TERMINATE_GRACE_MS);
      graceTimer.unref();
    });
    try {
      await Promise.race([this.#settlement.promise, graceElapsed]);
    } finally {
      clearTimeout(graceTimer);
    }

    if (this.#settlement.isSettled()) {
      return;
    }

    if (process.platform === "win32") {
      await killWindowsTree(pid, true);
    } else if (this.#detached) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    } else {
      this.#child.kill("SIGKILL");
    }
    await this.#settlement.promise;
  }
}

export class NodeProcessSpawner implements ProcessSpawner {
  spawn(request: ProcessRequest): SpawnedProcess {
    if (!Number.isInteger(request.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT) ||
        (request.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT) <= 0) {
      throw new RangeError("maxOutputBytes must be a positive integer");
    }

    const captureOutput = request.captureOutput !== false;
    const stdio: SpawnOptions["stdio"] = [
      request.stdin === undefined ? "ignore" : "pipe",
      captureOutput ? "pipe" : "ignore",
      captureOutput ? "pipe" : "ignore",
    ];
    const options: SpawnOptions = {
      shell: false,
      windowsHide: true,
      detached: request.detached === true,
      stdio,
    };
    if (request.cwd !== undefined) {
      options.cwd = request.cwd;
    }

    const child = spawnChildProcess(request.executable, [...request.args], options);
    if (request.stdin !== undefined) {
      child.stdin?.end(request.stdin, "utf8");
    }
    return new NodeSpawnedProcess(child, request);
  }
}

export async function runProcess(
  spawner: ProcessSpawner,
  request: ProcessRequest,
  options: RunProcessOptions,
): Promise<ProcessExit> {
  let child: SpawnedProcess | undefined;
  try {
    const result = await withDeadline(
      async () => {
        child = spawner.spawn(request);
        return child.exited;
      },
      options,
    );

    if (result.code !== 0) {
      throw new ActionExecutionError(
        `${options.operation} exited with code ${String(result.code)}`,
        {
          executable: request.executable,
          code: result.code,
          signal: result.signal,
          stderr: result.stderr,
        },
      );
    }
    return result;
  } catch (error) {
    if (child !== undefined) {
      await child.terminate(true).catch(() => undefined);
    }
    throw error;
  }
}
