/** Shared constants + the one HTTP helper the runtime needs (embeddings). */

export const AISA_INFERENCE_BASE_URL = "https://api.aisa.one/v1";
export const AISA_DATA_BASE_URL = "https://api.aisa.one/apis/v1";

/**
 * Resolve the caller's API key: explicit argument wins, then AISA_API_KEY.
 * The key is pass-through only — it is sent to api.aisa.one and never logged,
 * stored, or echoed into errors.
 */
export function resolveApiKey(explicit?: string): string {
  const key = explicit ?? process.env.AISA_API_KEY;
  if (!key) {
    throw new Error(
      "No AIsa API key found. Set the AISA_API_KEY environment variable or pass { apiKey }. " +
        "Get a key at https://aisa.one",
    );
  }
  return key;
}

export interface EmbedOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Embed one or more texts via AIsa's OpenAI-compatible /v1/embeddings.
 * Returns one vector per input, in order.
 */
export async function embedTexts(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  const base = (opts.baseURL ?? AISA_INFERENCE_BASE_URL).replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${base}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: opts.model, input: texts }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(
      `AIsa embeddings request failed (HTTP ${res.status})${res.status === 401 ? " — check your AISA_API_KEY" : ""}: ${body}`,
    );
  }
  const json = (await res.json()) as {
    data?: { index?: number; embedding?: number[] }[];
  };
  const data = json.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(
      `AIsa embeddings response malformed: expected ${texts.length} vectors, got ${data?.length ?? 0}`,
    );
  }
  // The OpenAI format allows out-of-order data entries; respect `index`.
  const out: number[][] = new Array(texts.length);
  for (let i = 0; i < data.length; i++) {
    const item: { index?: number; embedding?: number[] } = data[i]!;
    const idx = typeof item.index === "number" ? item.index : i;
    const embedding = item.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error(`AIsa embeddings response malformed: entry ${idx} has no embedding array`);
    }
    out[idx] = embedding;
  }
  return out;
}
