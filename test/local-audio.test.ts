import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalAudioError,
  LocalAudioLibrary,
} from "../src/core/local-audio.js";
import type {
  LocalAudioErrorCode,
  LocalAudioExtension,
} from "../src/core/local-audio.js";

const AUDIO_HEADERS = {
  ".wav": Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([4, 0, 0, 0]),
    Buffer.from("WAVE", "ascii"),
  ]),
  ".mp3": Buffer.concat([
    Buffer.from("ID3", "ascii"),
    Buffer.from([4, 0, 0, 0, 0, 0, 0]),
  ]),
  ".ogg": Buffer.concat([
    Buffer.from("OggS", "ascii"),
    Buffer.from([0, 2]),
    Buffer.alloc(20),
    Buffer.from([1, 7, 1]),
    Buffer.from("vorbis", "ascii"),
  ]),
  ".opus": Buffer.concat([
    Buffer.from("OggS", "ascii"),
    Buffer.from([0, 2]),
    Buffer.alloc(20),
    Buffer.from([1, 8]),
    Buffer.from("OpusHead", "ascii"),
  ]),
  ".flac": Buffer.concat([
    Buffer.from("fLaC", "ascii"),
    Buffer.from([0x80, 0, 0, 34]),
    Buffer.alloc(34),
  ]),
  ".m4a": Buffer.concat([
    Buffer.from([0, 0, 0, 16]),
    Buffer.from("ftyp", "ascii"),
    Buffer.from("M4A ", "ascii"),
    Buffer.alloc(4),
  ]),
  ".aac": Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0xff, 0xfc]),
} satisfies Readonly<Record<LocalAudioExtension, Buffer>>;
const SUPPORTED_EXTENSIONS = Object.keys(AUDIO_HEADERS) as LocalAudioExtension[];
const temporaryDirectories: string[] = [];

interface Workspace {
  readonly root: string;
  readonly project: string;
  readonly outside: string;
}

async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "ai-vtuber-local-audio-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const outside = join(root, "outside");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  return { root, project, outside };
}

async function writeAudio(
  root: string,
  relativePath: string,
  extension: LocalAudioExtension,
): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, AUDIO_HEADERS[extension]);
  return path;
}

