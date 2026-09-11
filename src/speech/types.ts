import type { LocalAudioRequest, SpeechRequest } from "../domain/types.js";

export interface SynthesizedAudio {
  /** Filename suffix without a leading dot. */
  readonly extension: string;
  readonly contentType?: string;
  readonly stream: AsyncIterable<Uint8Array>;
}

export interface SpeechTextSplitOptions {
  readonly enabled: boolean;
  readonly intervalNumMin: number;
  readonly intervalNumMax: number;
  readonly normalIntervalMinMs: number;
  readonly normalIntervalMaxMs: number;
}

export type SpeechPriorityMapping = Readonly<Record<string, number>>;

export interface SpeechSynthesizer {
  readonly name: string;
  synthesize(
    request: SpeechRequest,
    signal: AbortSignal,
  ): Promise<SynthesizedAudio | undefined>;
}

export interface AudioArtifact {
  /** Absolute path to a non-empty regular file. */
  readonly path: string;
  /** Filename suffix without a leading dot. */
  readonly format: string;
  /** The speech service removes temporary artifacts after playback or failure. */
  readonly temporary: boolean;
}

export type SpeechAudioContext =
  | Readonly<{
      readonly speechId: string;
      readonly source: "synthesized";
      readonly request: SpeechRequest;
    }>
  | Readonly<{
      readonly speechId: string;
      readonly source: "local-audio";
      readonly request: LocalAudioRequest;
    }>;

export interface AudioPostProcessor {
  /**
   * Post-processors run serially in registration order. Returning a different
   * temporary artifact transfers cleanup responsibility to the speech service.
   */
  process(
    artifact: AudioArtifact,
    context: SpeechAudioContext,
    signal: AbortSignal,
  ): Promise<AudioArtifact>;
  dispose?(): Promise<void>;
}

export interface AudioSink {
  play(
    artifact: AudioArtifact,
    context: SpeechAudioContext,
    signal: AbortSignal,
  ): Promise<void>;
  /** Stop the current playback, if any. The sink remains safe to dispose. */
  stop(): Promise<void>;
  dispose?(): Promise<void>;
}

export type SpeechFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
