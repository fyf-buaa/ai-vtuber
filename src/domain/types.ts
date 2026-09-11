export type Metadata = Readonly<Record<string, unknown>>;

export type LiveEventType =
  | "comment"
  | "gift"
  | "entrance"
  | "follow"
  | "talk"
  | "schedule"
  | "idle"
  | "image";

export interface LiveEvent {
  readonly id: string;
  readonly type: LiveEventType;
  readonly platform: string;
  readonly username: string;
  readonly content: string;
  /** Unix time in milliseconds. */
  readonly timestamp: number;
  readonly metadata: Metadata;
}

export interface AgentRequest {
  readonly sessionId: string;
  readonly username: string;
  readonly content: string;
  readonly systemPrompt?: string | undefined;
  readonly images?: readonly string[] | undefined;
  readonly metadata?: Metadata | undefined;
}

export interface AgentUsage {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
  readonly totalTokens?: number | undefined;
}

export interface AgentResponse {
  readonly text: string;
  readonly usage?: AgentUsage | undefined;
  readonly model: string;
  readonly provider: string;
}

export interface SpeechRequest {
  readonly text: string;
  readonly sourceEventId?: string | undefined;
  readonly outputPath?: string | undefined;
  readonly metadata?: Metadata | undefined;
}

export interface LocalAudioRequest extends SpeechRequest {
  readonly audioPath: string;
}

export type SpeechState = "idle" | "running" | "stopping" | "stopped";

export interface SpeechStatus {
  readonly state: SpeechState;
  readonly queued: number;
  readonly activeId?: string | undefined;
}

export interface InboundAppEvent {
  readonly type: "inbound";
  readonly event: LiveEvent;
  readonly timestamp: number;
}

export interface AgentDeltaAppEvent {
  readonly type: "agent.delta";
  readonly request: AgentRequest;
  readonly text: string;
  readonly timestamp: number;
}

export interface AgentCompletedAppEvent {
  readonly type: "agent.completed";
  readonly request: AgentRequest;
  readonly response: AgentResponse;
  readonly timestamp: number;
}

export interface AgentErrorAppEvent {
  readonly type: "agent.error";
  readonly request: AgentRequest;
  readonly error: string;
  readonly timestamp: number;
}

export interface SpeechQueuedAppEvent {
  readonly type: "speech.queued";
  readonly speechId: string;
  readonly request: SpeechRequest;
  readonly timestamp: number;
}

export interface SpeechStartedAppEvent {
  readonly type: "speech.started";
  readonly speechId: string;
  readonly request: SpeechRequest;
  readonly timestamp: number;
}

export interface SpeechCompletedAppEvent {
  readonly type: "speech.completed";
  readonly speechId: string;
  readonly request: SpeechRequest;
  readonly outputPath?: string | undefined;
  readonly timestamp: number;
}

export interface SpeechErrorAppEvent {
  readonly type: "speech.error";
  readonly speechId: string;
  readonly request: SpeechRequest;
  readonly error: string;
  readonly timestamp: number;
}

export type SystemState =
  | "starting"
  | "ready"
  | "degraded"
  | "stopping"
  | "stopped"
  | "error";

export interface SystemStatusAppEvent {
  readonly type: "system.status";
  readonly component: string;
  readonly status: SystemState;
  readonly message?: string | undefined;
  readonly metadata?: Metadata | undefined;
  readonly timestamp: number;
}

export type AppEvent =
  | InboundAppEvent
  | AgentDeltaAppEvent
  | AgentCompletedAppEvent
  | AgentErrorAppEvent
  | SpeechQueuedAppEvent
  | SpeechStartedAppEvent
  | SpeechCompletedAppEvent
  | SpeechErrorAppEvent
  | SystemStatusAppEvent;

export interface EventPublisher {
  publish(event: AppEvent): void;
}

export interface Disposable {
  dispose(): Promise<void>;
}
