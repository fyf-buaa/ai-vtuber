import type { EventSource, LiveEventHandler } from "../core/contracts.js";
import { normalizeLivePayload } from "./normalization.js";
import type {
  PlatformDependencies,
  ReconnectOptions,
  WebSocketConnection,
} from "./types.js";
import { isRecord } from "./utilities.js";
import {
  decodeWebSocketText,
  ReconnectingWebSocketSource,
  type WebSocketSession,
} from "./websocket-client.js";

export interface TwitchIrcOptions {
  readonly platform?: string;
  readonly token: string;
  readonly user: string;
  readonly channel: string;
  readonly url?: string;
  readonly agent?: unknown;
  readonly reconnect: ReconnectOptions;
}

interface IrcMessage {
  readonly command: string;
  readonly prefix?: string;
  readonly params: readonly string[];
  readonly trailing?: string;
  readonly tags: Readonly<Record<string, string>>;
}

interface TwitchMarker {
  readonly twitchProtocol: "welcome" | "joined" | "auth-error" | "reconnect";
  readonly message?: string;
}

export class TwitchIrcSource implements EventSource {
  readonly name: string;
  readonly #source: ReconnectingWebSocketSource;

  constructor(
    options: TwitchIrcOptions,
    dependencies: PlatformDependencies = {},
  ) {
    this.name = options.platform ?? "twitch";
    const channel = options.channel.replace(/^#/u, "").toLowerCase();
    const user = options.user.toLowerCase();
    const now = dependencies.now ?? Date.now;
    this.#source = new ReconnectingWebSocketSource({
      name: this.name,
      session: (_signal): Promise<WebSocketSession> => {
        let welcomed = false;
        let joined = false;
        let remainder = "";
        return Promise.resolve({
          url: options.url ?? "wss://irc-ws.chat.twitch.tv:443",
          ...(options.agent === undefined
            ? {}
            : { options: { agent: options.agent } }),
          initialMessages: [
            "CAP REQ :twitch.tv/tags twitch.tv/commands\r\n",
            `PASS ${options.token}\r\n`,
            `NICK ${options.user}\r\n`,
            `JOIN #${channel}\r\n`,
          ],
          decode: async (data, _isBinary, connection) => {
            remainder += await decodeWebSocketText(data);
            const lines = remainder.split("\r\n");
            remainder = lines.pop() ?? "";
            return lines.flatMap((line) =>
              decodeTwitchIrcLine(line, connection, {
                platform: this.name,
                channel,
                user,
                now,
              }),
            );
          },
          acknowledgement: (payload) => {
            const marker = twitchMarker(payload);
            if (marker === undefined) {
              return false;
            }
            if (marker.twitchProtocol === "auth-error") {
              return new Error(marker.message ?? "Twitch authentication failed");
            }
            if (marker.twitchProtocol === "welcome") {
              welcomed = true;
            } else if (marker.twitchProtocol === "joined") {
              joined = true;
            }
            return welcomed && joined;
          },
        });
      },
      normalize: (payload) =>
        normalizeLivePayload(payload, { platform: this.name, now }),
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

  async start(handler: LiveEventHandler): Promise<void> {
    await this.#source.start(handler);
  }

  async dispose(): Promise<void> {
    await this.#source.dispose();
  }
}

export function decodeTwitchIrcLine(
  line: string,
  connection: WebSocketConnection,
  context: {
    readonly platform: string;
    readonly channel: string;
    readonly user: string;
    readonly now: () => number;
  },
): readonly unknown[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("PING ")) {
    const challenge = trimmed.slice(5);
    connection.send(`PONG ${challenge}\r\n`);
    return [];
  }
  const message = parseIrcMessage(trimmed);
  if (message === undefined) {
    return [];
  }

  if (message.command === "001") {
    return [{ twitchProtocol: "welcome" } satisfies TwitchMarker];
  }
  if (
    message.command === "366" &&
    message.params.some(
      (parameter) => parameter.toLowerCase() === `#${context.channel}`,
    )
  ) {
    return [{ twitchProtocol: "joined" } satisfies TwitchMarker];
  }
  if (
    message.command === "JOIN" &&
    prefixNickname(message.prefix)?.toLowerCase() === context.user &&
    (message.trailing ?? message.params[0])?.toLowerCase() ===
      `#${context.channel}`
  ) {
    return [{ twitchProtocol: "joined" } satisfies TwitchMarker];
  }
  if (
    message.command === "USERSTATE" &&
    message.params[0]?.toLowerCase() === `#${context.channel}`
  ) {
    return [{ twitchProtocol: "joined" } satisfies TwitchMarker];
  }
  if (message.command === "NOTICE") {
    const notice = message.trailing ?? "Twitch rejected the connection";
    if (/authentication failed|login unsuccessful|improperly formatted auth/iu.test(notice)) {
      return [
        {
          twitchProtocol: "auth-error",
          message: notice,
        } satisfies TwitchMarker,
      ];
    }
    return [];
  }
  if (message.command === "RECONNECT") {
    connection.close(1012, "Twitch requested reconnect");
    return [{ twitchProtocol: "reconnect" } satisfies TwitchMarker];
  }
  if (message.command === "PRIVMSG") {
    const content = cleanActionMessage(message.trailing ?? "");
    if (content.length === 0) {
      return [];
    }
    const username =
      message.tags["display-name"] ?? prefixNickname(message.prefix) ?? "匿名用户";
    const metadata: Record<string, unknown> = {
      protocol: "twitch-irc",
      channel: context.channel,
    };
    copyTag(metadata, message.tags, "userId", "user-id");
    copyTag(metadata, message.tags, "badges", "badges");
    copyTag(metadata, message.tags, "color", "color");
    copyTag(metadata, message.tags, "bits", "bits", true);
    copyTag(metadata, message.tags, "replyParentMessageId", "reply-parent-msg-id");
    return [
      {
        id: message.tags["id"],
        type: "comment",
        username,
        content,
        timestamp: message.tags["tmi-sent-ts"] ?? context.now(),
        metadata,
      },
    ];
  }
  if (message.command === "USERNOTICE") {
    const noticeType = message.tags["msg-id"] ?? "";
    const username =
      message.tags["display-name"] ?? prefixNickname(message.prefix) ?? "匿名用户";
    const metadata: Record<string, unknown> = {
      protocol: "twitch-irc",
      channel: context.channel,
      noticeType,
    };
    copyTag(metadata, message.tags, "userId", "user-id");
    copyTag(metadata, message.tags, "systemMessage", "system-msg");
    copyTag(metadata, message.tags, "subscriptionPlan", "msg-param-sub-plan");
    copyTag(metadata, message.tags, "months", "msg-param-cumulative-months", true);
    copyTag(
      metadata,
      message.tags,
      "recipient",
      "msg-param-recipient-display-name",
    );
    const systemMessage = message.tags["system-msg"];
    if (["sub", "resub", "subgift", "anonsubgift"].includes(noticeType)) {
      metadata["giftName"] = "Subscription";
      metadata["quantity"] = 1;
      return [
        {
          id: message.tags["id"],
          type: "gift",
          username,
          content: message.trailing ?? systemMessage ?? "Subscription",
          timestamp: message.tags["tmi-sent-ts"] ?? context.now(),
          metadata,
        },
      ];
    }
    if (noticeType === "raid") {
      return [
        {
          id: message.tags["id"],
          type: "entrance",
          username,
          content: systemMessage ?? "进入直播间",
          timestamp: message.tags["tmi-sent-ts"] ?? context.now(),
          metadata,
        },
      ];
    }
  }
  return [];
}

function parseIrcMessage(line: string): IrcMessage | undefined {
  let remaining = line;
  const tags: Record<string, string> = {};
  if (remaining.startsWith("@")) {
    const space = remaining.indexOf(" ");
    if (space < 0) {
      return undefined;
    }
    for (const item of remaining.slice(1, space).split(";")) {
      const equals = item.indexOf("=");
      const key = equals < 0 ? item : item.slice(0, equals);
      const value = equals < 0 ? "" : item.slice(equals + 1);
      tags[key] = unescapeIrcTag(value);
    }
    remaining = remaining.slice(space + 1);
  }
  let prefix: string | undefined;
  if (remaining.startsWith(":")) {
    const space = remaining.indexOf(" ");
    if (space < 0) {
      return undefined;
    }
    prefix = remaining.slice(1, space);
    remaining = remaining.slice(space + 1);
  }
  const trailingIndex = remaining.indexOf(" :");
  const trailing =
    trailingIndex >= 0 ? remaining.slice(trailingIndex + 2) : undefined;
  const head = trailingIndex >= 0 ? remaining.slice(0, trailingIndex) : remaining;
  const pieces = head.split(/ +/u).filter((piece) => piece.length > 0);
  const command = pieces.shift()?.toUpperCase();
  if (command === undefined) {
    return undefined;
  }
  return {
    command,
    ...(prefix === undefined ? {} : { prefix }),
    params: pieces,
    ...(trailing === undefined ? {} : { trailing }),
    tags,
  };
}

function twitchMarker(payload: unknown): TwitchMarker | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const kind = payload["twitchProtocol"];
  if (
    kind !== "welcome" &&
    kind !== "joined" &&
    kind !== "auth-error" &&
    kind !== "reconnect"
  ) {
    return undefined;
  }
  const message =
    typeof payload["message"] === "string" ? payload["message"] : undefined;
  return {
    twitchProtocol: kind,
    ...(message === undefined ? {} : { message }),
  };
}

function prefixNickname(prefix: string | undefined): string | undefined {
  if (prefix === undefined) {
    return undefined;
  }
  const separator = prefix.indexOf("!");
  return separator < 0 ? prefix : prefix.slice(0, separator);
}

function cleanActionMessage(content: string): string {
  if (content.startsWith("\u0001ACTION ") && content.endsWith("\u0001")) {
    return content.slice(8, -1).trim();
  }
  return content.trim();
}

function unescapeIrcTag(value: string): string {
  return value.replace(/\\([snr:\\])/gu, (_match, escaped: string) => {
    if (escaped === "s") return " ";
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === ":") return ";";
    return "\\";
  });
}

function copyTag(
  metadata: Record<string, unknown>,
  tags: Readonly<Record<string, string>>,
  metadataKey: string,
  tagKey: string,
  numeric = false,
): void {
  const value = tags[tagKey];
  if (value === undefined || value.length === 0) {
    return;
  }
  if (numeric) {
    const number = Number(value);
    metadata[metadataKey] = Number.isFinite(number) ? number : value;
  } else {
    metadata[metadataKey] = value;
  }
}
