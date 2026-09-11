import type {
  AudioArtifact,
  AudioSink,
  SpeechAudioContext,
} from "../speech/types.js";
import {
  ExternalAudioSink,
  type ExternalAudioSinkOptions,
} from "../speech/sinks/external-player.js";
import { OutputConfigError } from "./errors.js";
import type { AudioOutputBridge } from "./bridges.js";

/** Routes speech exclusively to a selected external visual-body bridge. */
export class ExternalVisualAudioSink implements AudioSink {
  readonly #bridge: AudioOutputBridge;
  #active: Readonly<{
    controller: AbortController;
    settled: Promise<void>;
  }> | undefined;

  constructor(bridge: AudioOutputBridge) {
    this.#bridge = bridge;
  }

  async play(
    artifact: AudioArtifact,
    context: SpeechAudioContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.#bridge.enabled) {
      return;
    }
    if (this.#active !== undefined) {
      throw new Error(`${this.#bridge.name} already has an active output request`);
    }

    const controller = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const active = { controller, settled };
    this.#active = active;
    const combinedSignal = AbortSignal.any([signal, controller.signal]);
    try {
      await this.#bridge.sendAudio(artifact, context, combinedSignal);
    } finally {
      if (this.#active === active) {
        this.#active = undefined;
      }
      markSettled();
    }
  }

  async stop(): Promise<void> {
    const active = this.#active;
    if (active === undefined) {
      return;
    }
    active.controller.abort(new Error("external visual-body playback stopped"));
    await active.settled;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

type JsonRecord = Readonly<Record<string, unknown>>;

const VIRTUAL_MICROPHONE_COMPONENT = "output.virtual-microphone";
const DEFAULT_VIRTUAL_MICROPHONE_ARGUMENTS = [
  "--no-config",
  "--no-video",
  "--really-quiet",
  "--audio-device={device}",
  "--",
  "{audio}",
] as const;
const MAXIMUM_PLAYER_ARGUMENTS = 64;
const MAXIMUM_PLAYER_ARGUMENT_LENGTH = 4_096;

export interface VirtualMicrophoneAudioSinkSettings
  extends ExternalAudioSinkOptions {
  readonly device: string;
}

function virtualMicrophoneSection(config: JsonRecord): JsonRecord | undefined {
  const value = config["virtual_microphone"];
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OutputConfigError(
      VIRTUAL_MICROPHONE_COMPONENT,
      "virtual_microphone must be an object",
    );
  }
  return value as JsonRecord;
}

function requiredPlayerValue(
  value: unknown,
  path: string,
  fallback?: string,
): string {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new OutputConfigError(
      VIRTUAL_MICROPHONE_COMPONENT,
      `${path} must be a non-empty string`,
    );
  }
  const normalized = candidate.trim();
  if (
    normalized.length > MAXIMUM_PLAYER_ARGUMENT_LENGTH ||
    /[\u0000\r\n]/u.test(normalized)
  ) {
    throw new OutputConfigError(
      VIRTUAL_MICROPHONE_COMPONENT,
      `${path} contains unsupported characters or is too long`,
    );
  }
  return normalized;
}

function virtualMicrophoneArguments(
  value: unknown,
  device: string,
): readonly string[] {
  const configured = value ?? DEFAULT_VIRTUAL_MICROPHONE_ARGUMENTS;
  if (
    !Array.isArray(configured) ||
    configured.length === 0 ||
    configured.length > MAXIMUM_PLAYER_ARGUMENTS ||
    configured.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length > MAXIMUM_PLAYER_ARGUMENT_LENGTH ||
        argument.includes("\0"),
    )
  ) {
    throw new OutputConfigError(
      VIRTUAL_MICROPHONE_COMPONENT,
      `virtual_microphone.args must contain 1-${MAXIMUM_PLAYER_ARGUMENTS} valid string arguments`,
    );
  }
  if (!configured.some((argument) => argument.includes("{device}"))) {
    throw new OutputConfigError(
      VIRTUAL_MICROPHONE_COMPONENT,
      "virtual_microphone.args must contain a {device} placeholder",
    );
  }
  if (!configured.some((argument) => argument.includes("{audio}"))) {
    throw new OutputConfigError(
      VIRTUAL_MICROPHONE_COMPONENT,
      "virtual_microphone.args must contain an {audio} placeholder",
    );
  }
  return configured.map((argument) => argument.replaceAll("{device}", device));
}

