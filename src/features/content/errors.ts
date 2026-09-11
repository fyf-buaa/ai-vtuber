export type ContentServiceErrorCode =
  | "ABORTED"
  | "EMPTY_QUERY"
  | "HTTP_STATUS"
  | "INVALID_CONFIG"
  | "MALFORMED_RESPONSE"
  | "NETWORK_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT"
  | "UNSAFE_URL";

export type ContentServiceName = "online-search";

export class ContentServiceError extends Error {
  readonly code: ContentServiceErrorCode;
  readonly service: ContentServiceName;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    service: ContentServiceName,
    code: ContentServiceErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ContentServiceError";
    this.service = service;
    this.code = code;
    this.details = options.details ?? {};
  }
}

export function isContentServiceError(error: unknown): error is ContentServiceError {
  return error instanceof ContentServiceError;
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  service: ContentServiceName,
): void {
  if (signal?.aborted === true) {
    throw new ContentServiceError(service, "ABORTED", `${service} operation was cancelled`, {
      cause: signal.reason,
    });
  }
}
