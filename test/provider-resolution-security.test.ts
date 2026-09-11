import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { PiAgentError } from "../src/agent/errors.js";
import { resolvePiAgentConfig } from "../src/agent/provider-resolution.js";

function resolveConfigurationError(baseUrl: string): PiAgentError {
  try {
    resolvePiAgentConfig({
      agent: {
        provider: "openai-compatible",
        model: "security-test-model",
        baseUrl,
      },
    });
  } catch (error) {
    expect(error).toBeInstanceOf(PiAgentError);
    expect(error).toMatchObject({ code: "configuration" });
    return error as PiAgentError;
  }
  throw new Error("Expected provider resolution to reject the base URL");
}

function expectSecretsAbsent(
  error: PiAgentError,
  secrets: readonly string[],
): void {
  const surfaces = [
    error.message,
    error.stack ?? "",
    String(error),
    inspect(error, { showHidden: true }),
  ];
  for (const surface of surfaces) {
    for (const secret of secrets) {
      expect(surface).not.toContain(secret);
    }
  }
}

describe("provider base URL diagnostics", () => {
  it.each([
    {
      label: "URL credentials",
      baseUrl:
        "https://provider-user-secret:provider-password-secret@provider.example.test/v1",
      secrets: ["provider-user-secret", "provider-password-secret"],
      diagnostic: "must not contain URL credentials",
    },
    {
      label: "a query",
      baseUrl: "https://provider.example.test/v1?apiKey=query-secret-value",
      secrets: ["query-secret-value"],
      diagnostic: "must not contain a query or fragment",
    },
    {
      label: "a fragment",
      baseUrl: "https://provider.example.test/v1#fragment-secret-value",
      secrets: ["fragment-secret-value"],
      diagnostic: "must not contain a query or fragment",
    },
    {
      label: "an invalid URL containing secrets",
      baseUrl:
        "https://invalid-user-secret:invalid-password-secret@[not-ipv6]?token=invalid-query-secret#invalid-fragment-secret",
      secrets: [
        "invalid-user-secret",
        "invalid-password-secret",
        "invalid-query-secret",
        "invalid-fragment-secret",
      ],
      diagnostic: "Invalid agent base URL",
    },
    {
      label: "an unsupported URL containing secrets",
      baseUrl:
        "ftp://unsupported-user-secret:unsupported-password-secret@provider.example.test/v1?token=unsupported-query-secret#unsupported-fragment-secret",
      secrets: [
        "unsupported-user-secret",
        "unsupported-password-secret",
        "unsupported-query-secret",
        "unsupported-fragment-secret",
      ],
      diagnostic: "must use HTTP or HTTPS",
    },
  ] as const)("rejects $label without retaining secrets", ({ baseUrl, secrets, diagnostic }) => {
    const error = resolveConfigurationError(baseUrl);

    expect(error.message).toContain(diagnostic);
    expect(error.stack).toContain(diagnostic);
    expect(Object.hasOwn(error, "cause")).toBe(false);
    expectSecretsAbsent(error, secrets);
  });

  it("keeps provider URL secrets out of the CLI fatal stderr stack", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-vtuber-provider-fatal-"));
    const configPath = join(directory, "provider-bootstrap.json");
    const baseUrl =
      "https://fatal-user-secret:fatal-password-secret@provider.example.test/v1?token=fatal-query-secret#fatal-fragment-secret";
    const secrets = [
      "fatal-user-secret",
      "fatal-password-secret",
      "fatal-query-secret",
      "fatal-fragment-secret",
    ];

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          platform: "talk",
          audio_synthesis_type: "none",
          schedule: [],
          idle_time_task: { enable: false },
          image_recognition: { enable: false },
          login: { enable: false },
          agent: {
            mode: "llm",
            provider: "openai-compatible",
            model: "security-test-model",
            baseUrl,
          },
        }),
        "utf8",
      );

      const projectRoot = fileURLToPath(new URL("..", import.meta.url));
      const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          entrypoint,
          "--config",
          configPath,
          "--manual",
          "exercise provider resolution",
          "--no-stdin",
          "--no-server",
          "--no-platform",
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
          timeout: 30_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PiAgentError");
      expect(result.stderr).toContain("must not contain URL credentials");
      for (const secret of secrets) {
        expect(result.stderr).not.toContain(secret);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
