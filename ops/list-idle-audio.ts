import { readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const audioRoot = resolve(projectRoot, "data", "闲时任务", "音频");
const requestedDirectory = process.argv[2]?.trim() || "ikaros";

if (requestedDirectory === "." || requestedDirectory === "..") {
  throw new TypeError("The audio directory must be a child of data/闲时任务/音频");
}

const rootRealPath = await realpath(audioRoot);
const directoryRealPath = await realpath(resolve(audioRoot, requestedDirectory));
const relativeDirectory = relative(rootRealPath, directoryRealPath);
if (
  relativeDirectory.length === 0 ||
  relativeDirectory === ".." ||
  relativeDirectory.startsWith(`..${sep}`) ||
  relativeDirectory.includes(`${sep}..${sep}`)
) {
  throw new TypeError("The audio directory must stay inside data/闲时任务/音频");
}

const entries = await readdir(directoryRealPath, { withFileTypes: true });
for (const entry of entries
  .filter((candidate) => candidate.isFile())
  .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))) {
  const portableDirectory = relativeDirectory.split(sep).join("/");
  process.stdout.write(
    `${JSON.stringify(`data/闲时任务/音频/${portableDirectory}/${entry.name}`)},\n`,
  );
}
