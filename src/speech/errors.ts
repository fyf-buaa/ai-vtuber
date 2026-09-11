export class SpeechConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpeechConfigurationError";
  }
}

export class SpeechServiceStoppedError extends Error {
  constructor(message = "Speech service is stopping or stopped") {
    super(message);
    this.name = "SpeechServiceStoppedError";
  }
}

export class SpeechCapacityError extends Error {
  readonly capacity: number;

  constructor(capacity: number, message?: string) {
    super(message ?? `Speech capacity is full (limit ${capacity})`);
    this.name = "SpeechCapacityError";
    this.capacity = capacity;
  }
}

export class SpeechCancelledError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AbortError";
  }
}

export class SpeechTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Speech request timed out after ${timeoutMs} ms`);
    this.name = "TimeoutError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

export function abortReason(signal: AbortSignal, fallback: string): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new SpeechCancelledError(fallback);
}

export function throwIfAborted(signal: AbortSignal, fallback: string): void {
  if (signal.aborted) {
    throw abortReason(signal, fallback);
  }
}
