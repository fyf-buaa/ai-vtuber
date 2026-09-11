import { spawn, type ChildProcess } from "node:child_process";
import { abortReason, throwIfAborted } from "../errors.js";
import type { AudioArtifact, AudioSink, SpeechAudioContext } from "../types.js";

const STDERR_LIMIT_BYTES = 16 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;

export interface ExternalAudioSinkOptions {
  readonly executable: string;
  readonly args: readonly string[];
}

interface ActivePlayback {
  readonly child: ChildProcess;
  readonly done: Promise<void>;
  abortError?: Error;
  forceKillTimer?: NodeJS.Timeout;
}

export class ExternalAudioSink implements AudioSink {
  readonly #executable: string;
  readonly #args: readonly string[];
  #active: ActivePlayback | undefined;

  constructor(options: ExternalAudioSinkOptions) {
    if (options.executable.trim().length === 0) {
      throw new TypeError("Audio player executable must not be empty");
    }
    this.#executable = options.executable;
    this.#args = [...options.args];
  }

  async play(
    artifact: AudioArtifact,
    context: SpeechAudioContext,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, "Audio playback was cancelled");
    if (this.#active !== undefined) {
      throw new Error("Audio sink received overlapping playback requests");
    }

    let includedAudioPath = false;
    const args = this.#args.map((argument) => {
      if (argument.includes("{audio}")) {
        includedAudioPath = true;
      }
      return argument
        .replaceAll("{audio}", artifact.path)
        .replaceAll("{speechId}", context.speechId);
    });
    if (!includedAudioPath) {
      args.push(artifact.path);
    }

    const child = spawn(this.#executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr?.on("data", (value: Buffer | string) => {
      if (stderrBytes >= STDERR_LIMIT_BYTES) {
        return;
      }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = STDERR_LIMIT_BYTES - stderrBytes;
      const retained = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      stderrChunks.push(retained);
      stderrBytes += retained.byteLength;
    });

    let active: ActivePlayback;
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", (error) => {
        reject(
          new Error(
            `Unable to start audio player ${JSON.stringify(this.#executable)}: ${error.message}`,
            { cause: error },
          ),
        );
      });
      child.once("exit", (code, exitSignal) => {
        if (active.forceKillTimer !== undefined) {
          clearTimeout(active.forceKillTimer);
        }
        if (active.abortError !== undefined) {
          reject(active.abortError);
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        const detail = stderr.length === 0 ? "" : `: ${stderr}`;
        reject(
          new Error(
            `Audio player exited with ${
              code === null ? `signal ${exitSignal ?? "unknown"}` : `code ${code}`
            }${detail}`,
          ),
        );
      });
    });
    active = { child, done };
    this.#active = active;

    const terminate = (reason: Error): void => {
      if (active.abortError !== undefined) {
        return;
      }
      active.abortError = reason;
      child.kill("SIGTERM");
      active.forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, FORCE_KILL_DELAY_MS);
      active.forceKillTimer.unref();
    };
    const onAbort = (): void => {
      terminate(abortReason(signal, "Audio playback was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await done;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (active.forceKillTimer !== undefined) {
        clearTimeout(active.forceKillTimer);
      }
      if (this.#active === active) {
        this.#active = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    const active = this.#active;
    if (active === undefined) {
      return;
    }
    if (active.abortError === undefined) {
      active.abortError = new Error("Audio playback stopped");
      active.abortError.name = "AbortError";
      active.child.kill("SIGTERM");
      active.forceKillTimer = setTimeout(() => {
        if (active.child.exitCode === null && active.child.signalCode === null) {
          active.child.kill("SIGKILL");
        }
      }, FORCE_KILL_DELAY_MS);
      active.forceKillTimer.unref();
    }
    try {
      await active.done;
    } catch (error) {
      if (error !== active.abortError) {
        throw error;
      }
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

export class NoopAudioSink implements AudioSink {
  async play(
    _artifact: AudioArtifact,
    _context: SpeechAudioContext,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, "Audio playback was cancelled");
  }

  async stop(): Promise<void> {}
}
