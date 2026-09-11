import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { JsonObject } from "../config/config-store.js";
import type { ProcessedReply } from "../core/contracts.js";
import type { LiveEvent, LiveEventType } from "../domain/types.js";
import type { RuntimeLogger } from "./scheduler.js";

export interface ManualEventInput {
  readonly content: string;
  readonly type?: LiveEventType;
  readonly platform?: string;
  readonly username?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ManualRuntimeControls {
  start(): Promise<void>;
  stop(): Promise<void>;
  reload(): Promise<void>;
  restore(backupPath?: string): Promise<void>;
  requestRestart(): Promise<void>;
  updateConfig(config: JsonObject, expectedGeneration: number): Promise<number>;
  processEvent(
    event: LiveEvent,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProcessedReply | undefined>;
  status(): unknown | Promise<unknown>;
  submitManual(input: string | ManualEventInput | LiveEvent): Promise<unknown>;
}

export interface StdinManualInputOptions {
  readonly controls: ManualRuntimeControls;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly logger?: RuntimeLogger;
  readonly prompt?: string;
  readonly onEnd?: () => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface StdinManualInputStatus {
  readonly running: boolean;
  readonly processedLines: number;
}

export class StdinManualInput {
  readonly #controls: ManualRuntimeControls;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #logger: RuntimeLogger | undefined;
  readonly #prompt: string;
  readonly #onEnd: StdinManualInputOptions["onEnd"] | undefined;
  readonly #onError: StdinManualInputOptions["onError"] | undefined;

  #readline: ReadlineInterface | undefined;
  #loop: Promise<void> | undefined;
  #processedLines = 0;
  #stopping = false;

  constructor(options: StdinManualInputOptions) {
    this.#controls = options.controls;
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#logger = options.logger;
    this.#prompt = options.prompt ?? "> ";
    this.#onEnd = options.onEnd;
    this.#onError = options.onError;
  }

  status(): StdinManualInputStatus {
    return {
      running: this.#readline !== undefined,
      processedLines: this.#processedLines,
    };
  }

  async start(): Promise<void> {
    if (this.#readline !== undefined) {
      return;
    }

    this.#stopping = false;
    const readline = createInterface({
      input: this.#input,
      output: this.#output,
      terminal: Boolean((this.#output as NodeJS.WriteStream).isTTY),
      prompt: this.#prompt,
    });
    this.#readline = readline;
    readline.prompt();
    this.#loop = this.#readLines(readline);
  }

  async stop(): Promise<void> {
    const readline = this.#readline;
    const loop = this.#loop;
    if (readline === undefined) {
      return;
    }

    this.#stopping = true;
    this.#readline = undefined;
    this.#loop = undefined;
    readline.close();
    await loop;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  async #readLines(readline: ReadlineInterface): Promise<void> {
    try {
      for await (const line of readline) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          readline.prompt();
          continue;
        }
        try {
          await this.#handleLine(trimmed);
          this.#processedLines += 1;
        } catch (error) {
          this.#reportError(error);
          this.#writeResult({ error: errorMessage(error) });
        }
        if (this.#readline === readline) {
          readline.prompt();
        }
      }
      if (!this.#stopping && this.#onEnd !== undefined) {
        Promise.resolve(this.#onEnd()).catch((error: unknown) => {
          this.#reportError(error);
        });
      }
    } catch (error) {
      if (this.#stopping) {
        return;
      }
      this.#reportError(error);
    } finally {
      if (this.#readline === readline) {
        this.#readline = undefined;
        this.#loop = undefined;
      }
    }
  }

  async #handleLine(line: string): Promise<void> {
    const command = line.toLowerCase();
    switch (command) {
      case "/status":
        this.#writeResult(await this.#controls.status());
        return;
      case "/start":
        await this.#controls.start();
        this.#writeResult({ accepted: true, command: "start" });
        return;
      case "/reload":
        await this.#controls.reload();
        this.#writeResult({ accepted: true, command: "reload" });
        return;
      case "/restore":
        await this.#controls.restore();
        this.#writeResult({ accepted: true, command: "restore" });
        return;
      case "/restart":
        this.#writeResult({ accepted: true, command: "restart" });
        queueMicrotask(() => void this.#controls.requestRestart());
        return;
      case "/stop":
      case "/quit":
      case "/exit":
        this.#writeResult({ accepted: true, command: "stop" });
        queueMicrotask(() => void this.#controls.stop());
        return;
      default:
        break;
    }

    const input = parseManualInput(line);
    const reply = await this.#controls.submitManual(input);
    if (reply !== undefined) {
      this.#writeResult(reply);
    }
  }

  #writeResult(value: unknown): void {
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value, undefined, 2);
    this.#output.write(`${serialized}\n`);
  }

  #reportError(error: unknown): void {
    this.#logger?.error(`Manual stdin failed: ${errorMessage(error)}`, {
      error,
    });
    this.#onError?.(error);
  }
}

export function parseManualInput(line: string): string | ManualEventInput {
  if (!line.startsWith("{")) {
    return line;
  }

  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new SyntaxError("Manual JSON input is invalid", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Manual JSON input must be an object");
  }

  const input = value as Record<string, unknown>;
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new TypeError("Manual JSON input requires non-empty string content");
  }
  const type = input.type;
  if (type !== undefined && !isLiveEventType(type)) {
    throw new TypeError(`Unsupported manual event type: ${String(type)}`);
  }
  const metadata = input.metadata;
  if (
    metadata !== undefined &&
    (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
  ) {
    throw new TypeError("Manual JSON metadata must be an object");
  }

  return {
    content: input.content,
    ...(type === undefined ? {} : { type }),
    ...(typeof input.platform === "string"
      ? { platform: input.platform }
      : {}),
    ...(typeof input.username === "string"
      ? { username: input.username }
      : {}),
    ...(metadata === undefined
      ? {}
      : { metadata: metadata as Readonly<Record<string, unknown>> }),
  };
}

function isLiveEventType(value: unknown): value is LiveEventType {
  return (
    value === "comment" ||
    value === "gift" ||
    value === "entrance" ||
    value === "follow" ||
    value === "talk" ||
    value === "schedule" ||
    value === "idle" ||
    value === "image"
  );
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
