import { randomUUID } from "node:crypto";
import {
  constants,
  createWriteStream,
  type BigIntStats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  LocalAudioLibrary,
  type LocalAudioDescriptor,
} from "../core/local-audio.js";
import type {
  AppEvent,
  EventPublisher,
  LocalAudioRequest,
  SpeechRequest,
  SpeechStatus,
} from "../domain/types.js";
import type {
  SpeechEnqueueOptions,
  SpeechService,
} from "../core/contracts.js";
import {
  abortReason,
  SpeechCancelledError,
  SpeechCapacityError,
  SpeechServiceStoppedError,
  SpeechTimeoutError,
  errorMessage,
  throwIfAborted,
} from "./errors.js";
import type {
  AudioArtifact,
  AudioPostProcessor,
  AudioSink,
  SpeechAudioContext,
  SpeechSynthesizer,
  SpeechPriorityMapping,
  SpeechTextSplitOptions,
  SynthesizedAudio,
} from "./types.js";

const DEFAULT_MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_TEXT_SPLIT: SpeechTextSplitOptions = Object.freeze({
  enabled: false,
  intervalNumMin: 1,
  intervalNumMax: 1,
  normalIntervalMinMs: 0,
  normalIntervalMaxMs: 0,
});
const SENTENCE_ENDINGS: Readonly<Record<string, true>> = {
  ".": true,
  "!": true,
  "?": true,
  ";": true,
  "。": true,
  "！": true,
  "？": true,
  "；": true,
};
const SENTENCE_CLOSERS: Readonly<Record<string, true>> = {
  "\"": true,
  "'": true,
  ")": true,
  "]": true,
  "}": true,
  "）": true,
  "】": true,
  "》": true,
  "”": true,
  "’": true,
  "」": true,
  "』": true,
};

type QueueItemStage = "waiting" | "queued" | "active" | "terminal";

interface QueueItemBase {
  readonly id: string;
  readonly priority: number;
  readonly signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  stage: QueueItemStage;
}

interface SynthesizedQueueItem extends QueueItemBase {
  readonly kind: "synthesized";
  readonly request: SpeechRequest;
}

interface LocalAudioQueueItem extends QueueItemBase {
  readonly kind: "local-audio";
  readonly request: LocalAudioRequest;
}

type QueueItem = SynthesizedQueueItem | LocalAudioQueueItem;

function isTerminalQueueItem(
  item: QueueItem,
): item is QueueItem & { stage: "terminal" } {
  return item.stage === "terminal";
}

function isAbortedSignal(
  signal: AbortSignal | undefined,
): signal is AbortSignal & { readonly aborted: true } {
  return signal?.aborted === true;
}

type QueueRequest =
  | {
      readonly kind: "synthesized";
      readonly request: SpeechRequest;
    }
  | {
      readonly kind: "local-audio";
      readonly request: LocalAudioRequest;
    };

interface AdmissionWaiter {
  readonly item: QueueItem;
  readonly resolve: (id: string) => void;
  readonly reject: (error: unknown) => void;
}

interface AudioByteBudget {
  readonly limit: number;
  remaining: number;
}

