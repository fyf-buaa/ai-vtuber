import { isAbsolute, resolve, win32 } from "node:path";
import process from "node:process";

import type { ActionClock } from "./async.js";
import {
  ActionAuthorizationError,
  ActionConfigurationError,
  ActionNotFoundError,
} from "./errors.js";
import {
  runProcess,
  type ProcessExit,
  type ProcessSpawner,
} from "./process.js";

const DEFAULT_EXECUTABLE_TIMEOUT_MS = 10_000;

export interface ExecutableActionDefinition {
  readonly id: string;
  readonly enabled?: boolean;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly allowAgent?: boolean;
  readonly description?: string;
}

export interface ExecutableActionRegistryOptions {
  readonly actions: readonly ExecutableActionDefinition[];
  readonly allowedExecutables: readonly string[];
  readonly allowedWorkingDirectories?: readonly string[];
  readonly spawner: ProcessSpawner;
  readonly clock?: ActionClock;
}

export interface ExecutableActionResult {
  readonly actionId: string;
  readonly exit: ProcessExit;
}

function isAbsoluteOnSupportedPlatform(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class ExecutableActionRegistry {
  readonly #actions: readonly ExecutableActionDefinition[];
  readonly #allowedExecutables: ReadonlySet<string>;
  readonly #allowedWorkingDirectories: ReadonlySet<string>;
  readonly #spawner: ProcessSpawner;
  readonly #clock: ActionClock | undefined;

  constructor(options: ExecutableActionRegistryOptions) {
    this.#actions = options.actions;
    this.#allowedExecutables = new Set(
      options.allowedExecutables.map(comparablePath),
    );
    this.#allowedWorkingDirectories = new Set(
      (options.allowedWorkingDirectories ?? []).map(comparablePath),
    );
    this.#spawner = options.spawner;
    this.#clock = options.clock;
  }

  configuredAgentActions(): readonly ExecutableActionDefinition[] {
    return this.#actions.filter(
      (action) => action.enabled !== false && action.allowAgent === true,
    );
  }

  async invoke(
    actionId: string,
    source: "agent" | "event" | "runtime",
    payload: Readonly<Record<string, unknown>> = {},
    signal?: AbortSignal,
  ): Promise<ExecutableActionResult> {
    const action = this.#actions.find(
      (candidate) => candidate.id === actionId && candidate.enabled !== false,
    );
    if (action === undefined) {
      throw new ActionNotFoundError(actionId);
    }
    if (source === "agent" && action.allowAgent !== true) {
      throw new ActionAuthorizationError(
        `Executable action '${actionId}' is not authorized for agent use`,
        { actionId },
      );
    }
    if (!isAbsoluteOnSupportedPlatform(action.executable)) {
      throw new ActionConfigurationError(
        `Executable action '${actionId}' must use an absolute executable path`,
        { actionId, executable: action.executable },
      );
    }

    const executable = comparablePath(action.executable);
    if (!this.#allowedExecutables.has(executable)) {
      throw new ActionAuthorizationError(
        `Executable action '${actionId}' is not allowlisted`,
        { actionId, executable: action.executable },
      );
    }
    if (
      action.cwd !== undefined &&
      !this.#allowedWorkingDirectories.has(comparablePath(action.cwd))
    ) {
      throw new ActionAuthorizationError(
        `Working directory for executable action '${actionId}' is not allowlisted`,
        { actionId, cwd: action.cwd },
      );
    }

    const request = {
      executable: action.executable,
      args: action.args ?? [],
      stdin: `${JSON.stringify({
        version: 1,
        actionId,
        source,
        payload,
      })}\n`,
      ...(action.cwd === undefined ? {} : { cwd: action.cwd }),
    };
    const exit = await runProcess(this.#spawner, request, {
      operation: `executable action '${actionId}'`,
      timeoutMs: action.timeoutMs ?? DEFAULT_EXECUTABLE_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
      ...(this.#clock === undefined ? {} : { clock: this.#clock }),
    });
    return { actionId, exit };
  }
}
