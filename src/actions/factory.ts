import type { JsonObject } from "../config/config-store.js";
import type { ActionClock } from "./async.js";
import {
  normalizeActionConfig,
  type NormalizedActionConfig,
} from "./config.js";
import { ExecutableActionRegistry } from "./executable-actions.js";
import {
  NodeProcessSpawner,
  type ProcessSpawner,
} from "./process.js";
import { ActionRuntime } from "./runtime.js";

export interface ActionServiceDependencies {
  readonly spawner?: ProcessSpawner;
  readonly clock?: ActionClock;
}

export interface ActionServiceBundle {
  readonly config: NormalizedActionConfig;
  readonly runtime: ActionRuntime;
  readonly executables: ExecutableActionRegistry;
}

export function createActionServices(
  rawConfig: JsonObject,
  dependencies: ActionServiceDependencies = {},
): ActionServiceBundle {
  const config = normalizeActionConfig(rawConfig);
  const spawner = dependencies.spawner ?? new NodeProcessSpawner();
  const executables = new ExecutableActionRegistry({
    actions: config.executableActions,
    allowedExecutables: config.executableAllowlist,
    allowedWorkingDirectories: config.workingDirectoryAllowlist,
    spawner,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const runtime = new ActionRuntime({ executables });

  return {
    config,
    runtime,
    executables,
  };
}