export interface QueuedSpeechServiceOptions {
  readonly synthesizer: SpeechSynthesizer;
  readonly sink: AudioSink;
  readonly publisher: EventPublisher;
  readonly queueCapacity: number;
  readonly admissionWaiterCapacity?: number;
  readonly queueStartThreshold?: number;
  readonly priorityMapping?: SpeechPriorityMapping;
  readonly requestTimeoutMs: number;
  readonly maxAudioBytes?: number;
  readonly localAudioRoot: string;
  readonly textSplit?: SpeechTextSplitOptions;
  readonly waitForGap?: (
    durationMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly outputDirectory: string;
  readonly temporaryDirectory: string;
  readonly preserveOutput: boolean;
  readonly postProcessors?: readonly AudioPostProcessor[];
  readonly idFactory?: () => string;
  readonly clock?: () => number;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function safeExtension(value: string): string {
  const extension = value.replace(/^\./u, "").toLowerCase();
  if (!/^[a-z0-9]{2,8}$/u.test(extension)) {
    throw new Error(`Synthesizer returned unsafe audio extension ${JSON.stringify(value)}`);
  }
  return extension;
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function normalizedRequest(request: SpeechRequest): SpeechRequest {
  if (typeof request.text !== "string" || request.text.trim().length === 0) {
    throw new TypeError("Speech request text must not be empty");
  }
  if (
    request.outputPath !== undefined &&
    (typeof request.outputPath !== "string" || request.outputPath.trim().length === 0)
  ) {
    throw new TypeError("Speech request outputPath must be a non-empty string");
  }

  return Object.freeze({
    text: request.text,
    ...(request.sourceEventId === undefined
      ? {}
      : { sourceEventId: request.sourceEventId }),
    ...(request.outputPath === undefined
      ? {}
      : { outputPath: request.outputPath }),
    ...(request.metadata === undefined
      ? {}
      : { metadata: Object.freeze({ ...request.metadata }) }),
  });
}

function normalizedLocalAudioRequest(
  request: LocalAudioRequest,
  localAudioRoot: string,
): LocalAudioRequest {
  const normalized = normalizedRequest(request);
  if (
    typeof request.audioPath !== "string" ||
    request.audioPath.trim().length === 0
  ) {
    throw new TypeError("Local audio request audioPath must be a non-empty string");
  }
  if (request.audioPath.includes("\0")) {
    throw new TypeError("Local audio request audioPath must not contain NUL bytes");
  }
  if (!isAbsolute(request.audioPath)) {
    throw new TypeError("Local audio request audioPath must be absolute");
  }
  const audioPath = resolve(request.audioPath);
  if (!isPathWithin(localAudioRoot, audioPath)) {
    throw new TypeError("Local audio request audioPath must be inside the configured root");
  }
  return Object.freeze({
    ...normalized,
    audioPath,
  });
}

function unchangedFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function validatedTextSplitOptions(
  configured: SpeechTextSplitOptions | undefined,
): SpeechTextSplitOptions {
  const value = configured ?? DEFAULT_TEXT_SPLIT;
  if (!Number.isSafeInteger(value.intervalNumMin) || value.intervalNumMin < 1) {
    throw new RangeError("Speech text split intervalNumMin must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(value.intervalNumMax) ||
    value.intervalNumMax < value.intervalNumMin ||
    value.intervalNumMax > 10_000
  ) {
    throw new RangeError(
      "Speech text split intervalNumMax must be between intervalNumMin and 10000",
    );
  }
  if (
    !Number.isSafeInteger(value.normalIntervalMinMs) ||
    value.normalIntervalMinMs < 0 ||
    value.normalIntervalMinMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      "Speech text split normalIntervalMinMs must be a non-negative timer-safe integer",
    );
  }
  if (
    !Number.isSafeInteger(value.normalIntervalMaxMs) ||
    value.normalIntervalMaxMs < value.normalIntervalMinMs ||
    value.normalIntervalMaxMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      "Speech text split normalIntervalMaxMs must be a timer-safe integer at least normalIntervalMinMs",
    );
  }

  return Object.freeze({ ...value });
}

function validatedPriorityMapping(
  configured: SpeechPriorityMapping | undefined,
): SpeechPriorityMapping {
  const mapping = Object.create(null) as Record<string, number>;
  for (const [configuredKey, priority] of Object.entries(configured ?? {})) {
    const key = configuredKey.trim().toLowerCase();
    if (key.length === 0 || !Number.isSafeInteger(priority)) {
      throw new RangeError(
        "Speech priority mapping keys must be non-empty and values must be safe integers",
      );
    }
    mapping[key] = priority;
  }
  return Object.freeze(mapping);
}

function deterministicInteger(minimum: number, maximum: number, seed: string): number {
  if (minimum === maximum) {
    return minimum;
  }

  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return minimum + ((hash >>> 0) % (maximum - minimum + 1));
}

function punctuationIsInsideToken(text: string, index: number): boolean {
  const punctuation = text[index];
  const previous = index > 0 ? text[index - 1] : undefined;
  const next = index + 1 < text.length ? text[index + 1] : undefined;
  if (
    punctuation === "." &&
    previous !== undefined &&
    next !== undefined &&
    /[0-9]/u.test(previous) &&
    /[0-9]/u.test(next)
  ) {
    return true;
  }
  if (
    punctuation === "." &&
    previous !== undefined &&
    next !== undefined &&
    /[A-Za-z0-9]/u.test(previous) &&
    /[A-Za-z0-9]/u.test(next)
  ) {
    return true;
  }

  let tokenStart = index;
  while (tokenStart > 0 && !/\s/u.test(text[tokenStart - 1] ?? "")) {
    tokenStart -= 1;
  }
  const tokenPrefix = text.slice(tokenStart, index);
  const isUrl = /(?:https?:\/\/|www\.)\S*$/iu.test(tokenPrefix);
  return isUrl && next !== undefined && !/\s/u.test(next);
}

function sentenceParts(text: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (character === "\r" || character === "\n") {
      let end = index + 1;
      if (character === "\r" && text[end] === "\n") {
        end += 1;
      }
      const part = text.slice(start, end);
      if (part.trim().length > 0) {
        parts.push(part);
      }
      start = end;
      index = end;
      continue;
    }

    if (
      character === undefined ||
      SENTENCE_ENDINGS[character] !== true ||
      punctuationIsInsideToken(text, index)
    ) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < text.length && SENTENCE_ENDINGS[text[end] ?? ""] === true) {
      end += 1;
    }
    while (end < text.length && SENTENCE_CLOSERS[text[end] ?? ""] === true) {
      end += 1;
    }
    while (end < text.length && /[\t ]/u.test(text[end] ?? "")) {
      end += 1;
    }
    const part = text.slice(start, end);
    if (part.trim().length > 0) {
      parts.push(part);
    }
    start = end;
    index = end;
  }

  const remainder = text.slice(start);
  if (remainder.trim().length > 0) {
    parts.push(remainder);
  }
  return parts;
}

function splitSpeechText(
  text: string,
  options: SpeechTextSplitOptions,
): readonly string[] {
  if (!options.enabled) {
    return [text];
  }

  const sentences = sentenceParts(text);
  if (sentences.length < 2) {
    return [text];
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < sentences.length) {
    const groupSize = deterministicInteger(
      options.intervalNumMin,
      options.intervalNumMax,
      `group:${chunks.length}:${text}`,
    );
    const chunk = sentences.slice(cursor, cursor + groupSize).join("").trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    cursor += groupSize;
  }
  return chunks.length > 0 ? chunks : [text];
}

