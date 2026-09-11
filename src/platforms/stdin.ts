import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";

import type { EventSource, LiveEventHandler } from "../core/contracts.js";
import { normalizeLivePayload } from "./normalization.js";
import type { PlatformDependencies, PlatformErrorHandler } from "./types.js";
import { abortError, asError, isRecord, linkAbortSignal } from "./utilities.js";

export class StdinJsonLineSource implements EventSource {
  readonly name: string;

  readonly #input: Readable;
  readonly #now: () => number;
  readonly #onError: PlatformErrorHandler;
  readonly #controller = new AbortController();
  readonly #unlinkExternalSignal: () => void;

  #interface: Interface | undefined;
  #handler: LiveEventHandler | undefined;
  #processing = Promise.resolve();
  #started = false;

  constructor(
    platform = "talk",
    dependencies: PlatformDependencies = {},
  ) {
    this.name = platform;
    this.#input = dependencies.stdin ?? process.stdin;
    this.#now = dependencies.now ?? Date.now;
    this.#onError =
      dependencies.onError ??
      ((error) => console.error(`[${this.name}] ${error.message}`, error));
    this.#unlinkExternalSignal = linkAbortSignal(
      dependencies.signal,
      this.#controller,
    );
    this.#controller.signal.addEventListener(
      "abort",
      () => this.#interface?.close(),
      { once: true },
    );
  }

  async start(handler: LiveEventHandler): Promise<void> {
    if (this.#started) {
      throw new Error(`Event source "${this.name}" has already been started`);
    }
    if (this.#controller.signal.aborted) {
      throw abortError(this.#controller.signal.reason);
    }
    this.#started = true;
    this.#handler = handler;
    const lines = createInterface({ input: this.#input, terminal: false });
    this.#interface = lines;
    lines.on("line", (line) => {
      this.#processing = this.#processing
        .then(() => this.#processLine(line))
        .catch((error: unknown) => this.#onError(asError(error)));
    });
    lines.on("error", (error) => this.#onError(asError(error)));
  }

  async dispose(): Promise<void> {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new DOMException("Event source disposed", "AbortError"));
    }
    this.#interface?.close();
    await this.#processing;
    this.#unlinkExternalSignal();
  }

  async #processLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0 || this.#controller.signal.aborted) {
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new Error("stdin platform input must be one JSON value per line", {
        cause: error,
      });
    }
    const normalizedPayload =
      isRecord(payload) &&
      payload["type"] === undefined &&
      payload["event_type"] === undefined &&
      payload["eventType"] === undefined &&
      payload["cmd"] === undefined &&
      payload["Type"] === undefined &&
      payload["events"] === undefined
        ? { ...payload, type: "talk" }
        : payload;
    const handler = this.#handler;
    if (handler === undefined) {
      return;
    }
    for (const event of normalizeLivePayload(normalizedPayload, {
      platform: this.name,
      now: this.#now,
    })) {
      await handler(event);
    }
  }
}
