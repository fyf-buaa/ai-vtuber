import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigGenerationConflictError,
  ConfigStore,
  type JsonObject,
} from "../src/config/config-store.js";

const temporaryDirectories: string[] = [];

async function createConfig(contents: JsonObject): Promise<{
  directory: string;
  filePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ai-vtuber-config-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "config.json");
  await writeFile(filePath, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  return { directory, filePath };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("ConfigStore", () => {
  it("creates private runtime copies without changing published templates or existing local state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-vtuber-config-default-"));
    temporaryDirectories.push(directory);
    const template = JSON.stringify({ agent: { mode: "reread", apiKey: "" } });
    await writeFile(join(directory, "config.example.json"), template);
    await writeFile(join(directory, "config.example.json.bak"), template);

    const stores = await Promise.all([
      ConfigStore.loadDefault(directory),
      ConfigStore.loadDefault(directory),
    ]);
    await stores[0]!.save({ agent: { mode: "llm", apiKey: "local-only-test-secret" } });
    const reloaded = await ConfigStore.loadDefault(directory);

    expect(reloaded.get("agent", "apiKey")).toBe("local-only-test-secret");
    expect(await readFile(join(directory, "config.example.json"), "utf8")).toBe(template);
    expect(await readFile(join(directory, "config.example.json.bak"), "utf8")).toBe(template);
    expect(JSON.parse(await readFile(join(directory, "config.local.json.bak"), "utf8")))
      .toEqual(JSON.parse(template));
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not replace corrupt local configuration with factory defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-vtuber-config-corrupt-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "config.local.json"), "{broken");
    await writeFile(join(directory, "config.example.json"), "{}");
    await writeFile(join(directory, "config.example.json.bak"), "{}");

    await expect(ConfigStore.loadDefault(directory)).rejects.toBeInstanceOf(SyntaxError);
    expect(await readFile(join(directory, "config.local.json"), "utf8")).toBe("{broken");
  });

  it("reads nested object and array paths without imposing a schema", async () => {
    const { filePath } = await createConfig({
      chat: {
        prompts: ["first", "second"],
        provider: { enabled: true },
      },
    });
    const store = await ConfigStore.load(filePath);

    expect(store.get<string>("chat", "prompts", 1)).toBe("second");
    expect(store.get<boolean>("chat", "provider", "enabled")).toBe(true);
    expect(store.get("chat", "missing")).toBeUndefined();
    expect(store.getOr(["chat", "missing"], "fallback")).toBe("fallback");
  });

  it("isolates stored data from values returned by get and snapshot", async () => {
    const { filePath } = await createConfig({
      nested: { items: [{ label: "original" }] },
    });
    const store = await ConfigStore.load(filePath);

    const fromGet = store.get<{ items: Array<{ label: string }> }>("nested");
    expect(fromGet).toBeDefined();
    if (fromGet === undefined) {
      throw new Error("Expected nested config");
    }
    fromGet.items[0]!.label = "mutated through get";

    const snapshot = store.snapshot();
    const snapshotNested = snapshot["nested"] as JsonObject;
    const snapshotItems = snapshotNested["items"] as JsonObject[];
    snapshotItems[0]!["label"] = "mutated through snapshot";

    expect(store.get<string>("nested", "items", 0, "label")).toBe(
      "original",
    );
  });

  it("preserves unknown extension keys and values when saving", async () => {
    const unknownExtension = {
      plugin_specific_flag: true,
      nested: { nullValue: null, unicode: "保留我", values: [1, "two"] },
    };
    const { filePath } = await createConfig({
      future_plugin: unknownExtension,
    });
    const store = await ConfigStore.load(filePath);
    const next = store.snapshot();
    next["future_plugin"] = {
      ...unknownExtension,
      plugin_specific_flag: false,
    };

    await store.save(next);

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as JsonObject;
    expect(persisted["future_plugin"]).toEqual({
      ...unknownExtension,
      plugin_specific_flag: false,
    });
  });

  it("serializes atomic saves and reloads complete files", async () => {
    const { directory, filePath } = await createConfig({ revision: 0 });
    const store = await ConfigStore.load(filePath);

    await Promise.all([
      store.save({ revision: 1, payload: { source: "first" } }),
      store.save({ revision: 2, payload: { source: "second" } }),
    ]);

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      revision: 2,
      payload: { source: "second" },
    });
    expect(await readdir(directory)).toEqual(["config.json"]);

    await writeFile(
      filePath,
      `${JSON.stringify({ revision: 3, externallyChanged: true })}\n`,
      "utf8",
    );
    await store.reload();

    expect(store.snapshot()).toEqual({ revision: 3, externallyChanged: true });
  });

  it("advances one centralized generation for every successful mutation", async () => {
    const { filePath } = await createConfig({ revision: 0 });
    const store = await ConfigStore.load(filePath);
    expect(store.generation).toBe(0);

    store.restoreSnapshot({ revision: 1 });
    expect(store.generation).toBe(1);
    await expect(
      store.save({ revision: 2 }, 0),
    ).rejects.toBeInstanceOf(ConfigGenerationConflictError);
    expect(store.snapshot()).toEqual({ revision: 1 });
    expect(store.generation).toBe(1);

    await store.save({ revision: 2 }, 1);
    expect(store.generation).toBe(2);
    await writeFile(filePath, JSON.stringify({ revision: 3 }), "utf8");
    await store.reload(2);
    expect(store.snapshot()).toEqual({ revision: 3 });
    expect(store.generation).toBe(3);
  });
});
