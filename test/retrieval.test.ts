import { afterEach, describe, expect, it, vi } from "vitest";
import { retrieveOperations, listSources } from "../src/retrieval.js";
import { embeddingResponse, makeCatalog, OPS } from "./helpers.js";
import type { Catalog, Operation } from "../src/types.js";

/** A catalog where one tag dominates: 5 "Big Tag" ops best-aligned to the
 * query axis, then 2 ops from small tags at slightly lower similarity. */
function crowdedCatalog(): Catalog {
  const mk = (id: string, tag: string): Operation => ({
    ...OPS[0]!,
    operationId: id,
    tag,
    summary: id,
  });
  const operations = [
    mk("big_1", "Big Tag"),
    mk("big_2", "Big Tag"),
    mk("big_3", "Big Tag"),
    mk("big_4", "Big Tag"),
    mk("big_5", "Big Tag"),
    mk("small_a", "Small A"),
    mk("small_b", "Small B"),
  ];
  // Query axis is [1,0,0,0]; big ops descend from 1.0, small ops sit at ~0.9.
  const vecs = [
    [1, 0, 0, 0],
    [0.99, 0.14, 0, 0],
    [0.98, 0.2, 0, 0],
    [0.97, 0.24, 0, 0],
    [0.96, 0.28, 0, 0],
    [0.9, 0.44, 0, 0],
    [0.88, 0.47, 0, 0],
  ];
  return {
    header: { ...makeCatalog().header, operationCount: operations.length },
    operations,
    vectors: Float32Array.from(vecs.flat()),
    byId: new Map(operations.map((o) => [o.operationId, o])),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("retrieveOperations", () => {
  it("ranks by cosine similarity against the catalog vectors", async () => {
    // Query vector aligned with search_papers' row.
    vi.stubGlobal("fetch", vi.fn(async () => embeddingResponse([0, 1, 0, 0])));
    const results = await retrieveOperations("papers about llm agents", {
      apiKey: "test-key",
      catalog: makeCatalog(),
      topK: 2,
    });
    expect(results.map((r) => r.operationId)).toEqual(["search_papers", expect.any(String)]);
    expect(results[0]?.score).toBeCloseTo(1, 5);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("applies the tag filter before ranking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => embeddingResponse([0, 1, 0, 0])));
    const results = await retrieveOperations("anything", {
      apiKey: "test-key",
      catalog: makeCatalog(),
      tags: ["Crypto Data"],
      topK: 5,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.operationId).toBe("get_crypto_price");
  });

  it("sends the stamped model and the caller's key to the embeddings endpoint", async () => {
    const fetchMock = vi.fn(async () => embeddingResponse([1, 0, 0, 0]));
    vi.stubGlobal("fetch", fetchMock);
    await retrieveOperations("x", { apiKey: "sk-abc", catalog: makeCatalog() });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.aisa.one/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-abc");
    expect(JSON.parse(String(init.body)).model).toBe("jina-embeddings-v3");
  });

  it("falls back to AISA_API_KEY and errors helpfully when absent", async () => {
    vi.stubEnv("AISA_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn());
    await expect(retrieveOperations("x", { catalog: makeCatalog() })).rejects.toThrow(
      /AISA_API_KEY/,
    );
  });

  it("refuses a mismatched embedding-model override before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      retrieveOperations("x", {
        apiKey: "k",
        catalog: makeCatalog(),
        embeddingModel: "some-other-model",
      }),
    ).rejects.toThrow(/mismatch/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a vectorless catalog before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      retrieveOperations("x", { apiKey: "k", catalog: makeCatalog({ embedded: false }) }),
    ).rejects.toThrow(/without embeddings/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a query vector with the wrong dimensionality", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => embeddingResponse([1, 0])));
    await expect(
      retrieveOperations("x", { apiKey: "k", catalog: makeCatalog() }),
    ).rejects.toThrow(/dims/);
  });

  it("caps a dominant tag so smaller relevant families reach the top-K", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => embeddingResponse([1, 0, 0, 0])));
    const results = await retrieveOperations("query", {
      apiKey: "k",
      catalog: crowdedCatalog(),
      topK: 4,
    });
    const tags = results.map((r) => r.tag);
    // max(2, ceil(4/4)) = 2 Big Tag ops, then the small tags, then backfill.
    expect(tags.filter((t) => t === "Big Tag").length).toBeLessThanOrEqual(2);
    expect(tags).toContain("Small A");
    expect(tags).toContain("Small B");
    expect(results).toHaveLength(4);
  });

  it("returns pure score order with diversify: false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => embeddingResponse([1, 0, 0, 0])));
    const results = await retrieveOperations("query", {
      apiKey: "k",
      catalog: crowdedCatalog(),
      topK: 4,
      diversify: false,
    });
    expect(results.map((r) => r.operationId)).toEqual(["big_1", "big_2", "big_3", "big_4"]);
  });

  it("backfills from the dominant tag when smaller tags run out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => embeddingResponse([1, 0, 0, 0])));
    const results = await retrieveOperations("query", {
      apiKey: "k",
      catalog: crowdedCatalog(),
      topK: 6,
    });
    // 2 big (cap = max(2, ceil(6/4)) = 2), 2 small, then 2 more big backfilled.
    expect(results).toHaveLength(6);
    expect(results.filter((r) => r.tag === "Big Tag")).toHaveLength(4);
  });

  it("surfaces HTTP failures with status and key hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    await expect(
      retrieveOperations("x", { apiKey: "bad", catalog: makeCatalog() }),
    ).rejects.toThrow(/401.*AISA_API_KEY/s);
  });
});

describe("listSources", () => {
  it("aggregates tags with counts, no key or network needed", () => {
    const sources = listSources(makeCatalog());
    expect(sources).toEqual([
      { tag: "Agent Email", count: 1, example: "Send an email" },
      { tag: "Crypto Data", count: 1, example: "Get current price for a coin" },
      { tag: "Scholar Search", count: 1, example: "Search academic papers" },
    ]);
  });
});
