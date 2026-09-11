import { resolve } from "node:path";
import type { AudioPostProcessor } from "../speech/types.js";
import type { EventPublisher } from "../domain/types.js";
import {
  createVirtualMicrophoneAudioSinkFromConfig,
  type VirtualMicrophoneAudioSink,
} from "./audio-sink.js";
import type {
  CaptionBridge,
  CaptionBridgeDependencies,
} from "./captions.js";
import { createCaptionBridgesFromConfig } from "./captions.js";
import type {
  OutputBridgeDependencies,
  SelectedVisualBodyBridge,
} from "./bridges.js";
import { CoordinationCallbackBridge, createVisualBodyBridgeFromConfig } from "./bridges.js";
import type { OutputClock } from "./errors.js";
import { Live2dStaticServer } from "./live2d-server.js";
import { ObsVirtualCamera } from "./obs-camera.js";
import {
  createSvcPostProcessorsFromConfig,
  type SvcPostProcessorDependencies,
} from "./post-processors.js";
import type { OutputFileSystem } from "./files.js";
import type { OutputFetch } from "./http.js";

export interface LegacyConfigRecord {
  readonly [key: string]: unknown;
}

export interface OutputAdapterFactoryDependencies {
  readonly projectRoot?: string | undefined;
  readonly fetch?: OutputFetch | undefined;
  readonly fileSystem?: OutputFileSystem | undefined;
  readonly publisher?: EventPublisher | undefined;
  readonly clock?: OutputClock | undefined;
  readonly makeId?: (() => string) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBodyBytes?: number | undefined;
}

export interface LegacyOutputAdapters {
  readonly visualBody: SelectedVisualBodyBridge | undefined;
  readonly virtualMicrophone: VirtualMicrophoneAudioSink | undefined;
  readonly svcPostProcessors: readonly AudioPostProcessor[];
  readonly renderedCaptions: CaptionBridge;
  readonly rawCaptions: CaptionBridge;
  readonly coordinationCallback: CoordinationCallbackBridge;
  readonly live2dServer: Live2dStaticServer;
  readonly avatarCamera: ObsVirtualCamera;
}

export function configRecordAt(
  config: LegacyConfigRecord,
  key: string,
): LegacyConfigRecord {
  const value = config[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as LegacyConfigRecord
    : {};
}

export function configString(
  config: LegacyConfigRecord,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" ? value : undefined;
}

export function configNumber(
  config: LegacyConfigRecord,
  key: string,
): number | undefined {
  const value = config[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}


function bridgeDependencies(
  dependencies: OutputAdapterFactoryDependencies,
): OutputBridgeDependencies {
  return {
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.publisher === undefined ? {} : { publisher: dependencies.publisher }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
    ...(dependencies.maxBodyBytes === undefined ? {} : { maxBodyBytes: dependencies.maxBodyBytes }),
  };
}

function captionDependencies(
  dependencies: OutputAdapterFactoryDependencies,
): CaptionBridgeDependencies {
  return {
    ...(dependencies.fileSystem === undefined ? {} : { fileSystem: dependencies.fileSystem }),
    ...(dependencies.publisher === undefined ? {} : { publisher: dependencies.publisher }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(dependencies.makeId === undefined ? {} : { makeId: dependencies.makeId }),
  };
}

function svcDependencies(
  dependencies: OutputAdapterFactoryDependencies,
  projectRoot: string,
): SvcPostProcessorDependencies {
  return {
    projectRoot,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.fileSystem === undefined ? {} : { fileSystem: dependencies.fileSystem }),
    ...(dependencies.publisher === undefined ? {} : { publisher: dependencies.publisher }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(dependencies.makeId === undefined ? {} : { makeId: dependencies.makeId }),
    ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
    ...(dependencies.maxBodyBytes === undefined ? {} : { maxBodyBytes: dependencies.maxBodyBytes }),
  };
}

export function createLegacyOutputAdapters(
  config: LegacyConfigRecord,
  dependencies: OutputAdapterFactoryDependencies = {},
): LegacyOutputAdapters {
  const projectRoot = resolve(dependencies.projectRoot ?? ".");
  const httpDependencies = bridgeDependencies(dependencies);
  const visualBody = createVisualBodyBridgeFromConfig(
    config,
    httpDependencies,
  );
  const virtualMicrophone = createVirtualMicrophoneAudioSinkFromConfig(config);
  const svcPostProcessors = createSvcPostProcessorsFromConfig(
    config,
    svcDependencies(dependencies, projectRoot),
  );
  const captions = createCaptionBridgesFromConfig(config, {
    ...captionDependencies(dependencies),
    rootDirectory: projectRoot,
  });

  const coordination = configRecordAt(config, "coordination_callback");
  const coordinationCallback = new CoordinationCallbackBridge({
    enabled: coordination["enable"] === true,
    apiBaseUrl: configString(coordination, "api_ip_port"),
    endpointPath: configString(coordination, "endpoint_path"),
  }, httpDependencies);

  const live2d = configRecordAt(config, "live2d");
  const live2dServer = new Live2dStaticServer({
    enabled: live2d["enable"] === true,
    rootDirectory: resolve(projectRoot, "Live2D"),
    host: configString(live2d, "host"),
    port: configNumber(live2d, "port"),
    modelName: configString(live2d, "name") ?? "Hiyori",
  }, {
    ...(dependencies.publisher === undefined ? {} : { publisher: dependencies.publisher }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const avatarCameraConfig = configRecordAt(live2d, "camera");
  const avatarCamera = new ObsVirtualCamera({
    url: configString(avatarCameraConfig, "obs_websocket_url") ?? "ws://127.0.0.1:4455",
    password: configString(avatarCameraConfig, "password") ?? "",
    width: configNumber(avatarCameraConfig, "width") ?? 1280,
    height: configNumber(avatarCameraConfig, "height") ?? 720,
    fps: configNumber(avatarCameraConfig, "fps") ?? 30,
  });
  return {
    visualBody,
    virtualMicrophone,
    svcPostProcessors,
    renderedCaptions: captions.rendered,
    rawCaptions: captions.raw,
    coordinationCallback,
    live2dServer,
    avatarCamera,
  };
}
