export type ActionErrorCode =
  | "ACTION_ABORTED"
  | "ACTION_CONFIGURATION"
  | "ACTION_DENIED"
  | "ACTION_EXECUTION"
  | "ACTION_NOT_FOUND"
  | "ACTION_TIMEOUT"
  | "ACTION_UNAVAILABLE";

export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ActionErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ActionError";
    this.code = code;
    this.details = details;
  }
}

export class ActionConfigurationError extends ActionError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("ACTION_CONFIGURATION", message, details);
    this.name = "ActionConfigurationError";
  }
}

export class ActionAuthorizationError extends ActionError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("ACTION_DENIED", message, details);
    this.name = "ActionAuthorizationError";
  }
}

export class ActionNotFoundError extends ActionError {
  constructor(actionId: string) {
    super("ACTION_NOT_FOUND", `Configured action '${actionId}' does not exist`, {
      actionId,
    });
    this.name = "ActionNotFoundError";
  }
}

export class ActionUnavailableError extends ActionError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("ACTION_UNAVAILABLE", message, details);
    this.name = "ActionUnavailableError";
  }
}

export class ActionExecutionError extends ActionError {
  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super("ACTION_EXECUTION", message, details, options);
    this.name = "ActionExecutionError";
  }
}

export class ActionTimeoutError extends ActionError {
  constructor(operation: string, timeoutMs: number) {
    super(
      "ACTION_TIMEOUT",
      `${operation} timed out after ${timeoutMs} ms`,
      { operation, timeoutMs },
    );
    this.name = "ActionTimeoutError";
  }
}

export class ActionAbortedError extends ActionError {
  constructor(operation: string, options?: ErrorOptions) {
    super("ACTION_ABORTED", `${operation} was aborted`, { operation }, options);
    this.name = "ActionAbortedError";
  }
}

