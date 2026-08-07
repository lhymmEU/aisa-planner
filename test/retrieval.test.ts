import { afterEach, describe, expect, it, vi } from "vitest";
import { retrieveOperations, listSources } from "../src/retrieval.js";
import { embeddingResponse, makeCatalog } from "./helpers.js";

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
