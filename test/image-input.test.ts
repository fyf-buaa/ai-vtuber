import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { normalizePiImages } from "../src/agent/image-input.js";
import type { AgentRequest } from "../src/domain/types.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const temporaryDirectories: string[] = [];

interface ImageFixture {
  readonly allowedRoot: string;
  readonly allowedImage: string;
  readonly outsideDirectory: string;
  readonly outsideImage: string;
}

function imageRequest(
  images: readonly string[],
  metadata?: Readonly<Record<string, unknown>>,
): AgentRequest {
  return {
    sessionId: "image-test",
    username: "tester",
    content: "describe the image",
    images,
    ...(metadata ? { metadata } : {}),
  };
}

async function createImageFixture(): Promise<ImageFixture> {
  const directory = await mkdtemp(join(tmpdir(), "ai-vtuber-images-"));
  temporaryDirectories.push(directory);
  const allowedRoot = join(directory, "allowed");
  const outsideDirectory = join(directory, "outside");
  await Promise.all([
    mkdir(allowedRoot, { recursive: true }),
    mkdir(outsideDirectory, { recursive: true }),
  ]);
  const allowedImage = join(allowedRoot, "inside.png");
  const outsideImage = join(outsideDirectory, "outside.png");
  await Promise.all([
    writeFile(allowedImage, PNG_BYTES),
    writeFile(outsideImage, PNG_BYTES),
  ]);
  return {
    allowedRoot,
    allowedImage,
    outsideDirectory,
    outsideImage,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("normalizePiImages", () => {
  it("keeps visual data URLs available with local files disabled", async () => {
    await expect(
      normalizePiImages(
        imageRequest([`data:image/png;base64,${PNG_BASE64}`]),
      ),
    ).resolves.toEqual([
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ]);
  });

  it("refuses local paths and file URLs by default", async () => {
    const fixture = await createImageFixture();

    await expect(
      normalizePiImages(imageRequest([fixture.allowedImage])),
    ).rejects.toMatchObject({
      code: "configuration",
      message: expect.stringContaining("localImageRoots"),
    });
    await expect(
      normalizePiImages(
        imageRequest([pathToFileURL(fixture.allowedImage).href]),
      ),
    ).rejects.toMatchObject({
      code: "configuration",
      message: expect.stringContaining("localImageRoots"),
    });
  });

  it("reads regular images through an explicit canonical root", async () => {
    const fixture = await createImageFixture();

    await expect(
      normalizePiImages(imageRequest([fixture.allowedImage]), {
        localImageRoots: [fixture.allowedRoot],
      }),
    ).resolves.toEqual([
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ]);
    await expect(
      normalizePiImages(
        imageRequest([pathToFileURL(fixture.allowedImage).href]),
        { localImageRoots: [fixture.allowedRoot] },
      ),
    ).resolves.toEqual([
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ]);
  });

  it("rejects non-local or decorated file URLs", async () => {
    const fixture = await createImageFixture();
    const decoratedUrl = pathToFileURL(fixture.allowedImage);
    decoratedUrl.search = "?version=1";

    for (const source of [
      "file://example.com/image.png",
      decoratedUrl.href,
    ]) {
      await expect(
        normalizePiImages(imageRequest([source]), {
          localImageRoots: [fixture.allowedRoot],
        }),
      ).rejects.toMatchObject({
        code: "configuration",
        message: expect.stringContaining("invalid file URL"),
      });
    }
  });

  it("rejects outside paths and symlink escapes", async () => {
    const fixture = await createImageFixture();

    await expect(
      normalizePiImages(imageRequest([fixture.outsideImage]), {
        localImageRoots: [fixture.allowedRoot],
      }),
    ).rejects.toMatchObject({
      code: "configuration",
      message: expect.stringContaining("outside"),
    });

    const escape = join(fixture.allowedRoot, "escape");
    await symlink(
      fixture.outsideDirectory,
      escape,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      normalizePiImages(imageRequest([join(escape, "outside.png")]), {
        localImageRoots: [fixture.allowedRoot],
      }),
    ).rejects.toMatchObject({
      code: "configuration",
      message: expect.stringContaining("outside"),
    });
  });

  it("rejects roots themselves and non-image regular files", async () => {
    const fixture = await createImageFixture();
    const textFile = join(fixture.allowedRoot, "fake.png");
    await writeFile(textFile, "not an image", "utf8");

    await expect(
      normalizePiImages(imageRequest([fixture.allowedRoot]), {
        localImageRoots: [fixture.allowedRoot],
      }),
    ).rejects.toMatchObject({
      code: "configuration",
      message: expect.stringContaining("root instead of a file"),
    });
    await expect(
      normalizePiImages(
        imageRequest([textFile], { imageMimeType: "image/png" }),
        { localImageRoots: [fixture.allowedRoot] },
      ),
    ).rejects.toMatchObject({
      code: "configuration",
      message: expect.stringContaining("not a recognized image"),
    });
  });

  it("rejects oversized data URLs, raw base64, and files consistently", async () => {
    const fixture = await createImageFixture();
    const maxImageBytes = PNG_BYTES.byteLength - 1;
    const expectedMessage = `Image 1 exceeds the ${maxImageBytes}-byte limit`;

    await expect(
      normalizePiImages(
        imageRequest([`data:image/png;base64,${PNG_BASE64}`]),
        { maxImageBytes },
      ),
    ).rejects.toMatchObject({
      code: "configuration",
      message: expectedMessage,
    });
    await expect(
      normalizePiImages(imageRequest([PNG_BASE64]), { maxImageBytes }),
    ).rejects.toMatchObject({
      code: "configuration",
      message: expectedMessage,
    });
    await expect(
      normalizePiImages(imageRequest([fixture.allowedImage]), {
        localImageRoots: [fixture.allowedRoot],
        maxImageBytes,
      }),
    ).rejects.toMatchObject({
      code: "configuration",
      message: expectedMessage,
    });
  });
});
