import type {
  AgentRequest,
  AgentResponse,
  Disposable,
  LiveEvent,
  LocalAudioRequest,
  SpeechRequest,
  SpeechStatus,
} from "../domain/types.js";

export interface AgentExecutionOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface AgentExecutor {
  execute(
    request: AgentRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentResponse>;
  stream(
    request: AgentRequest,
    options?: AgentExecutionOptions,
  ): AsyncIterable<string>;
  reset(sessionId?: string): Promise<void>;
}

export type LiveEventHandler = (event: LiveEvent) => void | Promise<void>;

export interface EventSource extends Disposable {
  readonly name: string;
  start(handler: LiveEventHandler): Promise<void>;
}

export interface SpeechEnqueueOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface SpeechService extends Disposable {
  enqueue(
    request: SpeechRequest,
    options?: SpeechEnqueueOptions,
  ): Promise<string>;
  enqueueAudio(
    request: LocalAudioRequest,
    options?: SpeechEnqueueOptions,
  ): Promise<string>;
  stop(): Promise<void>;
  status(): SpeechStatus;
}

export interface ProcessedReply {
  readonly event: LiveEvent;
  readonly text: string;
  readonly source: "agent" | "reread" | "command";
  readonly speechId?: string | undefined;
}

export type {
  LocalAudioRequest,
  SpeechRequest,
  SpeechStatus,
} from "../domain/types.js";
