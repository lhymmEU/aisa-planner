import { gzipSync, gunzipSync } from "node:zlib";
import type { Catalog, CatalogHeader, Operation } from "./types.js";

/**
 * Binary catalog layout (all integers little-endian):
 *
 *   bytes 0–7    magic "AISACAT\x01"
 *   uint32       header JSON byte length
 *   ...          header JSON (CatalogHeader)
 *   uint32       gzipped operations JSON byte length
 *   ...          gzipped operations JSON (Operation[])
 *   ...          vectors as raw Float32Array (operationCount * dims * 4 bytes),
 *                row-major, aligned with the operations array; empty if !embedded
 */
const MAGIC = Buffer.from("AISACAT\x01", "latin1");

export function encodeCatalog(
  header: CatalogHeader,
  operations: Operation[],
  vectors: Float32Array,
): Buffer {
  if (header.embedded && vectors.length !== header.operationCount * header.dims) {
    throw new Error(
      `Vector length ${vectors.length} does not match operationCount ${header.operationCount} × dims ${header.dims}`,
    );
  }
  const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
  const opsBuf = gzipSync(Buffer.from(JSON.stringify(operations), "utf8"), { level: 9 });
  const vecBuf = Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength);

  const lenHeader = Buffer.alloc(4);
  lenHeader.writeUInt32LE(headerBuf.length);
  const lenOps = Buffer.alloc(4);
  lenOps.writeUInt32LE(opsBuf.length);

  return Buffer.concat([MAGIC, lenHeader, headerBuf, lenOps, opsBuf, vecBuf]);
}

export function decodeCatalog(buf: Buffer): Catalog {
  if (buf.length < MAGIC.length + 8 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(
      "Not an aisa-planner catalog file (bad magic bytes). " +
        "Regenerate it with: aisa-planner build-catalog",
    );
  }
  let off = MAGIC.length;
  const headerLen = buf.readUInt32LE(off);
  off += 4;
  const header = JSON.parse(buf.subarray(off, off + headerLen).toString("utf8")) as CatalogHeader;
  off += headerLen;

  if (header.formatVersion !== 1) {
    throw new Error(
      `Unsupported catalog formatVersion ${String(header.formatVersion)}; this build of aisa-planner supports version 1. ` +
        "Update aisa-planner or rebuild the catalog.",
    );
  }

  const opsLen = buf.readUInt32LE(off);
  off += 4;
  const operations = JSON.parse(
    gunzipSync(buf.subarray(off, off + opsLen)).toString("utf8"),
  ) as Operation[];
  off += opsLen;

  const vecBytes = buf.length - off;
  const expected = header.embedded ? header.operationCount * header.dims * 4 : 0;
  if (vecBytes !== expected) {
    throw new Error(
      `Catalog vector section is ${vecBytes} bytes but header expects ${expected} ` +
        `(${header.operationCount} operations × ${header.dims} dims). The file is corrupt or truncated.`,
    );
  }
  if (operations.length !== header.operationCount) {
    throw new Error(
      `Catalog header says ${header.operationCount} operations but body contains ${operations.length}.`,
    );
  }

  // Copy so alignment does not depend on the section offset within the file.
  const vecSrc = buf.subarray(off);
  const vectors = new Float32Array(vecBytes / 4);
  for (let i = 0; i < vectors.length; i++) vectors[i] = vecSrc.readFloatLE(i * 4);

  const byId = new Map<string, Operation>();
  for (const op of operations) byId.set(op.operationId, op);

  return { header, operations, vectors, byId };
}
