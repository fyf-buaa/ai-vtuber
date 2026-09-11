import { brotliDecompressSync, inflateSync } from "node:zlib";

import type { WebSocketConnection } from "./types.js";
import { isRecord, PlatformConnectionError } from "./utilities.js";
import {
  decodeWebSocketText,
  type WebSocketAcknowledgement,
} from "./websocket-client.js";

export interface BilibiliProtocolMarker {
  readonly bilibiliProtocol: "authenticated" | "heartbeat";
  readonly code?: number;
  readonly message?: string;
}

const HEADER_LENGTH = 16;
export const BILIBILI_PROTOCOL_LIMITS = Object.freeze({
  maximumCompressedPacketBytes: 1024 * 1024,
  maximumDecompressedPacketBytes: 4 * 1024 * 1024,
  maximumTotalDecodedBytes: 8 * 1024 * 1024,
  maximumPacketCount: 4_096,
  maximumCompressionDepth: 4,
});
const DECODE_LIMIT_ERROR_MESSAGE =
  "Bilibili WebSocket frame exceeds protocol decoding limits";
const COMPRESSED_PACKET_ERROR_MESSAGE =
  "Bilibili WebSocket compressed packet is invalid or exceeds protocol decoding limits";
const OPERATION_HEARTBEAT_REPLY = 3;
const OPERATION_MESSAGE = 5;
const OPERATION_AUTH_REPLY = 8;

export function encodeBilibiliPacket(
  operation: number,
  body: string | Uint8Array,
): Uint8Array {
  const payload = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
  const packet = Buffer.allocUnsafe(HEADER_LENGTH + payload.byteLength);
  packet.writeUInt32BE(packet.byteLength, 0);
  packet.writeUInt16BE(HEADER_LENGTH, 4);
  packet.writeUInt16BE(1, 6);
  packet.writeUInt32BE(operation, 8);
  packet.writeUInt32BE(1, 12);
  payload.copy(packet, HEADER_LENGTH);
  return packet;
}

export function createBilibiliAcknowledgement(
  platform: string,
): WebSocketAcknowledgement {
  return (payload) => {
    const marker = bilibiliMarker(payload);
    if (marker?.bilibiliProtocol !== "authenticated") {
      return false;
    }
    if (marker.code !== 0) {
      return new PlatformConnectionError(
        platform,
        `Bilibili rejected WebSocket authentication (${marker.code ?? "missing code"}): ${marker.message ?? "unknown error"}`,
      );
    }
    return true;
  };
}

function bilibiliMarker(payload: unknown): BilibiliProtocolMarker | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (
    payload.bilibiliProtocol !== "authenticated" &&
    payload.bilibiliProtocol !== "heartbeat"
  ) {
    return undefined;
  }
  const code = typeof payload.code === "number" ? payload.code : undefined;
  const message =
    typeof payload.message === "string" ? payload.message : undefined;
  return {
    bilibiliProtocol: payload.bilibiliProtocol,
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
}

export async function decodeBilibiliFrames(
  data: unknown,
  isBinary: boolean,
  _connection: WebSocketConnection,
): Promise<readonly unknown[]> {
  if (!isBinary && typeof data === "string") {
    const text = data.trim();
    return text.length === 0 ? [] : [JSON.parse(text) as unknown];
  }
  const bytes = await webSocketBytes(data);
  if (
    bytes.byteLength > BILIBILI_PROTOCOL_LIMITS.maximumTotalDecodedBytes
  ) {
    throw decodeLimitError();
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.byteLength > 0 && (buffer[0] === 0x7b || buffer[0] === 0x5b)) {
    const text = buffer.toString("utf8").trim();
    return text.length === 0 ? [] : [JSON.parse(text) as unknown];
  }
  return decodePackets(buffer);
}

interface DecodeBudget {
  remainingDecodedBytes: number;
  remainingPackets: number;
}

function decodePackets(bytes: Buffer): readonly unknown[] {
  const payloads: unknown[] = [];
  decodePacketStream(
    bytes,
    {
      remainingDecodedBytes:
        BILIBILI_PROTOCOL_LIMITS.maximumTotalDecodedBytes,
      remainingPackets: BILIBILI_PROTOCOL_LIMITS.maximumPacketCount,
    },
    0,
    payloads,
  );
  return payloads;
}

