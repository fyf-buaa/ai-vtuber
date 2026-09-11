import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  get,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Live2dStaticServer } from "../src/output/live2d-server.js";

interface EventStream {
  readonly request: ClientRequest;
  readonly response: IncomingMessage;
}

function openEventStream(url: string): Promise<EventStream> {
  return new Promise<EventStream>((accept, reject) => {
    const request = get(url, (response) => {
      accept({ request, response });
    });
    request.once("error", reject);
  });
}

function readMessages(response: IncomingMessage, count: number): Promise<readonly string[]> {
  return new Promise<readonly string[]>((accept, reject) => {
    const messages: string[] = [];
    let pending = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      pending += chunk;
      let boundary = pending.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (frame.startsWith("data: ")) {
          try {
            const payload = JSON.parse(frame.slice("data: ".length)) as {
              readonly message?: unknown;
            };
            if (typeof payload.message === "string") {
              messages.push(payload.message);
              if (messages.length === count) {
                accept(messages);
                return;
              }
            }
          } catch (cause) {
            reject(cause);
            return;
          }
        }
        boundary = pending.indexOf("\n\n");
      }
    });
    response.once("error", reject);
  });
}

async function createModelFixture(root: string): Promise<void> {
  const directory = join(root, "live2d-model", "Hiyori");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "Hiyori.model3.json"), "{}", "utf8");
}

describe("Live2D SSE backpressure", () => {
  const servers: Live2dStaticServer[] = [];
  const requests: ClientRequest[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const request of requests.splice(0)) {
      request.destroy();
    }
    await Promise.all(servers.splice(0).map(async (server) => server.dispose()));
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { force: true, recursive: true });
      }),
    );
  });

  it("evicts a paused client when its writable buffer reaches the configured cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-vtuber-live2d-backpressure-"));
    temporaryDirectories.push(root);
    await createModelFixture(root);
    const server = new Live2dStaticServer({
      enabled: true,
      rootDirectory: root,
      host: "127.0.0.1",
      port: 0,
      maxClients: 1,
      maxClientBufferBytes: 2_048,
    });
    servers.push(server);
    const origin = await server.start();
    expect(origin).toBeTypeOf("string");

    const slow = await openEventStream(`${origin}/Live2D/events`);
    requests.push(slow.request);
    expect(slow.response.statusCode).toBe(200);
    slow.response.on("error", () => undefined);
    slow.response.pause();
    const closed = new Promise<void>((accept) => {
      slow.response.once("close", () => accept());
    });

    const largeMessage = "x".repeat(900);
    for (let index = 0; index < 100; index += 1) {
      server.publishMessage(`${index}:${largeMessage}`);
    }
    await closed;

    const replacement = await openEventStream(`${origin}/Live2D/events`);
    requests.push(replacement.request);
    expect(replacement.response.statusCode).toBe(200);
  });

  it("delivers events to a healthy client in publication order", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-vtuber-live2d-ordered-"));
    temporaryDirectories.push(root);
    await createModelFixture(root);
    const server = new Live2dStaticServer({
      enabled: true,
      rootDirectory: root,
      host: "127.0.0.1",
      port: 0,
      maxClientBufferBytes: 2_048,
    });
    servers.push(server);
    const origin = await server.start();
    expect(origin).toBeTypeOf("string");

    const stream = await openEventStream(`${origin}/Live2D/events`);
    requests.push(stream.request);
    expect(stream.response.statusCode).toBe(200);
    const messages = readMessages(stream.response, 3);

    server.publishMessage("first", 100);
    server.publishMessage("second", 200);
    server.publishMessage("third", 300);

    await expect(messages).resolves.toEqual(["first", "second", "third"]);
  });

});
