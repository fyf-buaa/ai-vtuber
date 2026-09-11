import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { PiAgentError } from "./errors.js";
import {
  PiAgentExecutor,
  type PiAgentExecutorOptions,
} from "./pi-agent-executor.js";
import {
  imagePiAgentConfigInput,
  resolveImagePiAgentConfig,
  resolvePiAgentConfig,
  type ResolvedPiAgentConfig,
} from "./provider-resolution.js";


/** Configuration for the main Agent and its optional visual fallback. */
export interface ImageAgentConfig {
  readonly agent?: unknown;
  readonly image_recognition?: unknown;
}

/** Canonical Pi configuration selected for fallback image transcription. */
export type ResolvedImageAgentConfig = ResolvedPiAgentConfig;

/** Reports whether the effective primary Agent model can consume images directly. */
export function primaryAgentSupportsImage(
  config: unknown,
  options: Pick<PiAgentExecutorOptions, "model" | "models"> = {},
): boolean {
  if (options.model !== undefined) {
    return options.model.input.includes("image");
  }
  let resolved: ResolvedPiAgentConfig;
  try {
    resolved = resolvePiAgentConfig(config);
  } catch {
    return false;
  }
  const suppliedProvider = options.models?.getProvider(resolved.provider);
  const selected = suppliedProvider === undefined
    ? (
        resolved.openAICompatible
          ? undefined
          : builtinModels().getModel(resolved.provider, resolved.model)
      )
    : options.models?.getModel(resolved.provider, resolved.model);
  const supportsImage = (selected?.input ?? resolved.input).includes("image");
  const configuredInput = resolved.modelOverrides.input;
  return supportsImage &&
    (configuredInput === undefined || configuredInput.includes("image"));
}

/**
 * Resolves the dedicated Pi visual model when image transcription is enabled.
 * The main model is intentionally not inspected by this low-level resolver.
 */
export function resolveImageAgentConfig(
  config: unknown,
  models?: Models,
): ResolvedImageAgentConfig | undefined {
  const resolved = resolveImagePiAgentConfig(config);
  if (resolved === undefined) return undefined;

  const suppliedProvider = models?.getProvider(resolved.provider);
  const selected = suppliedProvider === undefined
    ? (
        resolved.openAICompatible
          ? undefined
          : builtinModels().getModel(resolved.provider, resolved.model)
      )
    : models?.getModel(resolved.provider, resolved.model);
  if (selected === undefined && !resolved.openAICompatible) {
    throw new PiAgentError(
      "configuration",
      `Unknown model "${resolved.model}" for Pi provider "${resolved.provider}"`,
    );
  }
  assertVisionInput(
    selected?.input ?? resolved.input,
    resolved.provider,
    resolved.model,
  );
  return resolved;
}

/**
 * Creates an isolated Pi visual executor only when the primary model cannot
 * consume images. Agent tools and the primary preselected model are not reused.
 */
export function createImageAgentExecutor(
  config: unknown,
  options: PiAgentExecutorOptions = {},
): PiAgentExecutor | undefined {
  const dedicatedInput = imagePiAgentConfigInput(config);
  if (dedicatedInput === undefined) return undefined;
  if (primaryAgentSupportsImage(config, options)) return undefined;

  const resolved = resolveImageAgentConfig(config, options.models);
  if (resolved === undefined) return undefined;
  const dedicatedModels = options.models?.getProvider(resolved.provider) === undefined
    ? undefined
    : options.models;
  const dedicatedModel = dedicatedModels?.getModel(
    resolved.provider,
    resolved.model,
  );
  const {
    model: _primaryModel,
    models: _sharedModels,
    tools: _tools,
    toolsForSession: _toolsForSession,
    ...sharedOptions
  } = options;
  return new PiAgentExecutor(dedicatedInput, {
    ...sharedOptions,
    ...(dedicatedModels === undefined ? {} : { models: dedicatedModels }),
    ...(dedicatedModel === undefined ? {} : { model: dedicatedModel }),
  });
}

function assertVisionInput(
  input: readonly string[],
  provider: string,
  model: string,
): void {
  if (input.includes("image")) return;
  throw new PiAgentError(
    "configuration",
    `image_recognition requires the dedicated Pi model "${provider}/${model}" to support image input`,
  );
}

