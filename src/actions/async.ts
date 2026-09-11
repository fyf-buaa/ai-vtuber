import {
  ActionAbortedError,
  ActionTimeoutError,
} from "./errors.js";

export interface ActionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemActionClock: ActionClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface DeadlineOptions {
  readonly operation: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly clock?: ActionClock;
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  operation: string,
): void {
  if (signal?.aborted === true) {
    throw new ActionAbortedError(operation, { cause: signal.reason });
  }
}

export async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  const { operation, signal } = options;
  const timeoutMs = options.timeoutMs;
  const clock = options.clock ?? systemActionClock;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  throwIfAborted(signal, operation);

  const controller = new AbortController();
  let timeoutHandle: unknown;
  let removeExternalAbort: (() => void) | undefined;

  const { promise: cancellation, reject } = Promise.withResolvers<never>();
  const abortFromCaller = (): void => {
    const error = new ActionAbortedError(operation, { cause: signal?.reason });
    controller.abort(error);
    reject(error);
  };

  if (signal !== undefined) {
    signal.addEventListener("abort", abortFromCaller, { once: true });
    removeExternalAbort = () => {
      signal.removeEventListener("abort", abortFromCaller);
    };
  }

  timeoutHandle = clock.setTimeout(() => {
    const error = new ActionTimeoutError(operation, timeoutMs);
    controller.abort(error);
    reject(error);
  }, timeoutMs);

  try {
    return await Promise.race([run(controller.signal), cancellation]);
  } finally {
    if (timeoutHandle !== undefined) {
      clock.clearTimeout(timeoutHandle);
    }
    removeExternalAbort?.();
  }
}

export function abortReason(
  signal: AbortSignal,
  operation: string,
): ActionAbortedError | ActionTimeoutError {
  if (signal.reason instanceof ActionTimeoutError) {
    return signal.reason;
  }
  if (signal.reason instanceof ActionAbortedError) {
    return signal.reason;
  }
  return new ActionAbortedError(operation, { cause: signal.reason });
}
