import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { LiveEvent } from "../src/domain/types.js";
import {
  TwitchIrcSource,
  type ReconnectOptions,
  type WebSocketConnection,
} from "../src/platforms/index.js";

const NOW = 1_700_000_000_123;
const RECONNECT: ReconnectOptions = {
  initialDelayMs: 1,
  maximumDelayMs: 2,
  maximumAttempts: 2,
  connectionTimeoutMs: 100,
  acknowledgementTimeoutMs: 100,
  stableConnectionMs: 1_000,
};

class FakeTwitchConnection extends EventEmitter {
  readyState = 0;
  readonly sent: (string | Uint8Array)[] = [];
  closed = false;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.close(1006, "terminated");
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  receive(frame: string): void {
    this.emit("message", Buffer.from(frame), false);
  }
}

interface TwitchHarness {
  readonly source: TwitchIrcSource;
  readonly connection: FakeTwitchConnection;
  readonly events: LiveEvent[];
}

async function startTwitch(): Promise<TwitchHarness> {
  const connection = new FakeTwitchConnection();
  const events: LiveEvent[] = [];
  const source = new TwitchIrcSource(
    {
      token: "oauth:test",
      user: "bot",
      channel: "channel",
      reconnect: RECONNECT,
    },
    {
      webSocketFactory: () => {
        queueMicrotask(() => {
          connection.open();
          connection.receive(
            ":tmi.twitch.tv 001 bot :Welcome, GLHF!\r\n" +
              ":tmi.twitch.tv 366 bot #channel :End of /NAMES list\r\n",
          );
        });
        return connection as unknown as WebSocketConnection;
      },
      now: () => NOW,
      onError: vi.fn(),
    },
  );
  await source.start((event) => {
    events.push(event);
  });
  return { source, connection, events };
}

function privmsg(id: string, content: string): string {
  return (
    `@display-name=Viewer;id=${id};tmi-sent-ts=${NOW} ` +
    `:viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #channel :${content}`
  );
}

function settleMessages(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

describe("Twitch IRC framing", () => {
  it("buffers a PRIVMSG split in the middle until its terminator arrives", async () => {
    const { source, connection, events } = await startTwitch();
    try {
      const line = privmsg("split-middle", "hello");
      const splitAt = line.indexOf("hello") + 3;
      connection.receive(line.slice(0, splitAt));
      await settleMessages();
      expect(events).toHaveLength(0);

      connection.receive(`${line.slice(splitAt)}\r\n`);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toMatchObject({
        type: "comment",
        username: "Viewer",
        content: "hello",
      });
    } finally {
      await source.dispose();
    }
  });

  it("retains a trailing CR until the LF arrives in a later frame", async () => {
    const { source, connection, events } = await startTwitch();
    try {
      connection.receive(`${privmsg("split-crlf", "hello")}\r`);
      await settleMessages();
      expect(events).toHaveLength(0);

      connection.receive("\n");
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events.map((event) => event.content)).toEqual(["hello"]);
    } finally {
      await source.dispose();
    }
  });

  it("emits complete lines while retaining a final incomplete line", async () => {
    const { source, connection, events } = await startTwitch();
    try {
      const remainder = privmsg("third", "three");
      const splitAt = remainder.indexOf("three") + 2;
      connection.receive(
        `${privmsg("first", "one")}\r\n` +
          `${privmsg("second", "two")}\r\n` +
          remainder.slice(0, splitAt),
      );
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(events.map((event) => event.content)).toEqual(["one", "two"]);

      connection.receive(`${remainder.slice(splitAt)}\r\n`);
      await vi.waitFor(() => expect(events).toHaveLength(3));
      expect(events.map((event) => event.content)).toEqual([
        "one",
        "two",
        "three",
      ]);
    } finally {
      await source.dispose();
    }
  });

  it("handles complete one-frame PING and PRIVMSG records", async () => {
    const { source, connection, events } = await startTwitch();
    try {
      connection.receive(
        `PING :tmi.twitch.tv\r\n${privmsg("complete", "hello")}\r\n`,
      );
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toMatchObject({
        type: "comment",
        username: "Viewer",
        content: "hello",
      });
      expect(connection.sent).toContain("PONG :tmi.twitch.tv\r\n");
    } finally {
      await source.dispose();
    }
  });
});
