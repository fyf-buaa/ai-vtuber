import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCaptionBridge } from "../src/output/captions.js";
import {
  nodeOutputFileSystem,
  type OutputFileSystem,
} from "../src/output/files.js";

const temporaryDirectories: string[] = [];
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

async function makeWorkspace(): Promise<{
  readonly root: string;
  readonly outside: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "caption-path-safety-"));
  temporaryDirectories.push(workspace);
  const root = workspace;
  const outside = join(workspace, "outside");
  await Promise.all([
    mkdir(join(root, "log"), { recursive: true }),
    mkdir(join(root, "out"), { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  return { root, outside };
}

function createRecordingFileSystem(writtenPaths: string[]): OutputFileSystem {
  return {
    ...nodeOutputFileSystem,
    async writeFile(path, data, options) {
      writtenPaths.push(path);
      await nodeOutputFileSystem.writeFile(path, data, options);
    },
  };
}

describe("caption file path safety", () => {
  it("writes and atomically replaces captions in legitimate nested directories", async () => {
    const { root } = await makeWorkspace();
    const bridge = new FileCaptionBridge({
      enabled: true,
      rootDirectory: root,
      filePath: join("out", "nested", "deep", "caption.txt"),
    }, { makeId: () => "caption" });

    await bridge.update({ content: "first caption" });
    await bridge.update({ content: "replacement caption" });

    const directory = join(root, "out", "nested", "deep");
    await expect(readFile(join(directory, "caption.txt"), "utf8"))
      .resolves.toBe("replacement caption");
    await expect(readdir(directory)).resolves.toEqual(["caption.txt"]);
  });

  it("rejects an existing parent symlink or junction that leaves the caption root", async () => {
    const { root, outside } = await makeWorkspace();
    await symlink(outside, join(root, "log", "escape"), directoryLinkType);
    const writtenPaths: string[] = [];
    const bridge = new FileCaptionBridge({
      enabled: true,
      rootDirectory: root,
      filePath: join("log", "escape", "caption.txt"),
    }, {
      fileSystem: createRecordingFileSystem(writtenPaths),
      makeId: () => "escaped",
    });

    await expect(bridge.update({ content: "must stay contained" })).rejects.toMatchObject({
      code: "OUTPUT_PATH_INVALID",
    });
    expect(writtenPaths).toEqual([]);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("refuses to replace an attacker-controlled final symlink or junction", async () => {
    const { root, outside } = await makeWorkspace();
    await writeFile(join(outside, "sentinel.txt"), "unchanged", "utf8");
    await symlink(outside, join(root, "out", "caption.txt"), directoryLinkType);
    const writtenPaths: string[] = [];
    const bridge = new FileCaptionBridge({
      enabled: true,
      rootDirectory: root,
      filePath: join("out", "caption.txt"),
    }, {
      fileSystem: createRecordingFileSystem(writtenPaths),
      makeId: () => "final-link",
    });

    await expect(bridge.update({ content: "must not follow the link" })).rejects.toMatchObject({
      code: "OUTPUT_PATH_INVALID",
    });
    expect(writtenPaths).toEqual([]);
    await expect(readFile(join(outside, "sentinel.txt"), "utf8")).resolves.toBe("unchanged");
    await expect(readdir(outside)).resolves.toEqual(["sentinel.txt"]);
    await expect(readdir(join(root, "out"))).resolves.toEqual(["caption.txt"]);
  });

  it("rejects code, config, and unsupported caption destinations inside the project", async () => {
    const { root } = await makeWorkspace();
    await Promise.all([mkdir(join(root, "src"), { recursive: true }), mkdir(join(root, "config"), { recursive: true })]);
    for (const filePath of ["src/caption.txt", "config/caption.vtt", "log/caption.json"]) {
      const bridge = new FileCaptionBridge({
        enabled: true,
        rootDirectory: root,
        filePath,
      });
      await expect(bridge.update({ content: "must not write here" })).rejects.toMatchObject({
        code: "OUTPUT_CONFIG_INVALID",
      });
    }
  });
});
