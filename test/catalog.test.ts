import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeCatalog, encodeCatalog } from "../src/catalog-format.js";
import { assertEmbedded, assertEmbeddingModel, loadCatalog } from "../src/catalog.js";
import { makeCatalog, OPS } from "./helpers.js";

describe("catalog format", () => {
  it("round-trips header, operations and vectors", () => {
    const cat = makeCatalog();
    const buf = encodeCatalog(cat.header, cat.operations, cat.vectors);
    const decoded = decodeCatalog(buf);
    expect(decoded.header).toEqual(cat.header);
    expect(decoded.operations).toEqual(cat.operations);
    expect(Array.from(decoded.vectors)).toEqual(Array.from(cat.vectors));
    expect(decoded.byId.get("send_email")?.kind).toBe("write");
  });

  it("round-trips a no-embed catalog", () => {
    const cat = makeCatalog({ embedded: false });
    const buf = encodeCatalog(cat.header, cat.operations, new Float32Array(0));
    const decoded = decodeCatalog(buf);
    expect(decoded.header.embedded).toBe(false);
    expect(decoded.vectors.length).toBe(0);
  });

  it("rejects non-catalog files", () => {
    expect(() => decodeCatalog(Buffer.from("not a catalog at all"))).toThrow(/magic/);
  });

  it("rejects unsupported format versions", () => {
    const cat = makeCatalog();
    const buf = encodeCatalog(
      { ...cat.header, formatVersion: 2 as unknown as 1 },
      cat.operations,
      cat.vectors,
    );
    expect(() => decodeCatalog(buf)).toThrow(/formatVersion 2/);
  });

  it("rejects truncated vector sections", () => {
    const cat = makeCatalog();
    const buf = encodeCatalog(cat.header, cat.operations, cat.vectors);
    expect(() => decodeCatalog(buf.subarray(0, buf.length - 5))).toThrow(/corrupt|truncated/);
  });

  it("rejects header/body operation count mismatch", () => {
    const cat = makeCatalog();
    const buf = encodeCatalog(
      { ...cat.header, operationCount: OPS.length, dims: 4 },
      cat.operations.slice(0, 2),
      cat.vectors,
    );
    expect(() => decodeCatalog(buf)).toThrow(/operations/);
  });
});

describe("loadCatalog", () => {
  it("loads an artifact from disk and caches by path", () => {
    const dir = mkdtempSync(join(tmpdir(), "aisa-cat-"));
    const file = join(dir, "test.catalog");
    const cat = makeCatalog();
    writeFileSync(file, encodeCatalog(cat.header, cat.operations, cat.vectors));
    const loaded = loadCatalog(file);
    expect(loaded.header.embeddingModel).toBe("jina-embeddings-v3");
    expect(loadCatalog(file)).toBe(loaded);
  });

  it("gives a rebuild hint when the file is missing", () => {
    expect(() => loadCatalog("/definitely/not/here.catalog")).toThrow(/build-catalog/);
  });
});

describe("stamp guards", () => {
  it("refuses an embedding-model override that differs from the stamp", () => {
    const cat = makeCatalog();
    expect(() => assertEmbeddingModel(cat, "text-embedding-3-small")).toThrow(
      /jina-embeddings-v3.*text-embedding-3-small|text-embedding-3-small.*jina-embeddings-v3/s,
    );
    expect(() => assertEmbeddingModel(cat, "jina-embeddings-v3")).not.toThrow();
  });

  it("refuses retrieval on a vectorless catalog", () => {
    expect(() => assertEmbedded(makeCatalog({ embedded: false }))).toThrow(/without embeddings/);
    expect(() => assertEmbedded(makeCatalog())).not.toThrow();
  });
});
