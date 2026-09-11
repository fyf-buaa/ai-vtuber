import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionExecutionError } from "../src/actions/errors.js";
import type { ProcessRequest } from "../src/actions/process.js";
import {
  NodeProcessSpawner,
  runProcess,
} from "../src/actions/process.js";

class FakeChildProcess extends EventEmitter {
  pid: number | undefined = 100;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn(() => true);
}

function expectSettlementListenersRemoved(child: FakeChildProcess): void {
  expect(child.listenerCount("error")).toBe(0);
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("close")).toBe(0);
  expect(child.stdout.listenerCount("data")).toBe(0);
  expect(child.stderr.listenerCount("data")).toBe(0);
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("action process lifecycle", () => {
  it("rejects a nonexistent executable without hanging in forced cleanup", async () => {
    const executable = resolve(
      `.missing-action-process-${String(process.pid)}-${String(Date.now())}.exe`,
    );

    const error = await runProcess(
      new NodeProcessSpawner(),
      {
        executable,
        args: [],
      },
      {
        operation: "missing executable regression",
        timeoutMs: 250,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionExecutionError);
    expect(error).toMatchObject({
      code: "ACTION_EXECUTION",
      details: { executable },
    });
  }, 1_000);

  it("preserves normal process exit and captured output", async () => {
    const result = await runProcess(
      new NodeProcessSpawner(),
      {
        executable: process.execPath,
        args: [
          "--eval",
          'process.stdout.write("normal stdout"); process.stderr.write("normal stderr");',
        ],
      },
      {
        operation: "normal process",
        timeoutMs: 2_000,
      },
    );

    expect(result).toEqual({
      code: 0,
      signal: null,
      stdout: "normal stdout",
      stderr: "normal stderr",
    });
  });

  it("settles once on exit, close, error, or an already-settled child", async () => {
    const exitedChild = new FakeChildProcess();
    const closedChild = new FakeChildProcess();
    const failedChild = new FakeChildProcess();
    failedChild.pid = undefined;
    const alreadyExitedChild = new FakeChildProcess();
    alreadyExitedChild.exitCode = 0;
    const children = [
      exitedChild,
      closedChild,
      failedChild,
      alreadyExitedChild,
    ];
    const spawn = vi.fn(
      () => children.shift() as unknown as ChildProcess,
    );

    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawn }));
    // Re-import after installing the built-in spawn mock so this test can
    // inspect the otherwise-private child-process listener boundary.
    const { NodeProcessSpawner: MockedNodeProcessSpawner } = await import(
      "../src/actions/process.js"
    );
    const spawner = new MockedNodeProcessSpawner();
    const request: ProcessRequest = { executable: "fake", args: [] };

    const exited = spawner.spawn(request);
    exitedChild.stdout.emit("data", Buffer.from("exit output"));
    exitedChild.exitCode = 0;
    exitedChild.emit("exit", 0, null);
    await expect(exited.exited).resolves.toMatchObject({
      code: 0,
      stdout: "exit output",
    });
    expectSettlementListenersRemoved(exitedChild);
    expect(exitedChild.emit("close", 99, null)).toBe(false);

    const closed = spawner.spawn(request);
    closedChild.emit("close", 0, null);
    await expect(closed.exited).resolves.toMatchObject({ code: 0 });
    expectSettlementListenersRemoved(closedChild);

    const failed = spawner.spawn(request);
    failedChild.emit("error", Object.assign(new Error("missing"), {
      code: "ENOENT",
    }));
    await expect(failed.exited).rejects.toMatchObject({
      name: "ActionExecutionError",
      code: "ACTION_EXECUTION",
    });
    await expect(failed.terminate(true)).resolves.toBeUndefined();
    expect(failedChild.kill).not.toHaveBeenCalled();
    expectSettlementListenersRemoved(failedChild);

    const alreadyExited = spawner.spawn(request);
    await expect(alreadyExited.exited).resolves.toMatchObject({ code: 0 });
    expectSettlementListenersRemoved(alreadyExitedChild);
  });
});
