import { embedTexts, resolveApiKey } from "./aisa-client.js";
import { assertEmbedded, assertEmbeddingModel, loadCatalog } from "./catalog.js";
import type { Catalog, ScoredOperation } from "./types.js";

export interface RetrieveOptions {
  /** Explicit key; falls back to the AISA_API_KEY environment variable. */
  apiKey?: string;
  topK?: number;
  /** Restrict candidates to these catalog tags (applied before ranking). */
  tags?: string[];
  /** Preloaded catalog (or a path via catalogPath); defaults to the bundled artifact. */
  catalog?: Catalog;
  catalogPath?: string;
  /**
   * Escape hatch for query-embedding model override. The runtime normally
   * reads the model from the catalog stamp; an override that differs from the
   * stamp is refused outright.
   */
  embeddingModel?: string;
  /** Override the inference base URL (testing). */
  baseURL?: string;
  /**
   * Tag-diversity cap (default true): at most max(2, ⌈topK/4⌉) results per
   * tag, remaining slots filled by pure score. Without it the 400+-operation
   * SEO family crowds every search-flavoured intent out of the top-K.
   */
  diversify?: boolean;
}

function cosine(vectors: Float32Array, row: number, dims: number, query: number[]): number {
  let dot = 0;
  let normV = 0;
  let normQ = 0;
  const offset = row * dims;
  for (let i = 0; i < dims; i++) {
    const v = vectors[offset + i]!;
    const q = query[i]!;
    dot += v * q;
    normV += v * v;
    normQ += q * q;
  }
  const denom = Math.sqrt(normV) * Math.sqrt(normQ);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embed the intent with the model stamped in the catalog and return the
 * top-K operations by cosine similarity, optionally filtered by tag first.
 */
export async function retrieveOperations(
  intent: string,
  opts: RetrieveOptions = {},
): Promise<ScoredOperation[]> {
  const catalog = opts.catalog ?? loadCatalog(opts.catalogPath);
  assertEmbedded(catalog);
  // The query model always comes from the catalog stamp; an explicit override
  // must match it exactly or retrieval refuses to run.
  if (opts.embeddingModel !== undefined) assertEmbeddingModel(catalog, opts.embeddingModel);
  const model = catalog.header.embeddingModel;
  const apiKey = resolveApiKey(opts.apiKey);
  const topK = opts.topK ?? 12;

  const [query] = await embedTexts([intent], { apiKey, model, baseURL: opts.baseURL });
  if (!query || query.length !== catalog.header.dims) {
    throw new Error(
      `Query embedding has ${query?.length ?? 0} dims but the catalog was built with ${catalog.header.dims}. ` +
        `The embeddings endpoint may not be serving "${model}" as stamped.`,
    );
  }

  const tagSet = opts.tags && opts.tags.length > 0
    ? new Set(opts.tags.map((t) => t.toLowerCase()))
    : undefined;

  const scored: ScoredOperation[] = [];
  for (let i = 0; i < catalog.operations.length; i++) {
    const op = catalog.operations[i]!;
    if (tagSet && !tagSet.has(op.tag.toLowerCase())) continue;
    scored.push({ ...op, score: cosine(catalog.vectors, i, catalog.header.dims, query) });
  }
  scored.sort((a, b) => b.score - a.score);

  if (!(opts.diversify ?? true)) return scored.slice(0, topK);

  // Two passes: score order under a per-tag cap, then backfill by pure score.
  // A single-tag candidate set degrades to exact score order.
  const maxPerTag = Math.max(2, Math.ceil(topK / 4));
  const picked: ScoredOperation[] = [];
  const overflow: ScoredOperation[] = [];
  const perTag = new Map<string, number>();
  for (const op of scored) {
    if (picked.length === topK) break;
    const count = perTag.get(op.tag) ?? 0;
    if (count < maxPerTag) {
      picked.push(op);
      perTag.set(op.tag, count + 1);
    } else {
      overflow.push(op);
    }
  }
  for (const op of overflow) {
    if (picked.length === topK) break;
    picked.push(op);
  }
  return picked;
}

/** Distinct tags in the catalog with operation counts — no key, no network. */
export function listSources(catalog?: Catalog): { tag: string; count: number; example: string }[] {
  const cat = catalog ?? loadCatalog();
  const byTag = new Map<string, { count: number; example: string }>();
  for (const op of cat.operations) {
    const entry = byTag.get(op.tag);
    if (entry) {
      entry.count += 1;
    } else {
      byTag.set(op.tag, { count: 1, example: op.summary || op.operationId });
    }
  }
  return [...byTag.entries()]
    .map(([tag, { count, example }]) => ({ tag, count, example }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}
