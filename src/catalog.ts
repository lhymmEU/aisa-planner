import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeCatalog } from "./catalog-format.js";
import type { Catalog } from "./types.js";

export const BUNDLED_CATALOG_NAME = "aisa-jina-v3.catalog";

/**
 * Where the catalog lives by default: the AISA_PLANNER_CATALOG environment
 * variable when set, else the artifact bundled with the package (dist/ and
 * catalogs/ are siblings inside the published package). `build-catalog`
 * writes here by default too, so rebuild + plan compose without extra flags.
 */
export function defaultCatalogPath(): string {
  const fromEnv = process.env.AISA_PLANNER_CATALOG;
  if (fromEnv) return fromEnv;
  return fileURLToPath(new URL(`../catalogs/${BUNDLED_CATALOG_NAME}`, import.meta.url));
}

/**
 * Candidate locations for READING the catalog, most specific first. Bundling
 * runtimes (eve dev snapshots, Next.js, …) relocate this module's code, so
 * the import.meta.url-relative path stops working there; module resolution
 * and a cwd-upward walk still find the real node_modules install.
 */
export function catalogReadCandidates(cwd: string = process.cwd()): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env.AISA_PLANNER_CATALOG;
  if (fromEnv) candidates.push(fromEnv);
  try {
    candidates.push(fileURLToPath(new URL(`../catalogs/${BUNDLED_CATALOG_NAME}`, import.meta.url)));
  } catch {
    // import.meta.url may be unusable inside some bundles
  }
  try {
    candidates.push(
      createRequire(import.meta.url).resolve(`aisa-planner/catalogs/${BUNDLED_CATALOG_NAME}`),
    );
  } catch {
    // not resolvable (bundled without node_modules access, or exports blocked)
  }
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    candidates.push(join(dir, "node_modules", "aisa-planner", "catalogs", BUNDLED_CATALOG_NAME));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set(candidates)];
}

function resolveCatalogForRead(): string {
  const candidates = catalogReadCandidates();
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Cannot find the aisa-planner catalog. Tried:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
      `Set AISA_PLANNER_CATALOG to the artifact's absolute path (in a bundling runtime ` +
      `this is usually <project>/node_modules/aisa-planner/catalogs/${BUNDLED_CATALOG_NAME}), ` +
      `pass { catalogPath }, or rebuild one with: aisa-planner build-catalog`,
  );
}

let cached: { path: string; catalog: Catalog } | undefined;

/**
 * Load a catalog artifact from disk (defaults to searching the read
 * candidates: AISA_PLANNER_CATALOG, the bundled artifact, module resolution,
 * then a cwd-upward node_modules walk) and validate its stamp. Throws with a
 * descriptive message on format-version mismatch or corruption.
 */
export function loadCatalog(path?: string): Catalog {
  const resolved = path ?? resolveCatalogForRead();
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
        `so semantic retrieval is unavailable. Rebuild it with a key — by default this ` +
        `regenerates the catalog in place so \`plan\` picks it up directly: ` +
        `AISA_API_KEY=... aisa-planner build-catalog` +
        ` (or use --out FILE and point at it with --catalog FILE / catalogPath / AISA_PLANNER_CATALOG=FILE)`,
    );
  }
}