export function resolveVirtualMicrophoneAudioSinkSettings(
  config: JsonRecord,
): VirtualMicrophoneAudioSinkSettings | undefined {
  const section = virtualMicrophoneSection(config);
  if (section === undefined || section["enable"] !== true) {
    return undefined;
  }
  const playAudio = config["play_audio"];
  if (
    playAudio !== null &&
    typeof playAudio === "object" &&
    !Array.isArray(playAudio) &&
    (playAudio as JsonRecord)["enable"] === false
  ) {
    throw new OutputConfigError(
      VIRTUAL_MICROPHONE_COMPONENT,
      "virtual_microphone.enable requires play_audio.enable",
    );
  }
  const device = requiredPlayerValue(
    section["device"],
    "virtual_microphone.device",
  );
  const executable = requiredPlayerValue(
    section["executable"],
    "virtual_microphone.executable",
    "mpv",
  );
  const args = virtualMicrophoneArguments(section["args"], device);
  return { device, executable, args };
}

/**
 * Sends synthesized speech to the playback side of an OS virtual audio cable.
 * Local songs, alarms, and prerecorded clips deliberately remain on the
 * primary output only.
 */
export class VirtualMicrophoneAudioSink implements AudioSink {
  readonly #delegate: AudioSink;

  constructor(delegate: AudioSink) {
    this.#delegate = delegate;
  }

  async play(
    artifact: AudioArtifact,
    context: SpeechAudioContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (context.source === "local-audio") {
      return;
    }
    await this.#delegate.play(artifact, context, signal);
  }

  async stop(): Promise<void> {
    await this.#delegate.stop();
  }

  async dispose(): Promise<void> {
    if (this.#delegate.dispose !== undefined) {
      await this.#delegate.dispose();
      return;
    }
    await this.#delegate.stop();
  }
}

export function createVirtualMicrophoneAudioSinkFromConfig(
  config: JsonRecord,
): VirtualMicrophoneAudioSink | undefined {
  const settings = resolveVirtualMicrophoneAudioSinkSettings(config);
  if (settings === undefined) {
    return undefined;
  }
  return new VirtualMicrophoneAudioSink(
    new ExternalAudioSink({
      executable: settings.executable,
      args: settings.args,
    }),
  );
}

function rejectedReasons(
  results: readonly PromiseSettledResult<void>[],
): unknown[] {
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
}

function throwRejected(
  label: string,
  results: readonly PromiseSettledResult<void>[],
): void {
  const reasons = rejectedReasons(results);
  if (reasons.length === 1) {
    throw reasons[0];
  }
  if (reasons.length > 1) {
    throw new AggregateError(reasons, label);
  }
}

/** Plays the same artifact concurrently and waits for every output to settle. */
export class MirroredAudioSink implements AudioSink {
  readonly #sinks: readonly AudioSink[];
  #active: Promise<void> | undefined;

  constructor(primary: AudioSink, mirror: AudioSink) {
    this.#sinks = [primary, mirror];
  }

  async play(
    artifact: AudioArtifact,
    context: SpeechAudioContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#active !== undefined) {
      throw new Error("Mirrored audio sink received overlapping playback requests");
    }
    const pending = Promise.allSettled(
      this.#sinks.map((sink) => sink.play(artifact, context, signal)),
    );
    this.#active = pending.then(() => undefined);
    try {
      throwRejected("Mirrored audio playback failed", await pending);
    } finally {
      this.#active = undefined;
    }
  }

  async stop(): Promise<void> {
    const active = this.#active;
    const results = await Promise.allSettled(
      this.#sinks.map((sink) => sink.stop()),
    );
    await active;
    throwRejected("Mirrored audio playback could not be stopped", results);
  }

  async dispose(): Promise<void> {
    const stopResults = await Promise.allSettled([this.stop()]);
    const disposeResults = await Promise.allSettled(
      this.#sinks.map((sink) =>
        sink.dispose === undefined ? Promise.resolve() : sink.dispose()
      ),
    );
    throwRejected(
      "Mirrored audio playback could not be disposed",
      [...stopResults, ...disposeResults],
    );
  }
}
