import { resolve } from "node:path";

import type { ConfigStore } from "../config/config-store.js";
import type { EventPublisher } from "../domain/types.js";
import {
  createSpeechSynthesizer,
  resolveSpeechRuntimeSettings,
} from "./config.js";
import { QueuedSpeechService } from "./speech-service.js";
import {
  ExternalAudioSink,
  NoopAudioSink,
} from "./sinks/external-player.js";
import type {
  AudioPostProcessor,
  AudioSink,
  SpeechFetch,
  SpeechSynthesizer,
} from "./types.js";

export interface CreateSpeechServiceOptions {
  readonly config: Pick<ConfigStore, "snapshot">;
  readonly publisher: EventPublisher;
  readonly cwd?: string;
  readonly fetch?: SpeechFetch;
  readonly sink?: AudioSink;
  readonly synthesizer?: SpeechSynthesizer;
  readonly postProcessors?: readonly AudioPostProcessor[];
  readonly idFactory?: () => string;
  readonly clock?: () => number;
}

export function createSpeechService(
  options: CreateSpeechServiceOptions,
): QueuedSpeechService {
  const cwd = options.cwd ?? process.cwd();
  const snapshot = options.config.snapshot();
  const settings = resolveSpeechRuntimeSettings(snapshot, cwd);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const synthesizer =
    options.synthesizer ?? createSpeechSynthesizer(snapshot, cwd, fetchImpl);
  const sink =
    options.sink ??
    (settings.playbackEnabled
      ? new ExternalAudioSink(settings.player)
      : new NoopAudioSink());

  return new QueuedSpeechService({
    synthesizer,
    sink,
    publisher: options.publisher,
    queueCapacity: settings.queueCapacity,
    admissionWaiterCapacity: settings.admissionWaiterCapacity,
    queueStartThreshold: settings.queueStartThreshold,
    priorityMapping: settings.priorityMapping,
    requestTimeoutMs: settings.requestTimeoutMs,
    maxAudioBytes: settings.maxAudioBytes,
    localAudioRoot: resolve(cwd),
    textSplit: settings.textSplit,
    outputDirectory: settings.outputDirectory,
    temporaryDirectory: settings.temporaryDirectory,
    preserveOutput: settings.preserveOutput,
    ...(options.postProcessors === undefined
      ? {}
      : { postProcessors: options.postProcessors }),
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

export { AzureSpeechSynthesizer } from "./adapters/azure.js";
export { DisabledSpeechSynthesizer } from "./adapters/disabled.js";
export {
  EdgeSpeechSynthesizer,
  listEdgeVoices,
  type EdgeVoice,
  type EdgeVoiceListOptions,
} from "./adapters/edge.js";
export {
  GradioQueueClient,
  LegacyGradioSpeechSynthesizer,
  type GradioPredictionRequest,
  type GradioQueueClientOptions,
  type GradioSocket,
  type GradioTransport,
  type GradioWebSocketFactory,
  type LegacyGradioSpeechConfig,
} from "./adapters/gradio.js";
export { LegacyHttpSpeechSynthesizer } from "./adapters/legacy-http.js";
export {
  LegacyRestSpeechSynthesizer,
  type LegacyRestSpeechConfig,
} from "./adapters/legacy-rest.js";
export { OpenAiSpeechSynthesizer } from "./adapters/openai.js";
export {
  createSpeechSynthesizer,
  resolveSpeechRuntimeSettings,
  type ExternalPlayerSettings,
  type SpeechRuntimeSettings,
} from "./config.js";
export {
  SpeechCancelledError,
  SpeechCapacityError,
  SpeechConfigurationError,
  SpeechServiceStoppedError,
  SpeechTimeoutError,
} from "./errors.js";
export { QueuedSpeechService, type QueuedSpeechServiceOptions } from "./speech-service.js";
export type { LocalAudioRequest } from "../domain/types.js";
export {
  ExternalAudioSink,
  NoopAudioSink,
  type ExternalAudioSinkOptions,
} from "./sinks/external-player.js";
export type {
  AudioArtifact,
  AudioPostProcessor,
  AudioSink,
  SpeechAudioContext,
  SpeechFetch,
  SpeechSynthesizer,
  SpeechPriorityMapping,
  SpeechTextSplitOptions,
  SynthesizedAudio,
} from "./types.js";
