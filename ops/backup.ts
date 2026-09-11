import { cp, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const backupRoot = resolve(repositoryRoot, "backup");

const SOURCES = [
  { path: "config.local.json", required: true },
  { path: "config.local.json.bak", required: false },
  { path: "data", required: false },
  { path: "out", required: false },
] as const;

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child));
}

function timestamp(now = new Date()): string {
  return now.toISOString().replaceAll(":", "-").replace(".", "-");
}

async function existingKind(path: string): Promise<"missing" | "symlink" | "other"> {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? "symlink" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

async function prepareBackupRoot(repositoryRealPath: string): Promise<void> {
  const kind = await existingKind(backupRoot);
  if (kind === "symlink") {
    throw new Error("Refusing to write through a symbolic-link backup directory");
  }
  if (kind === "missing") {
    await mkdir(backupRoot);
  }
  const backupRealPath = await realpath(backupRoot);
  if (!isInside(repositoryRealPath, backupRealPath)) {
    throw new Error("Backup directory resolves outside the repository");
  }
}

async function copySource(
  repositoryRealPath: string,
  destinationRoot: string,
  relativePath: string,
  required: boolean,
): Promise<boolean> {
  const source = resolve(repositoryRoot, relativePath);
  if (!isInside(repositoryRoot, source)) {
    throw new Error(`Backup source escapes the repository: ${relativePath}`);
  }

  const kind = await existingKind(source);
  if (kind === "missing") {
    if (required) {
      throw new Error(`Required backup source is missing: ${relativePath}`);
    }
    process.stdout.write(`Skipped missing ${relativePath}\n`);
    return false;
  }
  if (kind === "symlink") {
    throw new Error(`Refusing to back up symbolic-link source: ${relativePath}`);
  }

  const sourceRealPath = await realpath(source);
  if (!isInside(repositoryRealPath, sourceRealPath)) {
    throw new Error(`Backup source resolves outside the repository: ${relativePath}`);
  }

  const destination = resolve(destinationRoot, relativePath);
  if (!isInside(destinationRoot, destination)) {
    throw new Error(`Backup destination escapes its timestamped directory: ${relativePath}`);
  }

  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    dereference: false,
    filter: async (candidate) => {
      if (!isInside(repositoryRoot, resolve(candidate))) {
        throw new Error(`Refusing to traverse outside the repository: ${candidate}`);
      }
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        process.stdout.write(`Skipped symbolic link ${relative(repositoryRoot, candidate)}\n`);
        return false;
      }
      return true;
    },
  });
  process.stdout.write(`Backed up ${relativePath}\n`);
  return true;
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error("backup does not accept paths; it only backs up config.local.json, config.local.json.bak, data, and out");
  }

  const repositoryRealPath = await realpath(repositoryRoot);
  await prepareBackupRoot(repositoryRealPath);

  const destinationRoot = resolve(backupRoot, timestamp());
  if (!isInside(backupRoot, destinationRoot)) {
    throw new Error("Timestamped backup path escapes the backup directory");
  }
  await mkdir(destinationRoot, { recursive: false });

  let copied = 0;
  for (const source of SOURCES) {
    if (await copySource(repositoryRealPath, destinationRoot, source.path, source.required)) {
      copied += 1;
    }
  }

  process.stdout.write(`Backup complete: ${relative(repositoryRoot, destinationRoot)} (${copied} sources)\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Backup failed: ${message}\n`);
  process.exitCode = 1;
});
