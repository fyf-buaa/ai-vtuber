export type PiAgentErrorCode =
  | "configuration"
  | "provider"
  | "model"
  | "auth"
  | "cancelled"
  | "session-limit"
  | "execution";

/** An explicit failure surfaced by the pi-backed agent boundary. */
export class PiAgentError extends Error {
  readonly code: PiAgentErrorCode;

  constructor(
    code: PiAgentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PiAgentError";
    this.code = code;
  }
}
