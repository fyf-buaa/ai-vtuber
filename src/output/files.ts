import {
  mkdir,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { OutputBridgeError, OutputPathError } from "./errors.js";

export interface OutputFileInfo {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink?(): boolean;
  readonly size: number;
}

export interface OutputFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    data: Uint8Array,
    options?: Readonly<{ exclusive?: boolean }>,
  ): Promise<void>;
  mkdir(path: string, options?: Readonly<{ recursive?: boolean }>): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<OutputFileInfo>;
  lstat?(path: string): Promise<OutputFileInfo>;
  realpath(path: string): Promise<string>;
}

export const nodeOutputFileSystem: OutputFileSystem = {
  async readFile(path) {
    return readFile(path);
  },
  async writeFile(path, data, options) {
    await writeFile(path, data, options?.exclusive === true ? { flag: "wx" } : undefined);
  },
  async mkdir(path, options) {
    await mkdir(path, { recursive: options?.recursive ?? true });
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async remove(path) {
    await rm(path, { force: true });
  },
  async lstat(path) {
    return lstat(path);
  },
  async stat(path) {
    return stat(path);
  },
  async realpath(path) {
    return realpath(path);
  },
};

export interface AtomicWriteOptions {
  readonly component: string;
  readonly fileSystem?: OutputFileSystem;
  readonly makeId?: () => string;
  readonly rootDirectory?: string;
  readonly allowedDirectories?: readonly string[];
}

export function isAbsoluteCrossPlatform(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

export function isPathContained(rootPath: string, candidatePath: string): boolean {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function resolveContainedPath(
  rootPath: string,
  configuredPath: string,
  component: string,
): string {
  if (rootPath.trim().length === 0) {
    throw new OutputPathError(component, `${component} root path is empty`);
  }
  if (configuredPath.trim().length === 0 || configuredPath.includes("\0")) {
    throw new OutputPathError(component, `${component} path is empty or invalid`);
  }

  const root = resolve(rootPath);
  const candidate = resolve(root, configuredPath);
  if (!isPathContained(root, candidate)) {
    throw new OutputPathError(component, `${component} path escapes its configured root`);
  }
  return candidate;
}

export function requireAbsoluteArtifactPath(path: string, component: string): string {
  if (path.trim().length === 0 || path.includes("\0") || !isAbsoluteCrossPlatform(path)) {
    throw new OutputPathError(component, `${component} requires an absolute artifact path`);
  }
  return path;
}

interface PreparedAtomicDestination {
  readonly canonicalRoot: string;
  readonly parentDirectory: string;
  readonly destination: string;
}

function isNotFoundError(cause: unknown): boolean {
  return (
    cause !== null
    && typeof cause === "object"
    && "code" in cause
    && cause.code === "ENOENT"
  ) || (cause instanceof Error && cause.message === "ENOENT");
}

function isSamePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === "";
}

async function canonicalizeContainedDirectory(
  path: string,
  canonicalRoot: string,
  component: string,
  fileSystem: OutputFileSystem,
): Promise<string> {
  const canonicalPath = await fileSystem.realpath(path);
  if (!isPathContained(canonicalRoot, canonicalPath)) {
    throw new OutputPathError(
      component,
      `${component} output parent resolves outside its configured root`,
    );
  }
  const info = await fileSystem.stat(canonicalPath);
  if (!info.isDirectory()) {
    throw new OutputPathError(component, `${component} output parent is not a directory`);
  }
  return canonicalPath;
}

async function prepareAtomicDestination(
  destination: string,
  rootDirectory: string,
  component: string,
  fileSystem: OutputFileSystem,
): Promise<PreparedAtomicDestination> {
  const configuredRoot = resolve(rootDirectory);
  const absoluteDestination = resolve(destination);
  const configuredParent = dirname(absoluteDestination);
  if (
    !isPathContained(configuredRoot, absoluteDestination)
    || !isPathContained(configuredRoot, configuredParent)
  ) {
    throw new OutputPathError(component, `${component} path escapes its configured root`);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await fileSystem.realpath(configuredRoot);
  } catch (cause) {
    if (!isNotFoundError(cause)) {
      throw cause;
    }
    try {
      await fileSystem.mkdir(configuredRoot, { recursive: true });
    } catch (mkdirCause) {
      const alreadyExists = (
        mkdirCause !== null
        && typeof mkdirCause === "object"
        && "code" in mkdirCause
        && mkdirCause.code === "EEXIST"
      ) || (mkdirCause instanceof Error && mkdirCause.message === "EEXIST");
      if (!alreadyExists) {
        throw mkdirCause;
      }
    }
    canonicalRoot = await fileSystem.realpath(configuredRoot);
  }
  const rootInfo = await fileSystem.stat(canonicalRoot);
  if (!rootInfo.isDirectory()) {
    throw new OutputPathError(component, `${component} root path is not a directory`);
  }

  let canonicalParent = canonicalRoot;
  const relativeParent = relative(configuredRoot, configuredParent);
  const parentComponents = relativeParent.length === 0 ? [] : relativeParent.split(sep);
  for (const parentComponent of parentComponents) {
    canonicalParent = await canonicalizeContainedDirectory(
      canonicalParent,
      canonicalRoot,
      component,
      fileSystem,
    );
    const child = resolve(canonicalParent, parentComponent);
    let canonicalChild: string;
    try {
      canonicalChild = await fileSystem.realpath(child);
    } catch (cause) {
      if (!isNotFoundError(cause)) {
        throw cause;
      }
      try {
        await fileSystem.mkdir(child, { recursive: false });
      } catch (mkdirCause) {
        const alreadyExists = (
          mkdirCause !== null
          && typeof mkdirCause === "object"
          && "code" in mkdirCause
          && mkdirCause.code === "EEXIST"
        ) || (mkdirCause instanceof Error && mkdirCause.message === "EEXIST");
        if (!alreadyExists) {
          throw mkdirCause;
        }
      }
      canonicalChild = await fileSystem.realpath(child);
    }
    if (!isPathContained(canonicalRoot, canonicalChild)) {
      throw new OutputPathError(
        component,
        `${component} output parent resolves outside its configured root`,
      );
    }
    const childInfo = await fileSystem.stat(canonicalChild);
    if (!childInfo.isDirectory()) {
      throw new OutputPathError(component, `${component} output parent is not a directory`);
    }
    canonicalParent = canonicalChild;
  }

  return {
    canonicalRoot,
    parentDirectory: canonicalParent,
    destination: resolve(canonicalParent, basename(absoluteDestination)),
  };
}

async function assertStableParent(
  prepared: PreparedAtomicDestination,
  component: string,
  fileSystem: OutputFileSystem,
): Promise<void> {
  const currentParent = await canonicalizeContainedDirectory(
    prepared.parentDirectory,
    prepared.canonicalRoot,
    component,
    fileSystem,
  );
  if (!isSamePath(currentParent, prepared.parentDirectory)) {
    throw new OutputPathError(
      component,
      `${component} output parent changed during its atomic write`,
    );
  }
}

async function assertReplaceableDestination(
  destination: string,
  canonicalRoot: string,
  component: string,
  fileSystem: OutputFileSystem,
): Promise<void> {
  let info: OutputFileInfo;
  try {
    info = await (fileSystem.lstat?.(destination) ?? fileSystem.stat(destination));
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return;
    }
    throw cause;
  }

  if (info.isSymbolicLink?.() === true || !info.isFile()) {
    throw new OutputPathError(
      component,
      `${component} refuses to replace a symbolic link or non-file destination`,
    );
  }

  let canonicalDestination: string;
  try {
    canonicalDestination = await fileSystem.realpath(destination);
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return;
    }
    throw cause;
  }
  if (
    !isPathContained(canonicalRoot, canonicalDestination)
    || !isSamePath(destination, canonicalDestination)
  ) {
    throw new OutputPathError(
      component,
      `${component} refuses to replace a destination that resolves through a link`,
    );
  }
}

