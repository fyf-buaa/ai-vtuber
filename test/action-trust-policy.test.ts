import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ActionConfigurationError } from "../src/actions/errors.js";
import { createActionServices } from "../src/actions/factory.js";
import type {
  ProcessExit,
  ProcessRequest,
  ProcessSpawner,
  SpawnedProcess,
} from "../src/actions/process.js";

const EXECUTABLE = resolve("test-fixtures", "configured-shell.exe");
const SUCCESSFUL_EXIT: ProcessExit = {
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
};

class InjectedProcess implements SpawnedProcess {
  readonly pid = 1_234;
  readonly #exit = Promise.withResolvers<ProcessExit>();
  readonly exited = this.#exit.promise;

  terminate(): Promise<void> {
    this.#exit.resolve(SUCCESSFUL_EXIT);
    return Promise.resolve();
  }
}

class InjectedSpawner implements ProcessSpawner {
  readonly requests: ProcessRequest[] = [];

  spawn(request: ProcessRequest): SpawnedProcess {
    this.requests.push(request);
    return new InjectedProcess();
  }
}

describe("executable action identity policy", () => {
  it("rejects enabled duplicate ids before listing and invocation can disagree", () => {
    const spawner = new InjectedSpawner();

    expect(() =>
      createActionServices(
        {
          executable_actions: [
            {
              id: "duplicate",
              enable: true,
              executable: EXECUTABLE,
              allow_agent: false,
            },
            {
              id: "duplicate",
              enable: true,
              executable: EXECUTABLE,
              allow_agent: true,
            },
          ],
          action_executable_allowlist: [EXECUTABLE],
        },
        { spawner },
      ),
    ).toThrow(ActionConfigurationError);
    expect(spawner.requests).toEqual([]);
  });
});
