import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../src/config/config-store.js";
import {
  openOperatorWebUi,
  type OperatorWebUiSpawn,
} from "../src/runtime/operator-webui.js";

class FakeChildProcess extends EventEmitter {
  readonly unref = vi.fn((): void => undefined);
}

function successfulSpawn(child: FakeChildProcess): OperatorWebUiSpawn {
  return vi.fn<OperatorWebUiSpawn>(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  });
}

describe("openOperatorWebUi", () => {
  it.each<{
    readonly name: string;
    readonly config: JsonObject;
    readonly expectedUrl: string;
  }>([
    {
      name: "prefers webui bind values",
      config: {
        webui: { ip: "webui.example.test", port: 9_001 },
        api_ip: "api.example.test",
        api_port: 9_002,
      },
      expectedUrl: "http://webui.example.test:9001/",
    },
    {
      name: "falls back to legacy API bind values",
      config: {
        webui: {},
        api_ip: "api.example.test",
        api_port: 9_003,
      },
      expectedUrl: "http://api.example.test:9003/",
    },
    {
      name: "uses loopback defaults",
      config: {},
      expectedUrl: "http://127.0.0.1:8081/",
    },
  ])("$name", async ({ config, expectedUrl }) => {
    const child = new FakeChildProcess();
    const spawn = successfulSpawn(child);

    await expect(openOperatorWebUi(config, {
      platform: "linux",
      spawn,
    })).resolves.toBe(expectedUrl);

    expect(spawn).toHaveBeenCalledWith("xdg-open", [expectedUrl], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("uses explorer.exe on Windows and waits for the child spawn event", async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn<OperatorWebUiSpawn>(
      () => child as unknown as ChildProcess,
    );
    const url = "http://127.0.0.1:8181/";

    const opening = openOperatorWebUi({ api_port: 8_181 }, {
      platform: "win32",
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith("explorer.exe", [url], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    expect(child.unref).not.toHaveBeenCalled();
    child.emit("spawn");
    await expect(opening).resolves.toBe(url);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it.each([
    ["0.0.0.0", "http://127.0.0.1:8081/"],
    ["::", "http://[::1]:8081/"],
    ["2001:db8::7", "http://[2001:db8::7]:8081/"],
    ["[2001:db8::8]", "http://[2001:db8::8]:8081/"],
  ])("maps or brackets host %s", async (host, expectedUrl) => {
    const child = new FakeChildProcess();
    const spawn = successfulSpawn(child);

    await expect(openOperatorWebUi({ webui: { ip: host } }, {
      platform: "darwin",
      spawn,
    })).resolves.toBe(expectedUrl);
    expect(spawn).toHaveBeenCalledWith("open", [expectedUrl], expect.any(Object));
  });

  it.each<{
    readonly name: string;
    readonly config: JsonObject;
    readonly expectedMessage: RegExp;
  }>([
    {
      name: "empty host",
      config: { webui: { ip: " " } },
      expectedMessage: /host/u,
    },
    {
      name: "unsafe host",
      config: { webui: { ip: "example.test/path" } },
      expectedMessage: /host/u,
    },
    {
      name: "zero port",
      config: { webui: { port: 0 } },
      expectedMessage: /port/u,
    },
    {
      name: "non-integer port",
      config: { webui: { port: 8_081.5 } },
      expectedMessage: /port/u,
    },
    {
      name: "out-of-range port",
      config: { webui: { port: 65_536 } },
      expectedMessage: /port/u,
    },
  ])("rejects an invalid $name before spawning", async ({
    config,
    expectedMessage,
  }) => {
    const spawn = vi.fn<OperatorWebUiSpawn>(() => {
      throw new Error("spawn must not be called");
    });

    await expect(openOperatorWebUi(config, { spawn })).rejects.toThrow(
      expectedMessage,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects an asynchronous spawn error without unrefing the child", async () => {
    const child = new FakeChildProcess();
    const spawnError = Object.assign(new Error("missing opener"), {
      code: "ENOENT",
    });
    const spawn = vi.fn<OperatorWebUiSpawn>(() => {
      queueMicrotask(() => child.emit("error", spawnError));
      return child as unknown as ChildProcess;
    });

    await expect(openOperatorWebUi({}, {
      platform: "linux",
      spawn,
    })).rejects.toBe(spawnError);
    expect(child.unref).not.toHaveBeenCalled();
  });
});
