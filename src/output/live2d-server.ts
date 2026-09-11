import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { Disposable, EventPublisher } from "../domain/types.js";
import {
  asOutputBridgeError,
  OutputConfigError,
  OutputPathError,
  publishOutputFailure,
  type OutputClock,
} from "./errors.js";

export interface Live2dMessage {
  readonly type: "message";
  readonly message: string;
  readonly duration: number;
}

export interface Live2dStaticServerConfig {
  readonly enabled: boolean;
  readonly rootDirectory?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly maxClients?: number | undefined;
  readonly maxMessageLength?: number | undefined;
  readonly maxClientBufferBytes?: number | undefined;
  readonly modelName?: string | undefined;
}

export interface Live2dStaticServerDependencies {
  readonly publisher?: EventPublisher | undefined;
  readonly clock?: OutputClock | undefined;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".moc3": "application/octet-stream",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".webp": "image/webp",
};


const CONNECTED_FRAME = ": connected\n\n";
const CONNECTED_FRAME_BYTES = Buffer.byteLength(CONNECTED_FRAME);
const DEFAULT_MAX_CLIENT_BUFFER_BYTES = 64 * 1_024;

function writePlain(response: ServerResponse, status: number, message: string): void {
  const bytes = Buffer.from(message, "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(bytes.byteLength),
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function normalizePrefix(prefix: string): string {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(prefix)) {
    throw new OutputConfigError("output.live2d-server", "Live2D request prefix is invalid");
  }
  return prefix;
}

function validateModelName(modelName: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(modelName)) {
    throw new OutputConfigError(
      "output.live2d-server",
      "Live2D model name must contain only letters, digits, underscores, or hyphens",
    );
  }
  return modelName;
}

export class Live2dStaticServer implements Disposable {
  readonly #config: Live2dStaticServerConfig;
  readonly #dependencies: Live2dStaticServerDependencies;
  readonly #clients = new Set<ServerResponse>();
  #server: Server | undefined;
  #root: string | undefined;
  #origin: string | undefined;
  #modelName = "Hiyori";
  #maxClientBufferBytes = DEFAULT_MAX_CLIENT_BUFFER_BYTES;

  constructor(
    config: Live2dStaticServerConfig,
    dependencies: Live2dStaticServerDependencies = {},
  ) {
    this.#config = config;
    this.#dependencies = dependencies;
  }

  get enabled(): boolean {
    return this.#config.enabled;
  }

  get origin(): string | undefined {
    return this.#origin;
  }

