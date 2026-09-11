import type { EventSource } from "../core/contracts.js";
import { normalizeLivePayload } from "./normalization.js";
import type {
  PlatformDependencies,
  ReconnectOptions,
  WebSocketConnectOptions,
} from "./types.js";
import type { WebSocketAcknowledgement } from "./websocket-client.js";
import { parseWebSocketListenUrl } from "./utilities.js";
import {
  ReconnectingWebSocketSource,
  type WebSocketSession,
} from "./websocket-client.js";
import { JsonWebSocketServerSource } from "./websocket-server.js";

export interface RelayClientOptions {
  readonly platform: string;
  readonly url: string;
  readonly reconnect: ReconnectOptions;
  readonly protocols?: string | readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly agent?: unknown;
  readonly initialMessages?: readonly (string | Uint8Array)[];
  readonly acknowledgement?: WebSocketAcknowledgement;
}

export interface RelayServerOptions {
  readonly platform: string;
  readonly listenUrl: string;
}

export function createRelayClientSource(
  options: RelayClientOptions,
  dependencies: PlatformDependencies = {},
): EventSource {
  const now = dependencies.now ?? Date.now;
  const connectionOptions: WebSocketConnectOptions | undefined =
    options.headers === undefined && options.agent === undefined
      ? undefined
      : {
          ...(options.headers === undefined ? {} : { headers: options.headers }),
          ...(options.agent === undefined ? {} : { agent: options.agent }),
        };
  return new ReconnectingWebSocketSource({
    name: options.platform,
    session: (_signal): Promise<WebSocketSession> =>
      Promise.resolve({
        url: options.url,
        ...(options.protocols === undefined
          ? {}
          : { protocols: options.protocols }),
        ...(connectionOptions === undefined
          ? {}
          : { options: connectionOptions }),
        ...(options.initialMessages === undefined
          ? {}
          : { initialMessages: options.initialMessages }),
        ...(options.acknowledgement === undefined
          ? {}
          : { acknowledgement: options.acknowledgement }),
      }),
    normalize: (payload) =>
      normalizeLivePayload(payload, { platform: options.platform, now }),
    reconnect: options.reconnect,
    ...(dependencies.webSocketFactory === undefined
      ? {}
      : { webSocketFactory: dependencies.webSocketFactory }),
    ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    ...(dependencies.random === undefined ? {} : { random: dependencies.random }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.onError === undefined
      ? {}
      : { onError: dependencies.onError }),
  });
}

export function createRelayServerSource(
  options: RelayServerOptions,
  dependencies: PlatformDependencies = {},
): EventSource {
  const now = dependencies.now ?? Date.now;
  return new JsonWebSocketServerSource({
    name: options.platform,
    listen: parseWebSocketListenUrl(options.platform, options.listenUrl),
    normalize: (payload) =>
      normalizeLivePayload(payload, { platform: options.platform, now }),
    ...(dependencies.webSocketServerFactory === undefined
      ? {}
      : { webSocketServerFactory: dependencies.webSocketServerFactory }),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    ...(dependencies.onError === undefined
      ? {}
      : { onError: dependencies.onError }),
  });
}
