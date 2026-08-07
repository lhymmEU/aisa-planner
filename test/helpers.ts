import type { Catalog, CatalogHeader, Operation } from "../src/types.js";

export const OPS: Operation[] = [
  {
    operationId: "get_crypto_price",
    method: "GET",
    path: "/crypto/price",
    tag: "Crypto Data",
    summary: "Get current price for a coin",
    description: "Returns the current price of a cryptocurrency.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        days: { type: "integer", minimum: 1 },
        currency: { type: "string", enum: ["usd", "eur"] },
      },
      required: ["symbol"],
    },
    requiredParams: ["symbol"],
    outputSchema: { type: "object", properties: { price: { type: "number" } } },
    kind: "read",
  },
  {
    operationId: "search_papers",
    method: "GET",
    path: "/scholar/search",
    tag: "Scholar Search",
    summary: "Search academic papers",
    description: "Full-text search over academic papers.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer" } },
      required: ["query"],
    },
    requiredParams: ["query"],
    kind: "read",
  },
  {
    operationId: "send_email",
    method: "POST",
    path: "/agentmail/inboxes/{inbox_id}/messages/send",
    tag: "Agent Email",
    summary: "Send an email",
    description: "Sends a real email from an agent inbox.",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: { type: "string" },
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["inbox_id", "to", "body"],
    },
    requiredParams: ["inbox_id", "to", "body"],
    kind: "write",
    costNote: "sends a real email to the recipient",
  },
];

/** Unit vectors chosen so each op is trivially separable by cosine. */
export const DIMS = 4;
const VECS = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
];

export function makeCatalog(overrides: Partial<CatalogHeader> = {}): Catalog {
  const header: CatalogHeader = {
    formatVersion: 1,
    embeddingModel: "jina-embeddings-v3",
    dims: DIMS,
    embedded: true,
    specSha256: "deadbeef".repeat(8),
    specFetchedAt: "2026-08-07T00:00:00.000Z",
    operationCount: OPS.length,
    ...overrides,
  };
  const vectors = header.embedded
    ? Float32Array.from(VECS.flat())
    : new Float32Array(0);
  return {
    header,
    operations: OPS,
    vectors,
    byId: new Map(OPS.map((op) => [op.operationId, op])),
  };
}

export function embeddingResponse(vector: number[]): Response {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: vector }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