async function assertContainedTemporaryFile(
  temporaryPath: string,
  canonicalRoot: string,
  component: string,
  fileSystem: OutputFileSystem,
): Promise<void> {
  const info = await (fileSystem.lstat?.(temporaryPath) ?? fileSystem.stat(temporaryPath));
  if (info.isSymbolicLink?.() === true || !info.isFile()) {
    throw new OutputPathError(component, `${component} atomic temporary path is not a regular file`);
  }
  const canonicalTemporaryPath = await fileSystem.realpath(temporaryPath);
  if (
    !isPathContained(canonicalRoot, canonicalTemporaryPath)
    || !isSamePath(temporaryPath, canonicalTemporaryPath)
  ) {
    throw new OutputPathError(
      component,
      `${component} atomic temporary path resolves through an unsafe link`,
    );
  }
}

async function removeTemporaryFileSafely(
  temporaryPath: string,
  prepared: PreparedAtomicDestination,
  component: string,
  fileSystem: OutputFileSystem,
): Promise<void> {
  try {
    await assertStableParent(prepared, component, fileSystem);
    await fileSystem.remove(temporaryPath);
  } catch {
    // A changed parent is less safe to traverse than a best-effort cleanup.
  }
}

export async function writeFileAtomically(
  destination: string,
  data: Uint8Array,
  options: AtomicWriteOptions,
): Promise<void> {
  const fileSystem = options.fileSystem ?? nodeOutputFileSystem;
  let prepared: PreparedAtomicDestination | undefined;
  let temporaryPath: string | undefined;

  try {
    prepared = await prepareAtomicDestination(
      destination,
      options.rootDirectory ?? dirname(destination),
      options.component,
      fileSystem,
    );
    if (
      options.allowedDirectories !== undefined &&
      !options.allowedDirectories.some((directory) =>
        isPathContained(resolve(prepared!.canonicalRoot, directory), prepared!.destination),
      )
    ) {
      throw new OutputPathError(
        options.component,
        `${options.component} destination resolves outside its authorized output directories`,
      );
    }
    const id = (options.makeId ?? randomUUID)().replace(/[^A-Za-z0-9_-]/gu, "");
    temporaryPath = `${prepared.destination}.${id || "temporary"}.tmp`;

    await assertStableParent(prepared, options.component, fileSystem);
    await assertReplaceableDestination(
      prepared.destination,
      prepared.canonicalRoot,
      options.component,
      fileSystem,
    );
    await fileSystem.writeFile(temporaryPath, data, { exclusive: true });
    await assertContainedTemporaryFile(
      temporaryPath,
      prepared.canonicalRoot,
      options.component,
      fileSystem,
    );
    await assertStableParent(prepared, options.component, fileSystem);
    await assertReplaceableDestination(
      prepared.destination,
      prepared.canonicalRoot,
      options.component,
      fileSystem,
    );
    // Node has no handle-relative rename on Windows, so rechecking the
    // canonical parent immediately beforehand is the strongest available guard.
    await assertStableParent(prepared, options.component, fileSystem);
    await fileSystem.rename(temporaryPath, prepared.destination);
  } catch (cause) {
    if (prepared !== undefined && temporaryPath !== undefined) {
      await removeTemporaryFileSafely(
        temporaryPath,
        prepared,
        options.component,
        fileSystem,
      );
    }
    if (cause instanceof OutputPathError) {
      throw cause;
    }
    throw new OutputBridgeError(`${options.component} could not commit its output artifact`, {
      code: "OUTPUT_REQUEST_FAILED",
      component: options.component,
      cause,
    });
  }
}

export async function requireContainedRealFile(
  rootPath: string,
  candidatePath: string,
  component: string,
  fileSystem: OutputFileSystem = nodeOutputFileSystem,
): Promise<{ readonly path: string; readonly size: number }> {
  const root = await fileSystem.realpath(resolve(rootPath));
  const candidate = await fileSystem.realpath(resolve(candidatePath));
  if (!isPathContained(root, candidate)) {
    throw new OutputPathError(component, `${component} path resolves outside its configured root`);
  }
  const info = await fileSystem.stat(candidate);
  if (!info.isFile() || info.size <= 0) {
    throw new OutputPathError(component, `${component} path is not a non-empty regular file`);
  }
  return { path: candidate, size: info.size };
}