async function expectAudioError(
  promise: Promise<unknown>,
  code: LocalAudioErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "LocalAudioError",
    code,
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function tryCreateLink(
  target: string,
  path: string,
  type: "file" | "dir" | "junction",
): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    const unavailableCodes = ["EACCES", "EINVAL", "EPERM", "ENOSYS", "ENOTSUP"];
    if (unavailableCodes.includes(errorCode(error) ?? "")) {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("LocalAudioLibrary", () => {
  it("resolves every supported header without loading the audio body", async () => {
    const workspace = await createWorkspace();
    const library = new LocalAudioLibrary(workspace.project);

    for (const extension of SUPPORTED_EXTENSIONS) {
      const filename = extension === ".mp3"
        ? "欢迎回来.MP3"
        : `欢迎回来${extension}`;
      const path = await writeAudio(
        workspace.project,
        join("音频", filename),
        extension,
      );
      const descriptor = await library.resolve(join("音频", filename));

      const expectedStats = await stat(path, { bigint: true });
      expect(descriptor).toMatchObject({
        path: await realpath(path),
        filename,
        stem: "欢迎回来",
        extension,
        size: AUDIO_HEADERS[extension].byteLength,
      });
      expect(descriptor.identity).toEqual({
        dev: expectedStats.dev,
        ino: expectedStats.ino,
        size: expectedStats.size,
        mtimeNs: expectedStats.mtimeNs,
        ctimeNs: expectedStats.ctimeNs,
      });
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.identity)).toBe(true);
    }
  });

  it("handles an absolute Windows path with alternate drive-letter casing", async () => {
    const workspace = await createWorkspace();
    const path = await writeAudio(workspace.project, "windows.wav", ".wav");
    const library = new LocalAudioLibrary(workspace.project);
    const configuredPath = process.platform === "win32"
      ? path.replace(/^[A-Za-z]:/u, (drive) =>
          drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()
        )
      : path;

    await expect(library.resolve(configuredPath)).resolves.toMatchObject({
      filename: "windows.wav",
      extension: ".wav",
    });
  });

  it("returns typed errors for traversal, unsupported, corrupt, and non-file selections", async () => {
    const workspace = await createWorkspace();
    const outsideAudio = await writeAudio(workspace.outside, "outside.wav", ".wav");
    await writeFile(join(workspace.project, "notes.txt"), AUDIO_HEADERS[".wav"]);
    await writeFile(join(workspace.project, "corrupt.mp3"), "not an mp3", "utf8");
    const library = new LocalAudioLibrary(workspace.project);

    await expectAudioError(
      library.resolve(relative(workspace.project, outsideAudio)),
      "OUTSIDE_PROJECT",
    );
    await expectAudioError(library.resolve(outsideAudio), "OUTSIDE_PROJECT");
    await expectAudioError(library.resolve("notes.txt"), "UNSUPPORTED_FORMAT");
    await expectAudioError(library.resolve("corrupt.mp3"), "INVALID_AUDIO");
    await expectAudioError(library.resolve("."), "NOT_REGULAR_FILE");
    await expectAudioError(library.resolve("missing.wav"), "NOT_FOUND");
  });

  it("rejects file symlinks and directory junctions instead of following them", async () => {
    const workspace = await createWorkspace();
    const outsideAudio = await writeAudio(workspace.outside, "outside.wav", ".wav");
    const library = new LocalAudioLibrary(workspace.project);

    const fileLink = join(workspace.project, "linked.wav");
    if (await tryCreateLink(outsideAudio, fileLink, "file")) {
      await expectAudioError(library.resolve("linked.wav"), "SYMLINK");
      await rm(fileLink, { force: true });
    }

    const directoryLink = join(workspace.project, "linked-directory");
    const directoryType = process.platform === "win32" ? "junction" : "dir";
    if (await tryCreateLink(workspace.outside, directoryLink, directoryType)) {
      await expectAudioError(library.list("."), "SYMLINK");
      await rm(directoryLink, { recursive: true, force: true });
    }

    const insideAudio = await writeAudio(workspace.project, "real/inside.wav", ".wav");
    const insideLink = join(workspace.project, "inside-link");
    if (await tryCreateLink(dirname(insideAudio), insideLink, directoryType)) {
      await expectAudioError(library.resolve("inside-link/inside.wav"), "SYMLINK");
    }
  });

  it("lists recursively, freezes results, and skips unsupported or invalid audio", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace.project, "library"), { recursive: true });
    await Promise.all([
      writeAudio(workspace.project, "library/z.wav", ".wav"),
      writeAudio(workspace.project, "library/nested/你好.mp3", ".mp3"),
      writeFile(join(workspace.project, "library/readme.txt"), "not audio", "utf8"),
      writeFile(join(workspace.project, "library/broken.flac"), "wrong", "utf8"),
    ]);
    const library = new LocalAudioLibrary(workspace.project);

    const listed = await library.list("library");

    expect(listed.map((audio) => audio.filename).sort()).toEqual([
      "z.wav",
      "你好.mp3",
    ].sort());
    expect(listed.every((audio) => Object.isFrozen(audio))).toBe(true);
    expect(Object.isFrozen(listed)).toBe(true);
  });

  it("enforces byte, audio-count, entry-count, and depth limits", async () => {
    const workspace = await createWorkspace();
    await writeAudio(workspace.project, "large/large.wav", ".wav");
    await mkdir(join(workspace.project, "entries"), { recursive: true });
    await Promise.all([
      writeAudio(workspace.project, "count/a.wav", ".wav"),
      writeAudio(workspace.project, "count/b.wav", ".wav"),
      writeFile(join(workspace.project, "entries/a.txt"), "a", "utf8"),
      writeFile(join(workspace.project, "entries/b.txt"), "b", "utf8"),
      writeAudio(workspace.project, "deep/child/value.wav", ".wav"),
    ]);

    await expectAudioError(
      new LocalAudioLibrary(workspace.project, { maxFileBytes: 11 }).resolve(
        "large/large.wav",
      ),
      "LIMIT_EXCEEDED",
    );
    await expectAudioError(
      new LocalAudioLibrary(workspace.project, { maxFiles: 1 }).list("count"),
      "LIMIT_EXCEEDED",
    );
    await expectAudioError(
      new LocalAudioLibrary(workspace.project, { maxEntries: 1 }).list("entries"),
      "LIMIT_EXCEEDED",
    );
    await expectAudioError(
      new LocalAudioLibrary(workspace.project, { maxDepth: 0 }).list("deep"),
      "LIMIT_EXCEEDED",
    );
    expect(() => new LocalAudioLibrary(workspace.project, { maxDepth: -1 }))
      .toThrow(LocalAudioError);
  });

  it("honors abort reasons before filesystem work", async () => {
    const workspace = await createWorkspace();
    await writeAudio(workspace.project, "audio.wav", ".wav");
    const library = new LocalAudioLibrary(workspace.project);
    const controller = new AbortController();
    const reason = new Error("local audio cancelled");
    controller.abort(reason);

    await expect(library.resolve("audio.wav", controller.signal)).rejects.toBe(reason);
    await expect(library.list(".", controller.signal)).rejects.toBe(reason);
    await expect(
      library.pick(["audio.wav"], {
        mode: "deterministic",
        seed: "cancelled",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });


  it("selects deterministically, rotates, and uses the injected random source", async () => {
    const workspace = await createWorkspace();
    await Promise.all([
      writeAudio(workspace.project, "choices/a.wav", ".wav"),
      writeAudio(workspace.project, "choices/b.wav", ".wav"),
      writeAudio(workspace.project, "choices/c.wav", ".wav"),
    ]);
    const entries = [
      "choices/a.wav",
      "[choices/b.wav|choices/c.wav]",
    ] as const;
    const randomValues = [0, 0.5, 0.999];
    let randomIndex = 0;
    const random = vi.fn(() => randomValues[randomIndex++] ?? 0);
    const library = new LocalAudioLibrary(workspace.project, {}, random);

    const deterministic = await library.pick(entries, {
      mode: "deterministic",
      seed: "event-42",
    });
    const deterministicAgain = await library.pick(entries, {
      mode: "deterministic",
      seed: "event-42",
    });
    const deterministicReplica = await new LocalAudioLibrary(
      workspace.project,
    ).pick(entries, {
      mode: "deterministic",
      seed: "event-42",
    });
    expect(deterministicAgain?.path).toBe(deterministic?.path);
    expect(deterministicReplica?.path).toBe(deterministic?.path);

    const rotated = await Promise.all([
      library.pick(entries, { mode: "rotating" }),
      library.pick(entries, { mode: "rotating" }),
      library.pick(entries, { mode: "rotating" }),
      library.pick(entries, { mode: "rotating" }),
    ]);
    expect(rotated.map((audio) => audio?.filename)).toEqual([
      "a.wav",
      "b.wav",
      "c.wav",
      "a.wav",
    ]);

    const randomized = [
      await library.pick(entries, { mode: "random" }),
      await library.pick(entries, { mode: "random" }),
      await library.pick(entries, { mode: "random" }),
    ];
    expect(randomized.map((audio) => audio?.filename)).toEqual([
      "a.wav",
      "b.wav",
      "c.wav",
    ]);
    expect(random).toHaveBeenCalledTimes(3);
  });

  it("validates expanded bracket choices and random-source output", async () => {
    const workspace = await createWorkspace();
    const outsideAudio = await writeAudio(workspace.outside, "outside.wav", ".wav");
    const relativeOutside = relative(workspace.project, outsideAudio);

    await expectAudioError(
      new LocalAudioLibrary(workspace.project).pick(
        [`[${relativeOutside}|${relativeOutside}]`],
        { mode: "deterministic", seed: "selected-invalid-path" },
      ),
      "OUTSIDE_PROJECT",
    );
    await expectAudioError(
      new LocalAudioLibrary(workspace.project).pick(
        ["[missing.wav|]"],
        { mode: "rotating" },
      ),
      "INVALID_ARGUMENT",
    );
    await expectAudioError(
      new LocalAudioLibrary(workspace.project, {}, () => 1).pick(
        ["anything.wav"],
        { mode: "random" },
      ),
      "INVALID_ARGUMENT",
    );
    await expect(
      new LocalAudioLibrary(workspace.project).pick([], { mode: "random" }),
    ).resolves.toBeUndefined();
  });

  it("does not mistake a path-prefix sibling for a contained project path", async () => {
    const workspace = await createWorkspace();
    const sibling = `${workspace.project}-other`;
    await mkdir(sibling, { recursive: true });
    const siblingAudio = await writeAudio(sibling, "prefix.wav", ".wav");

    await expectAudioError(
      new LocalAudioLibrary(workspace.project).resolve(siblingAudio),
      "OUTSIDE_PROJECT",
    );
  });
});
