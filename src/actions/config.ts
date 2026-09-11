import type { JsonObject } from "../config/config-store.js";
import { ActionConfigurationError } from "./errors.js";
import type { ExecutableActionDefinition } from "./executable-actions.js";
import { isUnknownRecord } from "./validation.js";

export interface NormalizedActionConfig {
  readonly executableActions: readonly ExecutableActionDefinition[];
  readonly executableAllowlist: readonly string[];
  readonly workingDirectoryAllowlist: readonly string[];
}

function recordAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const child = value[key];
  return isUnknownRecord(child) ? child : {};
}

function arrayAt(value: Record<string, unknown>, key: string): readonly unknown[] {
  const child = value[key];
  return Array.isArray(child) ? child : [];
}

function stringAt(
  value: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const child = value[key];
  return typeof child === "string" ? child : fallback;
}

function booleanAt(
  value: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const child = value[key];
  return typeof child === "boolean" ? child : fallback;
}

function numberAt(
  value: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const child = value[key];
  if (typeof child === "number") return child;
  if (typeof child === "string" && child.trim().length > 0) {
    const parsed = Number(child);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function actionSection(root: Record<string, unknown>): Record<string, unknown> {
  return recordAt(root, "actions");
}

function normalizeExecutables(
  root: Record<string, unknown>,
): readonly ExecutableActionDefinition[] {
  const actions = actionSection(root);
  const rawActions =
    arrayAt(root, "executable_actions").length > 0
      ? arrayAt(root, "executable_actions")
      : arrayAt(actions, "executables");
  const normalized = rawActions.map((raw, index) => {
    if (!isUnknownRecord(raw)) {
      throw new ActionConfigurationError(
        `executable_actions[${index}] must be an object`,
      );
    }
    const definition: ExecutableActionDefinition = {
      id: stringAt(raw, "id", `executable-action-${index + 1}`),
      enabled: booleanAt(raw, "enable", true),
      executable: stringAt(raw, "executable"),
      args: stringArray(raw.args ?? raw.parameters),
      allowAgent: booleanAt(raw, "allow_agent"),
    };
    const cwd = stringAt(raw, "cwd");
    const description = stringAt(raw, "description");
    const timeoutMs = numberAt(raw, "timeout_ms", 0);
    return {
      ...definition,
      ...(cwd.length === 0 ? {} : { cwd }),
      ...(description.length === 0 ? {} : { description }),
      ...(timeoutMs <= 0 ? {} : { timeoutMs }),
    };
  });

  const enabledIds = new Set<string>();
  for (const action of normalized) {
    if (action.enabled === false) {
      continue;
    }
    if (enabledIds.has(action.id)) {
      throw new ActionConfigurationError(
        `Executable action id '${action.id}' is duplicated`,
        { actionId: action.id },
      );
    }
    enabledIds.add(action.id);
  }
  return normalized;
}

function readAllowlist(
  root: Record<string, unknown>,
  legacyName: string,
  nestedName: string,
): readonly string[] {
  const legacy = stringArray(root[legacyName]);
  return legacy.length > 0
    ? legacy
    : stringArray(actionSection(root)[nestedName]);
}

export function normalizeActionConfig(config: JsonObject): NormalizedActionConfig {
  const root = config as Record<string, unknown>;
  const executableActions = normalizeExecutables(root);
  const executableAllowlist = readAllowlist(
    root,
    "action_executable_allowlist",
    "executableAllowlist",
  );
  const workingDirectoryAllowlist = readAllowlist(
    root,
    "action_working_directory_allowlist",
    "workingDirectoryAllowlist",
  );

  return {
    executableActions,
    executableAllowlist,
    workingDirectoryAllowlist,
  };
}

