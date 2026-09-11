import { throwIfAborted } from "../errors.js";
import type { SpeechRequest } from "../../domain/types.js";
import type { SpeechSynthesizer } from "../types.js";

export class DisabledSpeechSynthesizer implements SpeechSynthesizer {
  readonly name = "none";
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  async synthesize(
    _request: SpeechRequest,
    signal: AbortSignal,
  ): Promise<undefined> {
    throwIfAborted(signal, "Disabled speech request was cancelled");
    return undefined;
  }
}