function decodePacketStream(
  bytes: Buffer,
  budget: DecodeBudget,
  compressionDepth: number,
  payloads: unknown[],
): void {
  if (bytes.byteLength > budget.remainingDecodedBytes) {
    throw decodeLimitError();
  }
  budget.remainingDecodedBytes -= bytes.byteLength;

  let offset = 0;
  while (offset < bytes.byteLength) {
    const remainingPacketBytes = bytes.byteLength - offset;
    if (remainingPacketBytes < HEADER_LENGTH) {
      throw new Error("Bilibili WebSocket frame ended inside a packet header");
    }
    const packetLength = bytes.readUInt32BE(offset);
    const headerLength = bytes.readUInt16BE(offset + 4);
    const version = bytes.readUInt16BE(offset + 6);
    const operation = bytes.readUInt32BE(offset + 8);
    if (
      packetLength < HEADER_LENGTH ||
      headerLength < HEADER_LENGTH ||
      headerLength > packetLength ||
      packetLength > remainingPacketBytes
    ) {
      throw new Error("Bilibili WebSocket packet has invalid lengths");
    }
    if (budget.remainingPackets === 0) {
      throw decodeLimitError();
    }
    budget.remainingPackets -= 1;

    const body = bytes.subarray(offset + headerLength, offset + packetLength);
    if (version === 2 || version === 3) {
      if (
        body.byteLength >
        BILIBILI_PROTOCOL_LIMITS.maximumCompressedPacketBytes
      ) {
        throw decodeLimitError();
      }
      if (
        compressionDepth >=
        BILIBILI_PROTOCOL_LIMITS.maximumCompressionDepth
      ) {
        throw decodeLimitError();
      }
      const maximumOutputLength = Math.min(
        BILIBILI_PROTOCOL_LIMITS.maximumDecompressedPacketBytes,
        budget.remainingDecodedBytes,
      );
      if (maximumOutputLength <= 0) {
        throw decodeLimitError();
      }
      const decompressed = decompressPacket(
        body,
        version,
        maximumOutputLength,
      );
      decodePacketStream(
        decompressed,
        budget,
        compressionDepth + 1,
        payloads,
      );
    } else if (operation === OPERATION_MESSAGE) {
      for (const payload of parseJsonBodies(body)) {
        payloads.push(payload);
      }
    } else if (operation === OPERATION_AUTH_REPLY) {
      const response = parseFirstJson(body);
      const code =
        typeof response === "object" &&
        response !== null &&
        "code" in response &&
        typeof response.code === "number"
          ? response.code
          : undefined;
      const message =
        typeof response === "object" &&
        response !== null &&
        "message" in response &&
        typeof response.message === "string"
          ? response.message
          : undefined;
      payloads.push({
        bilibiliProtocol: "authenticated",
        ...(code === undefined ? {} : { code }),
        ...(message === undefined ? {} : { message }),
      } satisfies BilibiliProtocolMarker);
    } else if (operation === OPERATION_HEARTBEAT_REPLY) {
      payloads.push({
        bilibiliProtocol: "heartbeat",
      } satisfies BilibiliProtocolMarker);
    }
    offset += packetLength;
  }
}

function decompressPacket(
  body: Buffer,
  version: 2 | 3,
  maximumOutputLength: number,
): Buffer {
  try {
    return version === 2
      ? inflateSync(body, { maxOutputLength: maximumOutputLength })
      : brotliDecompressSync(body, { maxOutputLength: maximumOutputLength });
  } catch (cause) {
    throw new Error(COMPRESSED_PACKET_ERROR_MESSAGE, { cause });
  }
}

function decodeLimitError(): Error {
  return new Error(DECODE_LIMIT_ERROR_MESSAGE);
}

function parseJsonBodies(body: Uint8Array): readonly unknown[] {
  const text = Buffer.from(body).toString("utf8").replace(/\0+$/u, "").trim();
  if (text.length === 0) {
    return [];
  }
  try {
    return [JSON.parse(text) as unknown];
  } catch (wholeError) {
    const lines = text.split(/\0|\r?\n/u).filter((line) => line.trim().length > 0);
    if (lines.length < 2) {
      throw new Error("Bilibili event packet does not contain valid JSON", {
        cause: wholeError,
      });
    }
    return lines.map((line) => JSON.parse(line) as unknown);
  }
}

function parseFirstJson(body: Uint8Array): unknown {
  const parsed = parseJsonBodies(body);
  return parsed[0];
}

async function webSocketBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    const chunks = await Promise.all(data.map((chunk) => webSocketBytes(chunk)));
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (typeof data === "string") {
    return Buffer.from(await decodeWebSocketText(data));
  }
  throw new TypeError(`Unsupported Bilibili WebSocket data type: ${typeof data}`);
}
