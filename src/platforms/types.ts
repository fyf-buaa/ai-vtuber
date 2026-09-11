import type { Readable } from "node:stream";

import type { LiveEvent } from "../domain/types.js";

export type PlatformConfig = Readonly<Record<string, unknown>>;

export interface ConfigSnapshotProvider {
  snapshot(): unknown;
}

export type PlatformConfigInput = PlatformConfig | ConfigSnapshotProvider;

export type PlatformErrorHandler = (error: Error) => void;

export interface WebSocketConnection {
  readonly readyState: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: "close", listener: (code: number, reason: Uint8Array) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off?(event: "open", listener: () => void): this;
  off?(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
  off?(event: "close", listener: (code: number, reason: Uint8Array) => void): this;
  off?(event: "error", listener: (error: Error) => void): this;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export interface WebSocketConnectOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly agent?: unknown;
}

export type WebSocketFactory = (
  url: string,
  protocols?: string | readonly string[],
  options?: WebSocketConnectOptions,
) => WebSocketConnection;

export interface WebSocketServerOptions {
  readonly host: string;
  readonly port: number;
  readonly path?: string;
}

export interface WebSocketServerHandle {
  readonly clients?: ReadonlySet<WebSocketConnection>;
  on(event: "listening", listener: () => void): this;
  on(
    event: "connection",
    listener: (connection: WebSocketConnection) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  close(callback: (error?: Error) => void): void;
}

export type WebSocketServerFactory = (
  options: WebSocketServerOptions,
) => WebSocketServerHandle;

export type AbortableSleep = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export interface PlatformDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly webSocketFactory?: WebSocketFactory;
  readonly webSocketServerFactory?: WebSocketServerFactory;
  readonly stdin?: Readable;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: AbortableSleep;
  readonly signal?: AbortSignal;
  readonly onError?: PlatformErrorHandler;
}

export type PayloadNormalizer = (payload: unknown) => readonly LiveEvent[];

export interface ReconnectOptions {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly maximumAttempts: number;
  readonly connectionTimeoutMs: number;
  readonly acknowledgementTimeoutMs: number;
  readonly stableConnectionMs: number;
}
