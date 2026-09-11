export {
  PLATFORM_CATALOG,
  PENDING_PLATFORM_CONFIG_PATHS,
  isPlatformAvailable,
  pendingPlatformForPath,
  platformAvailability,
  type PlatformAvailability,
} from "./availability.js";
export {
  SUPPORTED_PLATFORM_IDS,
  PlatformRegistry,
  assertPlatformAvailable,
  createDefaultPlatformRegistry,
  createPlatformEventSource,
} from "./registry.js";
export {
  normalizeLivePayload,
  type NormalizeOptions,
} from "./normalization.js";
export {
  createRelayClientSource,
  createRelayServerSource,
  type RelayClientOptions,
  type RelayServerOptions,
} from "./relay.js";
export { StdinJsonLineSource } from "./stdin.js";
export {
  YouTubeLiveChatSource,
  normalizeYouTubeItem,
  type YouTubeLiveChatOptions,
} from "./youtube.js";
export {
  TwitchIrcSource,
  decodeTwitchIrcLine,
  type TwitchIrcOptions,
} from "./twitch.js";
export {
  BilibiliWebSource,
  type BilibiliWebOptions,
} from "./bilibili-web.js";
export {
  BilibiliPlatformSource,
  type BilibiliPlatformOptions,
} from "./bilibili-platform.js";
export {
  JsonWebSocketServerSource,
  type JsonWebSocketServerSourceOptions,
} from "./websocket-server.js";
export {
  ReconnectingWebSocketSource,
  decodeJsonWebSocketFrames,
  decodeWebSocketText,
  type ReconnectingWebSocketSourceOptions,
  type WebSocketAcknowledgement,
  type WebSocketSession,
} from "./websocket-client.js";
export {
  PlatformConfigurationError,
  PlatformConnectionError,
} from "./utilities.js";
export type {
  AbortableSleep,
  ConfigSnapshotProvider,
  PayloadNormalizer,
  PlatformConfig,
  PlatformConfigInput,
  PlatformDependencies,
  PlatformErrorHandler,
  ReconnectOptions,
  WebSocketConnection,
  WebSocketConnectOptions,
  WebSocketFactory,
  WebSocketServerFactory,
  WebSocketServerHandle,
  WebSocketServerOptions,
} from "./types.js";
