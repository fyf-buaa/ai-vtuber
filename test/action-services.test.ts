import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ActionAuthorizationError,
} from "../src/actions/errors.js";
import { ExecutableActionRegistry } from "../src/actions/executable-actions.js";
import type {
  ProcessRequest,
  ProcessSpawner,
  SpawnedProcess,
} from "../src/actions/process.js";
import {
  type AuthorizedActionInvoker,
  type AuthorizedActionResult,
} from "../src/actions/runtime.js";
import { createActionTools } from "../src/tools/action-tools.js";


class FakeSpawnedProcess implements SpawnedProcess {
  readonly pid = 42;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
  terminateCalls = 0;
  terminateFailures = 0;
  readonly #resolveExit: (value: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }) => void;

  constructor(autoExit = true) {
    const deferred = Promise.withResolvers<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>();
    this.exited = deferred.promise;
    this.#resolveExit = deferred.resolve;
    if (autoExit) {
      queueMicrotask(() => {
        this.#resolveExit({ code: 0, signal: null, stdout: "ok", stderr: "" });
      });
    }
  }

  async terminate(): Promise<void> {
    this.terminateCalls += 1;
    if (this.terminateFailures > 0) {
      this.terminateFailures -= 1;
      throw new Error("termination failed");
    }
    this.#resolveExit({ code: 0, signal: null, stdout: "", stderr: "" });
  }
}

class FakeSpawner implements ProcessSpawner {
  readonly requests: ProcessRequest[] = [];
  readonly processes: FakeSpawnedProcess[] = [];
  autoExit = true;

  spawn(request: ProcessRequest): SpawnedProcess {
    this.requests.push(request);
    const process = new FakeSpawnedProcess(this.autoExit);
    this.processes.push(process);
    return process;
  }
}


describe("configured executable actions", () => {
  it("rejects a non-allowlisted executable without starting it", async () => {
    const spawner = new FakeSpawner();
    const executables = new ExecutableActionRegistry({
      actions: [
        {
          id: "blocked",
          executable: resolve("not-allowed.exe"),
          allowAgent: true,
        },
      ],
      allowedExecutables: [resolve("allowed.exe")],
      spawner,
    });

    await expect(
      executables.invoke("blocked", "agent"),
    ).rejects.toBeInstanceOf(ActionAuthorizationError);
    expect(spawner.requests).toHaveLength(0);
  });
});

describe("agent authorization", () => {
  it("exposes only an allowlisted executable action to the Pi tool", async () => {
    const calls: string[] = [];
    const allowedResult: AuthorizedActionResult = {
      actionId: "executable:hello",
      kind: "executable",
      output: {},
    };
    const invoker: AuthorizedActionInvoker = {
      listAuthorizedActions: () => [
        { id: "executable:hello", description: "Run greeting executable" },
      ],
      invokeAuthorizedAction: async (actionId) => {
        calls.push(actionId);
        return allowedResult;
      },
    };
    const tool = createActionTools(invoker)[0];

    await tool?.execute("call-1", { actionId: "executable:hello" });
    await expect(
      tool?.execute("call-2", { actionId: "executable:delete-everything" }),
    ).rejects.toBeInstanceOf(ActionAuthorizationError);
    expect(calls).toEqual(["executable:hello"]);
  });
});