async function waitForAbortableDelay(
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, "Speech chunk gap was cancelled");
  if (durationMs === 0) {
    return;
  }

  await new Promise<void>((resolveDelay, rejectDelay) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, durationMs);
    timeout.unref();

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      rejectDelay(abortReason(signal, "Speech chunk gap was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function awaitWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  fallback: string,
): Promise<T> {
  throwIfAborted(signal, fallback);
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rejectOperation(abortReason(signal, fallback));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolveOperation(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        rejectOperation(error);
      },
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

async function* boundedAudioStream(
  stream: AsyncIterable<Uint8Array>,
  budget: AudioByteBudget,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) {
    throwIfAborted(signal, "Speech audio write was cancelled");
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("Speech synthesizer stream must yield Uint8Array chunks");
    }
    if (chunk.byteLength > budget.remaining) {
      throw new Error(
        `Synthesized audio exceeds the configured ${budget.limit} byte limit`,
      );
    }
    budget.remaining -= chunk.byteLength;
    yield chunk;
  }
}

export class QueuedSpeechService implements SpeechService {
  readonly #synthesizer: SpeechSynthesizer;
  readonly #sink: AudioSink;
  readonly #publisher: EventPublisher;
  readonly #queueCapacity: number;
  readonly #admissionWaiterCapacity: number;
  readonly #queueStartThreshold: number;
  readonly #priorityMapping: SpeechPriorityMapping;
  readonly #requestTimeoutMs: number;
  readonly #maxAudioBytes: number;
  readonly #localAudioRoot: string;
  readonly #localAudioLibrary: LocalAudioLibrary;
  readonly #textSplit: SpeechTextSplitOptions;
  readonly #waitForGap: (
    durationMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly #outputDirectory: string;
  readonly #temporaryDirectory: string;
  readonly #preserveOutput: boolean;
  readonly #postProcessors: readonly AudioPostProcessor[];
  readonly #idFactory: () => string;
  readonly #clock: () => number;

  readonly #queue: QueueItem[] = [];
  readonly #admissionWaiters: AdmissionWaiter[] = [];
  #state: SpeechStatus["state"] = "idle";
  #active: QueueItem | undefined;
  #activeController: AbortController | undefined;
  #worker: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(options: QueuedSpeechServiceOptions) {
    if (
      !Number.isSafeInteger(options.queueCapacity) ||
      options.queueCapacity < 1 ||
      options.queueCapacity > 100_000
    ) {
      throw new RangeError(
        "Speech queue capacity must be an integer between 1 and 100000",
      );
    }
    const queueStartThreshold = options.queueStartThreshold ?? 0;
    if (
      !Number.isSafeInteger(queueStartThreshold) ||
      queueStartThreshold < 0 ||
      queueStartThreshold > options.queueCapacity
    ) {
      throw new RangeError(
        "Speech queue start threshold must be between zero and queue capacity",
      );
    }
    const admissionWaiterCapacity =
      options.admissionWaiterCapacity ?? options.queueCapacity;
    if (
      !Number.isSafeInteger(admissionWaiterCapacity) ||
      admissionWaiterCapacity < 0 ||
      admissionWaiterCapacity > 100_000
    ) {
      throw new RangeError(
        "Speech admission waiter capacity must be an integer between 0 and 100000",
      );
    }
    if (
      !Number.isSafeInteger(options.requestTimeoutMs) ||
      options.requestTimeoutMs < 1 ||
      options.requestTimeoutMs > MAX_TIMER_DELAY_MS
    ) {
      throw new RangeError(
        "Speech request timeout must be a positive timer-safe integer",
      );
    }
    const maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    if (
      !Number.isSafeInteger(maxAudioBytes) ||
      maxAudioBytes < 1 ||
      maxAudioBytes > 1024 * 1024 * 1024
    ) {
      throw new RangeError(
        "Speech maxAudioBytes must be between 1 and 1073741824",
      );
    }
    if (
      typeof options.localAudioRoot !== "string" ||
      options.localAudioRoot.trim().length === 0 ||
      options.localAudioRoot.includes("\0")
    ) {
      throw new TypeError(
        "Speech localAudioRoot must be a non-empty path without NUL bytes",
      );
    }

