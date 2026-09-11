import {
  createFullApplication,
  type ManualEventInput,
} from "./runtime/index.js";
import { openOperatorWebUi } from "./runtime/operator-webui.js";

interface CliOptions {
  readonly configPath?: string;
  readonly stdin?: boolean;
  readonly server?: boolean;
  readonly openWebUi: boolean;
  readonly platform?: boolean;
  readonly manual: readonly ManualEventInput[];
  readonly help: boolean;
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(
      [
        "Usage: npm start -- [options]",
        "",
        "  --config <path>    Use a JSON configuration (default: config.local.json)",
        "  --stdin            Read manual messages and /commands from stdin",
        "  --no-stdin         Disable the runtime stdin reader",
        "  --manual <text>    Submit one manual talk event",
        "  --reread <text>    Submit one credential-free reread event",
        "  --no-server        Do not start the operator HTTP server",
        "  --open-webui       Open the operator WebUI after the server is ready",
        "  --no-platform      Do not connect a live platform source",
        "  --help             Show this help",
        "",
      ].join("\n"),
    );
    return;
  }

  const stdin =
    options.stdin ?? (options.manual.length === 0 ? undefined : false);
  const application = await createFullApplication({
    ...(options.configPath === undefined
      ? {}
      : { configPath: options.configPath }),
    ...(stdin === undefined ? {} : { stdin }),
    ...(options.server === undefined ? {} : { server: options.server }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });

  let shutdown: Promise<void> | undefined;
  const requestShutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    if (shutdown !== undefined) {
      return;
    }
    application.services.logger.info(`Received ${signal}; shutting down`);
    const pending = application.stop();
    shutdown = pending;
    void pending.catch((error: unknown) => {
      process.exitCode = 1;
      try {
        application.services.logger.error("Graceful shutdown failed", { error });
      } catch {
        // The top-level rejection path still reports the shutdown error.
      }
    });
  };
  const onSigint = (): void => requestShutdown("SIGINT");
  const onSigterm = (): void => requestShutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let failureCleanupComplete = false;
  try {
    await application.start();
    if (options.openWebUi && application.services.server !== undefined) {
      try {
        const url = await openOperatorWebUi(
          application.services.config.snapshot(),
        );
        application.services.logger.info("Opened operator WebUI", { url });
      } catch (error) {
        application.services.logger.warn("Failed to open operator WebUI", {
          error,
        });
      }
    }
    for (const input of options.manual) {
      const reply = await application.submitManual(input);
      if (reply !== undefined) {
        process.stdout.write(`${JSON.stringify(reply)}\n`);
      }
    }
    if (options.manual.length > 0 && stdin !== true) {
      await application.stop();
    }
    await application.waitUntilStopped();
    if (process.exitCode === undefined || process.exitCode === 0) {
      process.exitCode = application.requestedExitCode;
    }
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      shutdown ??= application.stop();
      await shutdown;
    } catch (stopError) {
      failures.push(stopError);
    } finally {
      failureCleanupComplete = true;
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "CLI operation and application shutdown both failed",
      );
    }
    throw error;
  } finally {
    try {
      if (!failureCleanupComplete) {
        await shutdown;
      }
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  }
}

function parseArguments(argv: readonly string[]): CliOptions {
  let configPath: string | undefined;
  let stdin: boolean | undefined;
  let server: boolean | undefined;
  let openWebUi = false;
  let platform: boolean | undefined;
  let help = false;
  const manual: ManualEventInput[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case "--config":
        configPath = requiredValue(argv, ++index, argument);
        break;
      case "--stdin":
        stdin = true;
        break;
      case "--no-stdin":
        stdin = false;
        break;
      case "--manual":
        manual.push({
          content: requiredValue(argv, ++index, argument),
          metadata: { source: "cli-manual" },
        });
        break;
      case "--reread":
        manual.push({
          content: requiredValue(argv, ++index, argument),
          metadata: { chatType: "reread", source: "cli-reread" },
        });
        break;
      case "--no-server":
        server = false;
        break;
      case "--open-webui":
        openWebUi = true;
        break;
      case "--no-platform":
        platform = false;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new TypeError(`Unknown argument: ${argument}`);
    }
  }

  return {
    ...(configPath === undefined ? {} : { configPath }),
    ...(stdin === undefined ? {} : { stdin }),
    ...(server === undefined ? {} : { server }),
    ...(platform === undefined ? {} : { platform }),
    openWebUi,
    manual,
    help,
  };
}

function requiredValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
