import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeCatalog } from "./catalog-format.js";
import type { Catalog } from "./types.js";

export const BUNDLED_CATALOG_NAME = "aisa-jina-v3.catalog";

function bundledCatalogPath(): string {
  // dist/ and catalogs/ are siblings inside the published package.
  return fileURLToPath(new URL(`../catalogs/${BUNDLED_CATALOG_NAME}`, import.meta.url));
}

let cached: { path: string; catalog: Catalog } | undefined;

/**
 * Load a catalog artifact from disk (defaults to the catalog bundled with the
 * package) and validate its stamp. Throws with a descriptive message on
 * format-version mismatch or corruption.
 */
export function loadCatalog(path?: string): Catalog {
  const resolved = path ?? bundledCatalogPath();
  if (cached?.path === resolved) return cached.catalog;
  let buf: Buffer;
  try {
    buf = readFileSync(resolved);
  } catch (err) {
    throw new Error(
      `Cannot read catalog at ${resolved}: ${err instanceof Error ? err.message : String(err)}. ` +
        `If this is a fresh checkout, build it with: aisa-planner build-catalog --out ${resolved}`,
    );
  }
  const catalog = decodeCatalog(buf);
  cached = { path: resolved, catalog };
  return catalog;
}

/**
 * Refuse to run when the embedding model the runtime intends to use for
 * queries differs from the model stamped into the catalog. Same-dimension
 * model swaps are silent failures otherwise — this is the guard the catalog
 * stamp exists for.
 */
export function assertEmbeddingModel(catalog: Catalog, runtimeModel: string): void {
  if (runtimeModel !== catalog.header.embeddingModel) {
    throw new Error(
      `Embedding model mismatch: the catalog was built with "${catalog.header.embeddingModel}" ` +
        `but the runtime was asked to embed queries with "${runtimeModel}". ` +
        `Query vectors and catalog vectors must come from the same model. ` +
        `Either drop the override or rebuild the catalog: ` +
        `aisa-planner build-catalog --model ${runtimeModel}`,
    );
  }
}

/**
 * Refuse retrieval on a catalog that has no vectors (built with --no-embed).
 */
export function assertEmbedded(catalog: Catalog): void {
  if (!catalog.header.embedded || catalog.vectors.length === 0) {
    throw new Error(
      `This catalog was built without embeddings (no AISA_API_KEY at build time), ` +
        `so semantic retrieval is unavailable. Rebuild it with a key: ` +
        `AISA_API_KEY=... aisa-planner build-catalog`,
    );
  }
}
