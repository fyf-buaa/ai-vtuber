import type { AudioArtifact, SpeechAudioContext } from "../speech/types.js";
import type { EventPublisher, Metadata } from "../domain/types.js";
import {
  asOutputBridgeError,
  OutputConfigError,
  publishOutputFailure,
  redactSecrets,
  type OutputClock,
} from "./errors.js";
import { requireAbsoluteArtifactPath } from "./files.js";
import {
  appendEndpoint,
  parseHttpUrl,
  requestAcknowledgement,
  type OutputFetch,
  type OutputRequestOptions,
} from "./http.js";

export type OutputMessageKind =
  | "comment"
  | "entrance"
  | "follow"
  | "gift"
  | "idle_time_task"
  | "image"
  | "reply"
  | "reread"
  | "schedule"
  | "talk"
  | (string & Record<never, never>);

export interface OutputTextMessage {
  readonly kind: OutputMessageKind;
  readonly username: string;
  readonly content: string;
  readonly sourceEventId?: string | undefined;
  readonly metadata?: Metadata | undefined;
}

export interface AudioOutputBridge {
  readonly name: string;
  readonly enabled: boolean;
  sendAudio(
    artifact: AudioArtifact,
    context: SpeechAudioContext,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface TextOutputBridge {
  readonly name: string;
  readonly enabled: boolean;
  sendText(message: OutputTextMessage, signal?: AbortSignal): Promise<void>;
}

export interface OutputBridgeDependencies {
  readonly fetch?: OutputFetch | undefined;
  readonly publisher?: EventPublisher | undefined;
  readonly clock?: OutputClock | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBodyBytes?: number | undefined;
}

interface EndpointBridgeConfig {
  readonly enabled: boolean;
  readonly apiBaseUrl?: string | undefined;
}

function requestOptions(
  component: string,
  url: URL,
  dependencies: OutputBridgeDependencies,
  init: RequestInit,
  signal: AbortSignal | undefined,
): OutputRequestOptions {
  return {
    component,
    url,
    init,
    ...(signal === undefined ? {} : { signal }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.publisher === undefined ? {} : { publisher: dependencies.publisher }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
    ...(dependencies.maxBodyBytes === undefined ? {} : { maxBodyBytes: dependencies.maxBodyBytes }),
  };
}

async function bridgeOperation(
  component: string,
  dependencies: OutputBridgeDependencies,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    const error = asOutputBridgeError(component, cause, `${component} operation failed`);
    publishOutputFailure(dependencies.publisher, error, dependencies.clock);
    throw error;
  }
}

function requireApiBaseUrl(config: EndpointBridgeConfig, component: string): string {
  const value = config.apiBaseUrl?.trim();
  if (value === undefined || value.length === 0) {
    throw new OutputConfigError(component, `${component} is enabled but api_ip_port is missing`);
  }
  return value;
}

export interface EasyAiVtuberBridgeConfig extends EndpointBridgeConfig {}

export class EasyAiVtuberBridge implements AudioOutputBridge {
  readonly name = "EasyAIVtuber";
  readonly enabled: boolean;
  readonly #config: EasyAiVtuberBridgeConfig;
  readonly #dependencies: OutputBridgeDependencies;

  constructor(config: EasyAiVtuberBridgeConfig, dependencies: OutputBridgeDependencies = {}) {
    this.enabled = config.enabled;
    this.#config = config;
    this.#dependencies = dependencies;
  }

  async sendAudio(
    artifact: AudioArtifact,
    _context: SpeechAudioContext,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const component = "output.easy-ai-vtuber";
    await bridgeOperation(component, this.#dependencies, async () => {
      const speechPath = requireAbsoluteArtifactPath(artifact.path, component);
      const url = appendEndpoint(requireApiBaseUrl(this.#config, component), "alive", component);
      await requestAcknowledgement(requestOptions(
        component,
        url,
        this.#dependencies,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "speak", speech_path: speechPath }),
        },
        signal,
      ));
    });
  }
}

export interface CoordinationCallbackEnvelope {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly timestamp: number;
}

export interface CoordinationCallbackConfig extends EndpointBridgeConfig {
  readonly endpointPath?: string | undefined;
}

export class CoordinationCallbackBridge {
  readonly name = "coordination-callback";
  readonly enabled: boolean;
  readonly #config: CoordinationCallbackConfig;
  readonly #dependencies: OutputBridgeDependencies;

  constructor(config: CoordinationCallbackConfig, dependencies: OutputBridgeDependencies = {}) {
    this.enabled = config.enabled;
    this.#config = config;
    this.#dependencies = dependencies;
  }

  async send(envelope: CoordinationCallbackEnvelope, signal?: AbortSignal): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const component = "output.coordination-callback";
    await bridgeOperation(component, this.#dependencies, async () => {
      const endpointPath = this.#config.endpointPath ?? "callback";
      const url = appendEndpoint(requireApiBaseUrl(this.#config, component), endpointPath, component);
      await requestAcknowledgement(requestOptions(
        component,
        url,
        this.#dependencies,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(redactSecrets(envelope)),
        },
        signal,
      ));
    });
  }
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function recordAt(config: JsonRecord, key: string): JsonRecord {
  const value = config[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringAt(config: JsonRecord, key: string): string | undefined {
  return typeof config[key] === "string" ? config[key] : undefined;
}

export interface SelectedVisualBodyBridge {
  readonly mode: "audio";
  readonly bridge: AudioOutputBridge;
}

export function createVisualBodyBridgeFromConfig(
  config: JsonRecord,
  dependencies: OutputBridgeDependencies = {},
): SelectedVisualBodyBridge | undefined {
  const selected = stringAt(config, "visual_body") ?? "其他";
  switch (selected) {
    case "EasyAIVtuber": {
      const section = recordAt(config, "EasyAIVtuber");
      return {
        mode: "audio",
        bridge: new EasyAiVtuberBridge({
          enabled: true,
          apiBaseUrl: stringAt(section, "api_ip_port"),
        }, dependencies),
      };
    }
    case "其他":
    case "other":
    case "live2d":
    case "none":
    case "":
      return undefined;
    default:
      throw new OutputConfigError(
        "output.visual-body",
        `Unsupported visual_body value: ${selected}`,
      );
  }
}
