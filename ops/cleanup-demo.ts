import { lstat, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIRMATION_FLAG = "--confirm-demo-cleanup";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Exact outputs produced by the repository's historical demo configuration.
// Source material under data/, logs, directories, and arbitrary media are never selected.
const DEMO_OUTPUTS = [
  "out/copywriting/test.wav",
  "out/copywriting/测试文案.mp3",
  "out/copywriting/测试文案.wav",
  "out/copywriting/测试文案2.wav",
  "out/copywriting/测试文案3.wav",
  "out/copywriting/达达利亚.wav",
  "out/copywriting/吐槽.wav",
  "out/copywriting/伊卡日语介绍.wav",
  "out/copywriting2/test.wav",
  "out/copywriting2/test2.wav",
  "out/本地问答音频/关键词1.wav",
  "out/本地问答音频/关键词2.wav",
  "out/song/把回忆拼好给你.mp3",
] as const;

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      `Usage: npm run cleanup:demo -- ${CONFIRMATION_FLAG}\n` +
        "Deletes only the fixed demo-output allowlist printed by this command; data and logs are never scanned.\n",
    );
    return;
  }
  if (args.length !== 1 || args[0] !== CONFIRMATION_FLAG) {
    process.stderr.write(
      `No files removed. Re-run with the explicit ${CONFIRMATION_FLAG} flag.\n`,
    );
    process.exitCode = 2;
    return;
  }

  let removed = 0;
  for (const relativePath of DEMO_OUTPUTS) {
    const target = resolve(repositoryRoot, relativePath);
    if (!isInside(repositoryRoot, target)) {
      throw new Error(`Cleanup target escapes the repository: ${relativePath}`);
    }

    try {
      const info = await lstat(target);
      if (info.isDirectory()) {
        throw new Error(`Refusing to remove a directory: ${relativePath}`);
      }
      await rm(target, { force: false, recursive: false });
      removed += 1;
      process.stdout.write(`Removed ${relativePath}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        process.stdout.write(`Skipped missing ${relativePath}\n`);
        continue;
      }
      throw error;
    }
  }

  process.stdout.write(`Demo cleanup complete: removed ${removed} file(s).\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Demo cleanup failed: ${message}\n`);
  process.exitCode = 1;
});