    this.#synthesizer = options.synthesizer;
    this.#sink = options.sink;
    this.#publisher = options.publisher;
    this.#queueCapacity = options.queueCapacity;
    this.#admissionWaiterCapacity = admissionWaiterCapacity;
    this.#queueStartThreshold = queueStartThreshold;
    this.#priorityMapping = validatedPriorityMapping(options.priorityMapping);
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#maxAudioBytes = maxAudioBytes;
    this.#localAudioRoot = resolve(options.localAudioRoot);
    this.#localAudioLibrary = new LocalAudioLibrary(this.#localAudioRoot, {
      maxFileBytes: maxAudioBytes,
    });
    this.#textSplit = validatedTextSplitOptions(options.textSplit);
    this.#waitForGap = options.waitForGap ?? waitForAbortableDelay;
    this.#outputDirectory = resolve(options.outputDirectory);
    this.#temporaryDirectory = resolve(options.temporaryDirectory);
    this.#preserveOutput = options.preserveOutput;
    this.#postProcessors = [...(options.postProcessors ?? [])];
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#clock = options.clock ?? Date.now;
  }

  async enqueue(
    request: SpeechRequest,
    options: SpeechEnqueueOptions = {},
  ): Promise<string> {
    return await this.#enqueueRequest(
      { kind: "synthesized", request },
      options,
    );
  }

  async enqueueAudio(
    request: LocalAudioRequest,
    options: SpeechEnqueueOptions = {},
  ): Promise<string> {
    return await this.#enqueueRequest(
      { kind: "local-audio", request },
      options,
    );
  }

  #enqueueRequest(
    submission: QueueRequest,
    options: SpeechEnqueueOptions,
  ): Promise<string> {
    if (this.#state === "stopping" || this.#state === "stopped") {
      throw new SpeechServiceStoppedError();
    }

    const signal = options.signal;
    if (signal !== undefined) {
      throwIfAborted(signal, "Speech request was cancelled before admission");
    }
    let item: QueueItem;
    if (submission.kind === "local-audio") {
      const normalized = normalizedLocalAudioRequest(
        submission.request,
        this.#localAudioRoot,
      );
      item = {
        kind: "local-audio",
        id: this.#newSpeechId(),
        request: normalized,
        priority: this.#requestPriority(normalized),
        signal,
        abortListener: undefined,
        stage: "waiting",
      };
    } else {
      const normalized = normalizedRequest(submission.request);
      item = {
        kind: "synthesized",
        id: this.#newSpeechId(),
        request: normalized,
        priority: this.#requestPriority(normalized),
        signal,
        abortListener: undefined,
        stage: "waiting",
      };
    }

    if (this.#queue.length >= this.#queueCapacity) {
      const lowestQueued = this.#queue[this.#queue.length - 1];
      if (
        lowestQueued !== undefined &&
        item.priority > lowestQueued.priority
      ) {
        this.#evictQueuedItem(lowestQueued);
      } else if (
        lowestQueued !== undefined &&
        item.priority < lowestQueued.priority
      ) {
        throw new SpeechCapacityError(this.#queueCapacity);
      } else if (
        this.#admissionWaiters.length >= this.#admissionWaiterCapacity
      ) {
        throw new SpeechCapacityError(this.#admissionWaiterCapacity);
      }
    }

    return new Promise<string>((resolveAdmission, rejectAdmission) => {
      const waiter: AdmissionWaiter = {
        item,
        resolve: resolveAdmission,
        reject: rejectAdmission,
      };
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.#cancelItem(
            item,
            abortReason(signal, `Speech request ${item.id} was cancelled`),
          );
        };
        item.abortListener = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#insertAdmissionWaiter(waiter);
      if (signal?.aborted === true) {
        this.#cancelItem(
          item,
          abortReason(signal, `Speech request ${item.id} was cancelled`),
        );
        return;
      }
      this.#admitWaitingRequests();
    });
  }

  status(): SpeechStatus {
    return {
      state: this.#state,
      queued: this.#queue.length,
      ...(this.#active === undefined ? {} : { activeId: this.#active.id }),
    };
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") {
      return;
    }
    if (this.#stopPromise === undefined) {
      this.#stopPromise = this.#performStop();
    }
    await this.#stopPromise;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  #newSpeechId(): string {
    const id = this.#idFactory();
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
      throw new Error(
        "Speech id factory must return 1-128 ASCII letters, digits, underscores, or hyphens",
      );
    }
    return id;
  }

  #publish(event: AppEvent): void {
    this.#publisher.publish(event);
  }

  #detachAbortListener(item: QueueItem): void {
    if (item.signal !== undefined && item.abortListener !== undefined) {
      item.signal.removeEventListener("abort", item.abortListener);
      item.abortListener = undefined;
    }
  }

  #finishItem(item: QueueItem): void {
    item.stage = "terminal";
    this.#detachAbortListener(item);
  }

  #requestPriority(request: SpeechRequest): number {
    for (const key of ["chatType", "eventType", "source"] as const) {
      const value = request.metadata?.[key];
      if (typeof value !== "string") {
        continue;
      }
      const priority = this.#priorityMapping[value.trim().toLowerCase()];
      if (priority !== undefined) {
        return priority;
      }
    }
    return 0;
  }

  #insertQueueItem(item: QueueItem): void {
    const insertionIndex = this.#queue.findIndex(
      (queued) => queued.priority < item.priority,
    );
    if (insertionIndex < 0) {
      this.#queue.push(item);
    } else {
      this.#queue.splice(insertionIndex, 0, item);
    }
  }

  #insertAdmissionWaiter(waiter: AdmissionWaiter): void {
    const insertionIndex = this.#admissionWaiters.findIndex(
      (waiting) => waiting.item.priority < waiter.item.priority,
    );
    if (insertionIndex < 0) {
      this.#admissionWaiters.push(waiter);
    } else {
      this.#admissionWaiters.splice(insertionIndex, 0, waiter);
    }
  }

  #evictQueuedItem(item: QueueItem): void {
    const queueIndex = this.#queue.indexOf(item);
    if (queueIndex < 0) {
      return;
    }
    this.#queue.splice(queueIndex, 1);
    this.#finishItem(item);
    this.#publish({
      type: "speech.error",
      speechId: item.id,
      request: item.request,
      error: "Speech request was evicted by a higher-priority request",
      timestamp: this.#clock(),
    });
  }

  #cancelItem(item: QueueItem, cancellation: Error): void {
    if (item.stage === "terminal") {
      return;
    }

    if (item.stage === "waiting") {
      const waiterIndex = this.#admissionWaiters.findIndex(
        (waiter) => waiter.item === item,
      );
      if (waiterIndex < 0) {
        return;
      }
      const [waiter] = this.#admissionWaiters.splice(waiterIndex, 1);
      this.#finishItem(item);
      waiter?.reject(cancellation);
      this.#admitWaitingRequests();
      return;
    }

    if (item.stage === "queued") {
      const queueIndex = this.#queue.indexOf(item);
      if (queueIndex < 0) {
        return;
      }
      this.#queue.splice(queueIndex, 1);
      this.#finishItem(item);
      this.#publish({
        type: "speech.error",
        speechId: item.id,
        request: item.request,
        error: errorMessage(cancellation),
        timestamp: this.#clock(),
      });
      this.#admitWaitingRequests();
      return;
    }

    if (this.#active === item) {
      this.#activeController?.abort(cancellation);
    }
  }

  #admitWaitingRequests(): void {
    if (this.#state === "stopping" || this.#state === "stopped") {
      return;
    }

    while (
      this.#queue.length < this.#queueCapacity &&
      this.#admissionWaiters.length > 0
    ) {
      const waiter = this.#admissionWaiters.shift();
      if (waiter === undefined || waiter.item.stage !== "waiting") {
        continue;
      }
      if (waiter.item.signal?.aborted === true) {
        const cancellation = abortReason(
          waiter.item.signal,
          `Speech request ${waiter.item.id} was cancelled`,
        );
        this.#finishItem(waiter.item);
        waiter.reject(cancellation);
        continue;
      }

      waiter.item.stage = "queued";
      this.#insertQueueItem(waiter.item);
      try {
        this.#publish({
          type: "speech.queued",
          speechId: waiter.item.id,
          request: waiter.item.request,
          timestamp: this.#clock(),
        });
        waiter.resolve(waiter.item.id);
      } catch (error) {
        const queuedIndex = this.#queue.indexOf(waiter.item);
        if (queuedIndex >= 0) {
          this.#queue.splice(queuedIndex, 1);
        }
        if (!isTerminalQueueItem(waiter.item)) {
          this.#finishItem(waiter.item);
        }
        waiter.reject(error);
      }
    }

    if (this.#queue.length > 0) {
      this.#startWorker();
    }
  }

  #startWorker(): void {
    if (
      this.#worker !== undefined ||
      this.#state === "stopping" ||
      this.#state === "stopped"
    ) {
      return;
    }
    const minimumToStart = Math.max(1, this.#queueStartThreshold);
    if (this.#state === "idle" && this.#queue.length < minimumToStart) {
      return;
    }
    this.#state = "running";
    const worker = Promise.resolve().then(() => this.#drainQueue());
    this.#worker = worker;
    void worker.then(
      () => this.#workerFinished(worker),
      () => this.#workerFinished(worker),
    );
  }

  #workerFinished(worker: Promise<void>): void {
    if (this.#worker !== worker) {
      return;
    }
    this.#worker = undefined;
    if (this.#state === "stopping" || this.#state === "stopped") {
      return;
    }
    if (this.#queue.length > 0) {
      this.#startWorker();
    } else {
      this.#state = "idle";
    }
  }

  async #drainQueue(): Promise<void> {
    while (this.#state === "running") {
      const item = this.#queue.shift();
      if (item === undefined) {
        this.#state = "idle";
        return;
      }
      if (item.stage !== "queued") {
        continue;
      }
      if (item.signal?.aborted === true) {
        const cancellation = abortReason(
          item.signal,
          `Speech request ${item.id} was cancelled`,
        );
        this.#finishItem(item);
        this.#publish({
          type: "speech.error",
          speechId: item.id,
          request: item.request,
          error: errorMessage(cancellation),
          timestamp: this.#clock(),
        });
        this.#admitWaitingRequests();
        continue;
      }

      item.stage = "active";
      this.#active = item;
      const controller = new AbortController();
      this.#activeController = controller;
      const timeout = setTimeout(() => {
        controller.abort(new SpeechTimeoutError(this.#requestTimeoutMs));
      }, this.#requestTimeoutMs);
      timeout.unref();

      let terminalEvent: AppEvent;
      try {
        this.#publish({
          type: "speech.started",
          speechId: item.id,
          request: item.request,
          timestamp: this.#clock(),
        });
        this.#admitWaitingRequests();
        const itemSignal = item.signal;
        if (isAbortedSignal(itemSignal) && !controller.signal.aborted) {
          controller.abort(
            abortReason(itemSignal, `Speech request ${item.id} was cancelled`),
          );
        }

        const outputPath = await this.#executeItem(item, controller.signal);
        throwIfAborted(controller.signal, `Speech request ${item.id} was cancelled`);
        terminalEvent =
          outputPath === undefined
            ? {
                type: "speech.completed",
                speechId: item.id,
                request: item.request,
                timestamp: this.#clock(),
              }
            : {
                type: "speech.completed",
                speechId: item.id,
                request: item.request,
                outputPath,
                timestamp: this.#clock(),
              };
      } catch (error) {
        terminalEvent = {
          type: "speech.error",
          speechId: item.id,
          request: item.request,
          error: errorMessage(error),
          timestamp: this.#clock(),
        };
      } finally {
        clearTimeout(timeout);
        if (this.#active === item) {
          this.#active = undefined;
          this.#activeController = undefined;
        }
        this.#finishItem(item);
      }

      if (this.#state === "running" && this.#queue.length === 0) {
        this.#state = "idle";
      }
      this.#publish(terminalEvent);
    }
  }

  async #executeItem(
    item: QueueItem,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (item.kind === "local-audio") {
      return await this.#executeLocalAudio(item, signal);
    }
    return await this.#executeSynthesizedItem(item, signal);
  }

  async #executeSynthesizedItem(
    item: SynthesizedQueueItem,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const chunks = splitSpeechText(item.request.text, this.#textSplit);
    let firstOutputPath: string | undefined;
    const audioBudget: AudioByteBudget = {
      limit: this.#maxAudioBytes,
      remaining: this.#maxAudioBytes,
    };

    for (let index = 0; index < chunks.length; index += 1) {
      throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
      if (index > 0) {
        const gapMs = deterministicInteger(
          this.#textSplit.normalIntervalMinMs,
          this.#textSplit.normalIntervalMaxMs,
          `gap:${index}:${item.request.text}`,
        );
        await awaitWithAbort(
          this.#waitForGap(gapMs, signal),
          signal,
          `Speech request ${item.id} was cancelled during a chunk gap`,
        );
      }

      const chunkText = chunks[index];
      if (chunkText === undefined) {
        continue;
      }
      const chunkRequest: SpeechRequest = Object.freeze({
        ...item.request,
        text: chunkText,
      });
      const synthesized = await awaitWithAbort(
        this.#synthesizer.synthesize(chunkRequest, signal),
        signal,
        `Speech request ${item.id} was cancelled`,
      );
      throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
      if (synthesized === undefined) {
        return firstOutputPath;
      }

      const outputPath = await this.#executeChunk(
        item,
        chunkRequest,
        synthesized,
        index,
        chunks.length,
        audioBudget,
        this.#synthesizer.name,
        signal,
        undefined,
      );
      if (firstOutputPath === undefined && outputPath !== undefined) {
        firstOutputPath = outputPath;
      }
    }

    return firstOutputPath;
  }

  async #executeLocalAudio(
    item: LocalAudioQueueItem,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const descriptor = await this.#localAudioLibrary.resolve(
      item.request.audioPath,
      signal,
    );
    throwIfAborted(signal, `Speech request ${item.id} was cancelled`);

    const openFlags = constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    const handle = await open(descriptor.path, openFlags);
    let closePromise: Promise<void> | undefined;
    const closeHandle = (): Promise<void> => {
      closePromise ??= handle.close();
      return closePromise;
    };
    let operationError: unknown;
    let outputPath: string | undefined;

    try {
      throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
      const initialHandleStats = await handle.stat({ bigint: true });
      const initialPathStats = await lstat(descriptor.path, { bigint: true });
      const initialCanonical = await realpath(descriptor.path);
      throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
      this.#assertLocalAudioIdentity(
        descriptor,
        initialHandleStats,
        initialPathStats,
        initialCanonical,
      );

      const sourceStream = handle.createReadStream({
        autoClose: false,
        start: 0,
        end: descriptor.size - 1,
      });
      const audioBudget: AudioByteBudget = {
        limit: this.#maxAudioBytes,
        remaining: this.#maxAudioBytes,
      };
      outputPath = await this.#executeChunk(
        item,
        item.request,
        {
          extension: descriptor.extension,
          stream: sourceStream,
        },
        0,
        1,
        audioBudget,
        "local-audio",
        signal,
        async () => {
          throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
          const finalHandleStats = await handle.stat({ bigint: true });
          const finalPathStats = await lstat(descriptor.path, { bigint: true });
          const finalCanonical = await realpath(descriptor.path);
          throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
          this.#assertLocalAudioIdentity(
            descriptor,
            finalHandleStats,
            finalPathStats,
            finalCanonical,
            initialHandleStats,
          );
          await closeHandle();
        },
      );
    } catch (error) {
      operationError = error;
    }

    let closeError: unknown;
    try {
      await closeHandle();
    } catch (error) {
      closeError = error;
    }
    if (
      operationError !== undefined &&
      closeError !== undefined &&
      operationError !== closeError
    ) {
      throw new AggregateError(
        [operationError, closeError],
        `${errorMessage(operationError)}; local audio handle cleanup also failed: ${errorMessage(closeError)}`,
      );
    }
    if (operationError !== undefined) {
      throw operationError;
    }
    if (closeError !== undefined) {
      throw closeError;
    }
    return outputPath;
  }

  #assertLocalAudioIdentity(
    descriptor: LocalAudioDescriptor,
    handleStats: BigIntStats,
    pathStats: BigIntStats,
    canonicalPath: string,
    baseline?: BigIntStats,
  ): void {
    if (handleStats.size > BigInt(this.#maxAudioBytes)) {
      throw new Error(
        `Local audio exceeds the configured ${this.#maxAudioBytes} byte limit`,
      );
    }
    if (
      !handleStats.isFile() ||
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      handleStats.size !== BigInt(descriptor.size) ||
      handleStats.dev !== descriptor.identity.dev ||
      handleStats.ino !== descriptor.identity.ino ||
      handleStats.size !== descriptor.identity.size ||
      handleStats.mtimeNs !== descriptor.identity.mtimeNs ||
      handleStats.ctimeNs !== descriptor.identity.ctimeNs ||
      !unchangedFile(handleStats, pathStats) ||
      (baseline !== undefined && !unchangedFile(baseline, handleStats)) ||
      relative(resolve(descriptor.path), resolve(canonicalPath)) !== ""
    ) {
      throw new Error(
        `Local audio source changed after validation: ${descriptor.path}`,
      );
    }
  }

  async #executeChunk(
    item: QueueItem,
    chunkRequest: SpeechRequest,
    audio: SynthesizedAudio,
    chunkIndex: number,
    chunkCount: number,
    audioBudget: AudioByteBudget,
    producerName: string,
    signal: AbortSignal,
    afterWrite: (() => Promise<void>) | undefined,
  ): Promise<string | undefined> {
    const temporaryPaths = new Set<string>();
    let operationError: unknown;
    let outputPath: string | undefined;

    try {
      let artifact = await this.#writeAudioArtifact(
        item,
        audio,
        chunkIndex,
        chunkCount,
        audioBudget,
        producerName,
        signal,
        temporaryPaths,
      );
      if (afterWrite !== undefined) {
        await afterWrite();
      }
      const context: SpeechAudioContext = item.kind === "local-audio"
        ? {
            speechId: item.id,
            source: "local-audio",
            request: item.request,
          }
        : {
            speechId: item.id,
            source: "synthesized",
            request: chunkRequest,
          };
      let firstPermanentPath = artifact.temporary ? undefined : artifact.path;

      for (const processor of this.#postProcessors) {
        throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
        const processing = processor.process(artifact, context, signal);
        try {
          artifact = await awaitWithAbort(
            processing,
            signal,
            `Speech request ${item.id} was cancelled`,
          );
        } catch (error) {
          if (signal.aborted) {
            this.#reclaimLateArtifact(item, processing);
          }
          throw error;
        }
        if (this.#isOwnedTemporaryArtifact(item, artifact)) {
          temporaryPaths.add(resolve(artifact.path));
        }
        throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
        artifact = await this.#validatedArtifact(artifact);
        if (
          item.kind === "local-audio" &&
          relative(resolve(item.request.audioPath), artifact.path) === ""
        ) {
          throw new Error(
            "Audio post-processor returned the mutable local audio source path",
          );
        }
        if (!artifact.temporary && firstPermanentPath === undefined) {
          firstPermanentPath = artifact.path;
        }
      }

      const playback = this.#sink.play(artifact, context, signal);
      try {
        await awaitWithAbort(
          playback,
          signal,
          `Speech request ${item.id} was cancelled`,
        );
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
        let stopError: unknown;
        try {
          await this.#sink.stop();
        } catch (stopCause) {
          stopError = stopCause;
        }
        await playback.catch(() => undefined);
        if (stopError !== undefined) {
          throw new AggregateError(
            [error, stopError],
            `${errorMessage(error)}; audio playback stop also failed: ${errorMessage(stopError)}`,
          );
        }
        throw error;
      }
      throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
      outputPath = artifact.temporary ? firstPermanentPath : artifact.path;
    } catch (error) {
      operationError = error;
    }

    let cleanupError: unknown;
    try {
      await this.#removeTemporaryPaths(temporaryPaths);
    } catch (error) {
      cleanupError = error;
    }

    if (operationError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [operationError, cleanupError],
        `${errorMessage(operationError)}; temporary audio cleanup also failed: ${errorMessage(cleanupError)}`,
      );
    }
    if (operationError !== undefined) {
      throw operationError;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
    return outputPath;
  }

  async #writeAudioArtifact(
    item: QueueItem,
    audio: SynthesizedAudio,
    chunkIndex: number,
    chunkCount: number,
    audioBudget: AudioByteBudget,
    producerName: string,
    signal: AbortSignal,
    temporaryPaths: Set<string>,
  ): Promise<AudioArtifact> {
    const extension = safeExtension(audio.extension);
    const explicitlyPreserved = item.request.outputPath !== undefined;
    const temporary = !explicitlyPreserved && !this.#preserveOutput;
    const root = temporary ? this.#temporaryDirectory : this.#outputDirectory;
    const chunkSuffix = chunkCount === 1 ? "" : `-chunk-${chunkIndex + 1}`;
    let finalPath: string;

    if (item.request.outputPath === undefined) {
      const safeEngine =
        producerName
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/gu, "-")
          .replace(/^-+|-+$/gu, "") || "speech";
      finalPath = join(root, `${safeEngine}-${item.id}${chunkSuffix}.${extension}`);
    } else {
      const requested = item.request.outputPath;
      const candidate = isAbsolute(requested)
        ? resolve(requested)
        : resolve(root, requested);
      const requestedExtension = extname(candidate);
      if (
        requestedExtension.length > 0 &&
        requestedExtension.slice(1).toLowerCase() !== extension
      ) {
        throw new Error(
          `Speech output extension ${JSON.stringify(requestedExtension)} does not match synthesized ${JSON.stringify(`.${extension}`)}`,
        );
      }
      const withoutExtension =
        requestedExtension.length === 0
          ? candidate
          : candidate.slice(0, -requestedExtension.length);
      finalPath = `${withoutExtension}${chunkSuffix}.${extension}`;
    }

    const normalizedRoot = resolve(root);
    finalPath = resolve(finalPath);
    if (!isPathWithin(normalizedRoot, finalPath)) {
      throw new Error(
        `Speech output path escapes configured output directory: ${item.request.outputPath ?? finalPath}`,
      );
    }

    await mkdir(dirname(finalPath), { recursive: true });
    const realRoot = await realpath(normalizedRoot);
    const realParent = await realpath(dirname(finalPath));
    if (!isPathWithin(realRoot, realParent)) {
      throw new Error(
        `Speech output parent resolves outside configured output directory: ${realParent}`,
      );
    }

    try {
      await lstat(finalPath);
      throw new Error(`Speech output path already exists: ${finalPath}`);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }

    throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
    const partialPath = `${finalPath}.part-${randomUUID()}`;
    temporaryPaths.add(partialPath);
    await pipeline(
      Readable.from(boundedAudioStream(audio.stream, audioBudget, signal)),
      createWriteStream(partialPath, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
    const partialStat = await lstat(partialPath);
    if (
      !partialStat.isFile() ||
      partialStat.isSymbolicLink() ||
      partialStat.size === 0
    ) {
      throw new Error("Speech synthesizer returned an empty or invalid audio stream");
    }
    if (partialStat.size > this.#maxAudioBytes) {
      throw new Error(
        `Synthesized audio exceeds the configured ${this.#maxAudioBytes} byte limit`,
      );
    }
    throwIfAborted(signal, `Speech request ${item.id} was cancelled`);
    await rename(partialPath, finalPath);
    temporaryPaths.delete(partialPath);
    if (temporary) {
      temporaryPaths.add(finalPath);
    }

    return {
      path: finalPath,
      format: extension,
      temporary,
    };
  }

  async #validatedArtifact(artifact: AudioArtifact): Promise<AudioArtifact> {
    if (!isAbsolute(artifact.path)) {
      throw new Error(
        `Audio post-processor returned a non-absolute path: ${artifact.path}`,
      );
    }
    const format = safeExtension(artifact.format);
    const normalizedPath = resolve(artifact.path);
    const fileStat = await lstat(normalizedPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size === 0) {
      throw new Error(
        `Audio post-processor returned an empty or invalid file: ${normalizedPath}`,
      );
    }
    return {
      path: normalizedPath,
      format,
      temporary: artifact.temporary,
    };
  }

  #isOwnedTemporaryArtifact(item: QueueItem, artifact: AudioArtifact): boolean {
    return artifact.temporary
      && isAbsolute(artifact.path)
      && (
        item.kind !== "local-audio"
        || relative(resolve(item.request.audioPath), resolve(artifact.path)) !== ""
      );
  }

  #reclaimLateArtifact(item: QueueItem, operation: Promise<AudioArtifact>): void {
    void operation.then(
      async (artifact) => {
        if (!this.#isOwnedTemporaryArtifact(item, artifact)) {
          return;
        }
        await this.#removeTemporaryPaths(new Set([resolve(artifact.path)]));
      },
      () => undefined,
    ).catch((error: unknown) => {
      try {
        this.#publish({
          type: "speech.error",
          speechId: item.id,
          request: item.request,
          error: `Late temporary audio cleanup failed: ${errorMessage(error)}`,
          timestamp: this.#clock(),
        });
      } catch {
        // The cleanup error was already made observable when publication succeeds.
      }
    });
  }

  async #removeTemporaryPaths(paths: ReadonlySet<string>): Promise<void> {
    const errors: unknown[] = [];
    for (const path of paths) {
      try {
        await rm(path, { force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to remove temporary speech audio");
    }
  }

  async #performStop(): Promise<void> {
    this.#state = "stopping";
    const cancellation = new SpeechCancelledError(
      "Speech request cancelled because the service is stopping",
    );
    const errors: unknown[] = [];

    for (const waiter of this.#admissionWaiters.splice(0)) {
      this.#finishItem(waiter.item);
      waiter.reject(cancellation);
    }
    for (const item of this.#queue.splice(0)) {
      this.#finishItem(item);
      try {
        this.#publish({
          type: "speech.error",
          speechId: item.id,
          request: item.request,
          error: cancellation.message,
          timestamp: this.#clock(),
        });
      } catch (error) {
        errors.push(error);
      }
    }
    this.#activeController?.abort(cancellation);

    try {
      await this.#sink.stop();
    } catch (error) {
      errors.push(error);
    }
    const worker = this.#worker;
    if (worker !== undefined) {
      try {
        await worker;
      } catch (error) {
        errors.push(error);
      }
    }

    for (const processor of [...this.#postProcessors].reverse()) {
      if (processor.dispose !== undefined) {
        try {
          await processor.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (this.#sink.dispose !== undefined) {
      try {
        await this.#sink.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    this.#state = "stopped";
    if (errors.length > 0) {
      throw new AggregateError(errors, "Speech service stopped with cleanup errors");
    }
  }
}
