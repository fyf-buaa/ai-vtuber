import {
  brotliCompressSync,
  constants as zlibConstants,
  deflateSync,
} from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  BILIBILI_PROTOCOL_LIMITS,
  decodeBilibiliFrames,
  encodeBilibiliPacket,
} from "../src/platforms/bilibili-protocol.js";
import type { WebSocketConnection } from "../src/platforms/types.js";

const OPERATION_MESSAGE = 5;
const HEADER_LENGTH = 16;
const LIMIT_ERROR_MESSAGE =
  "Bilibili WebSocket frame exceeds protocol decoding limits";
const COMPRESSED_PACKET_ERROR_MESSAGE =
  "Bilibili WebSocket compressed packet is invalid or exceeds protocol decoding limits";
const CONNECTION = {} as WebSocketConnection;

const COMPRESSION_CASES = [
  { label: "deflate", version: 2 as const },
  { label: "brotli", version: 3 as const },
];

type CompressionVersion = (typeof COMPRESSION_CASES)[number]["version"];

function protocolPacket(
  version: number,
  operation: number,
  body: string | Uint8Array,
): Buffer {
  const packet = Buffer.from(encodeBilibiliPacket(operation, body));
  packet.writeUInt16BE(version, 6);
  return packet;
}

function compressedPacket(
  version: CompressionVersion,
  decoded: Uint8Array,
): Buffer {
  const body =
    version === 2
      ? deflateSync(decoded, { level: 1 })
      : brotliCompressSync(decoded, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 1,
          },
        });
  return protocolPacket(version, OPERATION_MESSAGE, body);
}

function decodeBinary(frame: Uint8Array): Promise<readonly unknown[]> {
  return decodeBilibiliFrames(frame, true, CONNECTION);
}

describe("Bilibili protocol decode bounds", () => {
  it.each(COMPRESSION_CASES)(
    "decodes a valid $label-compressed packet",
    async ({ version }) => {
      const payload = { cmd: "DANMU_MSG", message: "hello" };
      const inner = protocolPacket(
        0,
        OPERATION_MESSAGE,
        JSON.stringify(payload),
      );

      await expect(decodeBinary(compressedPacket(version, inner))).resolves.toEqual(
        [payload],
      );
    },
  );

  it.each(COMPRESSION_CASES)(
    "maps a tiny $label bomb to a bounded protocol error",
    async ({ version }) => {
      const expanded = Buffer.alloc(
        BILIBILI_PROTOCOL_LIMITS.maximumDecompressedPacketBytes + 1,
        0x61,
      );
      const frame = compressedPacket(version, expanded);

      expect(frame.byteLength).toBeLessThan(64 * 1024);
      await expect(decodeBinary(frame)).rejects.toThrowError(
        COMPRESSED_PACKET_ERROR_MESSAGE,
      );
    },
  );

  it("rejects an oversized compressed body before decompression", async () => {
    const compressedBody = Buffer.alloc(
      BILIBILI_PROTOCOL_LIMITS.maximumCompressedPacketBytes + 1,
      0x61,
    );
    const frame = protocolPacket(2, OPERATION_MESSAGE, compressedBody);

    await expect(decodeBinary(frame)).rejects.toThrowError(LIMIT_ERROR_MESSAGE);
  });

  it("shares the decoded-byte budget across nested packets", async () => {
    const layerBytes = 3 * 1024 * 1024;
    const paddingPacket = protocolPacket(
      0,
      0,
      Buffer.alloc(layerBytes - HEADER_LENGTH),
    );
    let nested = protocolPacket(
      0,
      OPERATION_MESSAGE,
      JSON.stringify({ cmd: "NOTICE_MSG" }),
    );

    expect(layerBytes * 3).toBeGreaterThan(
      BILIBILI_PROTOCOL_LIMITS.maximumTotalDecodedBytes,
    );
    for (let depth = 0; depth < 3; depth += 1) {
      const decodedLayer = Buffer.concat([paddingPacket, nested]);
      expect(decodedLayer.byteLength).toBeLessThanOrEqual(
        BILIBILI_PROTOCOL_LIMITS.maximumDecompressedPacketBytes,
      );
      nested = compressedPacket(2, decodedLayer);
    }

    await expect(decodeBinary(nested)).rejects.toThrowError(
      COMPRESSED_PACKET_ERROR_MESSAGE,
    );
  });

  it("shares the packet-count budget across nested streams", async () => {
    const ignoredPacket = protocolPacket(0, 0, "");
    const packetsPerLayer =
      Math.floor(BILIBILI_PROTOCOL_LIMITS.maximumPacketCount / 2) + 1;
    const packetBatch = Buffer.concat(
      Array.from({ length: packetsPerLayer }, () => ignoredPacket),
    );
    const inner = compressedPacket(2, packetBatch);
    const frame = compressedPacket(2, Buffer.concat([packetBatch, inner]));

    expect(packetsPerLayer).toBeLessThan(
      BILIBILI_PROTOCOL_LIMITS.maximumPacketCount,
    );
    await expect(decodeBinary(frame)).rejects.toThrowError(LIMIT_ERROR_MESSAGE);
  });

  it("allows the maximum compression depth and rejects one more layer", async () => {
    const payload = { cmd: "SUPER_CHAT_MESSAGE", id: "depth-boundary" };
    let nested = protocolPacket(
      0,
      OPERATION_MESSAGE,
      JSON.stringify(payload),
    );
    for (
      let depth = 0;
      depth < BILIBILI_PROTOCOL_LIMITS.maximumCompressionDepth;
      depth += 1
    ) {
      nested = compressedPacket(2, nested);
    }

    await expect(decodeBinary(nested)).resolves.toEqual([payload]);
    await expect(
      decodeBinary(compressedPacket(2, nested)),
    ).rejects.toThrowError(LIMIT_ERROR_MESSAGE);
  });

  it("validates packet lengths before slicing or recursively decoding", async () => {
    const invalidOuterHeader = Buffer.alloc(HEADER_LENGTH);
    invalidOuterHeader.writeUInt32BE(HEADER_LENGTH, 0);
    invalidOuterHeader.writeUInt16BE(HEADER_LENGTH + 1, 4);
    invalidOuterHeader.writeUInt16BE(2, 6);
    invalidOuterHeader.writeUInt32BE(OPERATION_MESSAGE, 8);

    await expect(decodeBinary(invalidOuterHeader)).rejects.toThrowError(
      "Bilibili WebSocket packet has invalid lengths",
    );

    const invalidInnerHeader = protocolPacket(0, 0, "");
    invalidInnerHeader.writeUInt32BE(invalidInnerHeader.byteLength + 1, 0);
    await expect(
      decodeBinary(compressedPacket(2, invalidInnerHeader)),
    ).rejects.toThrowError("Bilibili WebSocket packet has invalid lengths");
  });
});