  async start(signal?: AbortSignal): Promise<string | undefined> {
    if (!this.#config.enabled) {
      return undefined;
    }
    if (this.#server !== undefined) {
      return this.#origin;
    }

    const component = "output.live2d-server";
    try {
      signal?.throwIfAborted();
      const rootDirectory = this.#config.rootDirectory?.trim();
      if (rootDirectory === undefined || rootDirectory.length === 0) {
        throw new OutputConfigError(component, "Live2D is enabled but its static root is missing");
      }
      const root = await realpath(resolve(rootDirectory));
      const rootInfo = await stat(root);
      if (!rootInfo.isDirectory()) {
        throw new OutputPathError(component, "Live2D static root is not a directory");
      }

      const port = this.#config.port ?? 12_345;
      if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
        throw new OutputConfigError(component, "Live2D port must be an integer from 0 through 65535");
      }
      const maxClientBufferBytes = this.#config.maxClientBufferBytes
        ?? DEFAULT_MAX_CLIENT_BUFFER_BYTES;
      if (!Number.isSafeInteger(maxClientBufferBytes) || maxClientBufferBytes <= 0) {
        throw new OutputConfigError(
          component,
          "Live2D client buffer limit must be a positive integer",
        );
      }
      this.#maxClientBufferBytes = maxClientBufferBytes;
      const host = this.#config.host?.trim() || "127.0.0.1";
      const modelName = validateModelName(this.#config.modelName?.trim() || "Hiyori");
      let modelDirectory: string;
      let modelDefinition: string;
      try {
        modelDirectory = await realpath(resolve(root, "live2d-model", modelName));
        modelDefinition = await realpath(resolve(modelDirectory, `${modelName}.model3.json`));
      } catch {
        throw new OutputConfigError(component, `Live2D model "${modelName}" is unavailable`);
      }
      if (
        !contained(root, modelDirectory)
        || !contained(modelDirectory, modelDefinition)
        || !(await stat(modelDirectory)).isDirectory()
        || !(await stat(modelDefinition)).isFile()
      ) {
        throw new OutputConfigError(component, `Live2D model "${modelName}" is unavailable`);
      }
      this.#modelName = modelName;
      this.#root = root;
      const server = createServer((request, response) => {
        void this.handleRequest(request, response).catch((cause: unknown) => {
          const error = asOutputBridgeError(component, cause, "Live2D request handling failed");
          publishOutputFailure(this.#dependencies.publisher, error, this.#dependencies.clock);
          if (!response.headersSent) {
            writePlain(response, 500, "Internal Server Error");
          } else {
            response.destroy();
          }
        });
      });
      this.#server = server;

      await new Promise<void>((accept, reject) => {
        const onError = (cause: Error): void => {
          server.off("listening", onListening);
          reject(cause);
        };
        const onListening = (): void => {
          server.off("error", onError);
          accept();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });

      const address = server.address() as AddressInfo | string | null;
      if (address === null || typeof address === "string") {
        throw new OutputConfigError(component, "Live2D server did not bind a TCP address");
      }
      const displayHost = address.address === "::" || address.address === "0.0.0.0"
        ? "127.0.0.1"
        : address.address.includes(":")
          ? `[${address.address}]`
          : address.address;
      this.#origin = `http://${displayHost}:${address.port}`;
      this.#dependencies.publisher?.publish({
        type: "system.status",
        component,
        status: "ready",
        message: "Live2D static server is ready",
        metadata: { url: `${this.#origin}/Live2D/` },
        timestamp: (this.#dependencies.clock ?? Date.now)(),
      });
      return this.#origin;
    } catch (cause) {
      await this.#closeServer();
      const error = asOutputBridgeError(component, cause, "Live2D static server failed to start");
      publishOutputFailure(this.#dependencies.publisher, error, this.#dependencies.clock);
      throw error;
    }
  }

  publishMessage(message: string, duration = 2_000): void {
    if (!this.#config.enabled) {
      return;
    }
    const maxMessageLength = this.#config.maxMessageLength ?? 4_096;
    if (message.length === 0 || message.length > maxMessageLength) {
      throw new OutputConfigError(
        "output.live2d-server",
        `Live2D message length must be between 1 and ${maxMessageLength}`,
      );
    }
    if (!Number.isSafeInteger(duration) || duration < 100 || duration > 60_000) {
      throw new OutputConfigError(
        "output.live2d-server",
        "Live2D message duration must be an integer from 100 through 60000 milliseconds",
      );
    }

    const payload: Live2dMessage = { type: "message", message, duration };
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    const frameBytes = Buffer.byteLength(frame);
    for (const client of this.#clients) {
      this.#writeEventFrame(client, frame, frameBytes);
    }
  }

  async dispose(): Promise<void> {
    for (const client of this.#clients) {
      client.end();
    }
    this.#clients.clear();
    await this.#closeServer();
    if (this.#config.enabled) {
      this.#dependencies.publisher?.publish({
        type: "system.status",
        component: "output.live2d-server",
        status: "stopped",
        message: "Live2D static server stopped",
        timestamp: (this.#dependencies.clock ?? Date.now)(),
      });
    }
  }

  #writeEventFrame(client: ServerResponse, frame: string, frameBytes: number): void {
    const writableLength = client.writableLength;
    if (
      client.destroyed
      || client.writableEnded
      || writableLength > this.#maxClientBufferBytes
      || frameBytes > this.#maxClientBufferBytes - writableLength
    ) {
      this.#evictClient(client);
      return;
    }

    try {
      client.write(frame);
    } catch {
      this.#evictClient(client);
      return;
    }
    if (client.writableLength > this.#maxClientBufferBytes) {
      this.#evictClient(client);
    }
  }

