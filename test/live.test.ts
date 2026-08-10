import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/catalog.js";
import { createPlan } from "../src/planner.js";
import { retrieveOperations } from "../src/retrieval.js";

/**
 * Live tests against api.aisa.one — need a real key and a catalog built with
 * embeddings. Run with:  AISA_LIVE=1 AISA_API_KEY=... npm test
 */
const CATALOG_PATH = new URL("../catalogs/aisa-jina-v3.catalog", import.meta.url).pathname;
const catalogReady =
  existsSync(CATALOG_PATH) && (() => {
    try {
      return loadCatalog(CATALOG_PATH).header.embedded;
    } catch {
      return false;
    }
  })();
const live = Boolean(process.env.AISA_LIVE && process.env.AISA_API_KEY) && catalogReady;

function logTopK(label: string, results: { operationId: string; tag: string; score: number }[]) {
  console.log(`top-${results.length} for ${label}:`);
  for (const r of results) {
    console.log(`  ${r.score.toFixed(4)}  ${r.tag.padEnd(20)} ${r.operationId}`);
  }
}

describe.skipIf(!live)("live retrieval (Phase 1 acceptance)", () => {
  // Retrieval is pure cosine top-K: a single topical intent must surface its
  // source family. A compound intent competes in ONE embedding, so per-topic
  // coverage there is the planner/caller's job (tags filter, higher topK, or
  // per-sub-intent retrieval) — not something top-K promises.
  it("surfaces Scholar Search ops for the papers half of the canonical intent", async () => {
    const results = await retrieveOperations("find recent papers about LLM agents", { topK: 8 });
    logTopK("papers intent", results);
    expect(results.map((r) => r.tag)).toContain("Scholar Search");
  });

  it("surfaces Prediction Markets ops for the markets half of the canonical intent", async () => {
    const results = await retrieveOperations("check related prediction markets", { topK: 8 });
    logTopK("prediction-markets intent", results);
    expect(results.map((r) => r.tag)).toContain("Prediction Markets");
  });

  it("returns a well-formed descending ranking for the compound canonical intent", async () => {
    const results = await retrieveOperations(
      "find recent papers about LLM agents and check related prediction markets",
      { topK: 12 },
    );
    logTopK("compound intent (diagnostic)", results);
    expect(results).toHaveLength(12);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
    for (const r of results) {
      expect(r.score).toBeGreaterThan(-1.0001);
      expect(r.score).toBeLessThan(1.0001);
    }
  });
});

describe.skipIf(!live)("live planning (Phase 3 canonical intents)", () => {
  it("single-source lookup: crypto price", async () => {
    const result = await createPlan("what is the current price of bitcoin in USD?");
    expect(result.validation.ok).toBe(true);
    expect(result.plan.steps.length).toBeGreaterThanOrEqual(1);
    for (const s of result.validation.steps) expect(s.exists).toBe(true);
  });

  it("two-source research: papers + prediction markets", async () => {
    const result = await createPlan(
      "find recent papers about LLM agents and check related prediction markets",
    );
    expect(result.validation.ok).toBe(true);
    const tags = new Set(result.plan.steps.map((s) => s.summary && s.path?.split("/")[1]));
    expect(result.plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(tags.size).toBeGreaterThanOrEqual(2);
  });

  it("write-warning intent: emailing a digest must surface a ⚠", async () => {
    const result = await createPlan(
      "summarize this week's AI news and email the digest to team@example.com",
    );
    const warnings = result.validation.steps.flatMap((s) => s.warnings);
    expect(warnings.join("\n")).toMatch(/write operation|sends/i);
    expect(result.exportMarkdown()).toContain("⚠");
  });
});