  #evictClient(client: ServerResponse): void {
    this.#clients.delete(client);
    if (!client.destroyed) {
      client.destroy();
    }
  }

  async #closeServer(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#origin = undefined;
    if (server === undefined) {
      return;
    }
    if (!server.listening) {
      server.close();
      return;
    }
    await new Promise<void>((accept) => {
      server.close(() => accept());
    });
  }

  async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    prefix = "/Live2D/",
  ): Promise<void> {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      writePlain(response, 405, "Method Not Allowed");
      return;
    }

    const normalizedPrefix = normalizePrefix(prefix);
    const rawTarget = (request.url ?? "/").split("?", 1)[0] ?? "/";
    let pathname: string;
    try {
      pathname = decodeURIComponent(rawTarget);
    } catch {
      writePlain(response, 400, "Bad Request");
      return;
    }
    if (pathname.includes("\0") || pathname.includes("\\")) {
      writePlain(response, 400, "Bad Request");
      return;
    }
    if (pathname === normalizedPrefix.slice(0, -1)) {
      response.writeHead(308, { location: normalizedPrefix });
      response.end();
      return;
    }
    if (pathname === `${normalizedPrefix}events`) {
      if (method === "HEAD") {
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        response.end();
      } else {
        this.#openEventStream(request, response);
      }
      return;
    }
    if (!pathname.startsWith(normalizedPrefix)) {
      writePlain(response, 404, "Not Found");
      return;
    }

    const segments = pathname.slice(normalizedPrefix.length).split("/");
    if (segments.some((segment) => segment === ".." || segment === ".")) {
      writePlain(response, 403, "Forbidden");
      return;
    }
    const relativePath = segments.filter((segment) => segment.length > 0).join("/") || "index.html";
    if (relativePath === "js/model_name.js") {
      const body = Buffer.from(`window.model_name=${JSON.stringify(this.#modelName)};\n`, "utf8");
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": String(body.byteLength),
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(method === "HEAD" ? undefined : body);
      return;
    }

    const root = this.#root;
    if (root === undefined) {
      writePlain(response, 503, "Service Unavailable");
      return;
    }
    let candidate: string;
    try {
      candidate = await realpath(resolve(root, relativePath));
    } catch {
      writePlain(response, 404, "Not Found");
      return;
    }
    if (!contained(root, candidate)) {
      writePlain(response, 403, "Forbidden");
      return;
    }

    let info = await stat(candidate);
    if (info.isDirectory()) {
      try {
        candidate = await realpath(resolve(candidate, "index.html"));
        info = await stat(candidate);
      } catch {
        writePlain(response, 404, "Not Found");
        return;
      }
      if (!contained(root, candidate)) {
        writePlain(response, 403, "Forbidden");
        return;
      }
    }
    if (!info.isFile()) {
      writePlain(response, 404, "Not Found");
      return;
    }

    const contentType = CONTENT_TYPES[extname(candidate).toLowerCase()] ?? "application/octet-stream";
    response.writeHead(200, {
      "cache-control": candidate.endsWith(`${sep}index.html`) ? "no-cache" : "public, max-age=3600",
      "content-length": String(info.size),
      "content-type": contentType,
    });
    if (method === "HEAD") {
      response.end();
      return;
    }
    await new Promise<void>((accept, reject) => {
      const stream = createReadStream(candidate);
      stream.once("error", reject);
      response.once("close", accept);
      response.once("finish", accept);
      stream.pipe(response);
    });
  }

  #openEventStream(request: IncomingMessage, response: ServerResponse): void {
    const maxClients = this.#config.maxClients ?? 32;
    if (!Number.isSafeInteger(maxClients) || maxClients <= 0 || this.#clients.size >= maxClients) {
      writePlain(response, 503, "Live2D event stream is unavailable");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    });
    const removeClient = (): void => {
      this.#clients.delete(response);
    };
    request.once("close", removeClient);
    response.once("close", removeClient);
    response.once("error", removeClient);
    this.#clients.add(response);
    this.#writeEventFrame(response, CONNECTED_FRAME, CONNECTED_FRAME_BYTES);
  }
}
