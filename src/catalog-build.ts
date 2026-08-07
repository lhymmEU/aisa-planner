import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dereference } from "@readme/openapi-parser";
import { embedTexts, resolveApiKey } from "./aisa-client.js";
import { encodeCatalog } from "./catalog-format.js";
import {
  costNoteFor,
  DENYLIST_OPERATIONS,
  DENYLIST_TAGS,
  EMBED_STRIP_STRINGS,
  GET_WRITE_OVERRIDES,
  JUNK_DESCRIPTIONS_EXACT,
  remapTag,
  STRIP_ALWAYS_REGEXES,
} from "./catalog-clean-rules.js";
import type { CatalogHeader, HttpMethod, JSONSchema, Operation } from "./types.js";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const EMBED_BATCH_SIZE = 32;
const SIZE_BUDGET_BYTES = 3 * 1024 * 1024;

export interface BuildCatalogOptions {
  specUrl: string;
  outPath: string;
  embeddingModel: string;
  /** When false, emit a vectorless catalog (retrieval disabled at runtime). */
  embed: boolean;
  apiKey?: string;
  /** Embeddings endpoint base (testing). */
  baseURL?: string;
  log?: (message: string) => void;
}

export interface BuildCatalogResult {
  outPath: string;
  operationCount: number;
  bytes: number;
  embedded: boolean;
  specSha256: string;
  excluded: { key: string; reason: string }[];
}

interface RawParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: JSONSchema;
  content?: Record<string, { schema?: JSONSchema }>;
}

interface RawOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  deprecated?: boolean;
  servers?: { url?: string }[];
  parameters?: RawParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, { schema?: JSONSchema }>;
  };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: JSONSchema }> }
  >;
}

/* ------------------------------- helpers ------------------------------- */

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function cleanDescription(raw: string | undefined): string {
  let text = raw ?? "";
  if (JUNK_DESCRIPTIONS_EXACT.has(text.trim())) return "";
  for (const regex of STRIP_ALWAYS_REGEXES) {
    text = text.replace(regex, " ");
  }
  return collapseWhitespace(text);
}

/** First 2–3 sentences (or ~500 chars) — the embedding-text form. */
export function truncateForEmbedding(text: string, maxSentences = 3, maxChars = 500): string {
  let flat = text;
  for (const boilerplate of EMBED_STRIP_STRINGS) {
    flat = flat.split(boilerplate).join(" ");
  }
  flat = flat.replace(/\s+/g, " ").trim();
  const sentences = flat.split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/).slice(0, maxSentences);
  const joined = sentences.join(" ");
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

export function embeddingText(op: Operation): string {
  return `${op.tag} | ${op.summary} | ${truncateForEmbedding(op.description)}`;
}

function synthesizeOneLiner(
  summary: string,
  tag: string,
  method: string,
  path: string,
): string {
  const lead = summary ? `${summary.replace(/[.\s]+$/, "")}.` : "";
  return collapseWhitespace(`${lead} ${tag} endpoint: ${method} ${path}.`);
}

export function synthesizeOperationId(method: string, path: string): string {
  const slug = path
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .join("_")
    .replace(/[^a-zA-Z0-9_]+/g, "_");
  return `${method.toLowerCase()}_${slug}`;
}

/** Drop $ref remnants (circular refs are dereferenced with circular:"ignore"),
 * examples and vendor extensions; cap nested description length. Returns a
 * schema safe to JSON-serialize and compile with ajv. */
export function sanitizeSchema(schema: unknown, depth = 0): JSONSchema | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  if (depth > 30) return {};
  const src = schema as Record<string, unknown>;
  if (typeof src.$ref === "string") {
    // Only circular refs survive dereferencing; break the cycle.
    return { description: "(recursive reference omitted)" };
  }
  const out: JSONSchema = {};
  for (const [key, value] of Object.entries(src)) {
    if (
      key === "example" ||
      key === "examples" ||
      key === "xml" ||
      key === "$id" ||
      key === "$anchor" ||
      key.startsWith("x-readme")
    ) {
      continue;
    }
    // OpenAPI-3.0-style nullability appears throughout this 3.1 spec; convert
    // it so ajv (2020-12 dialect) honours null literals.
    if (key === "nullable") {
      if (value === true) {
        if (typeof src.type === "string" && src.type !== "null") {
          out.type = [src.type, "null"];
        } else if (Array.isArray(src.type) && !src.type.includes("null")) {
          out.type = [...src.type, "null"];
        }
      }
      continue;
    }
    if (key === "type" && src.nullable === true && "type" in out) {
      continue; // already written by the nullable branch
    }
    if (key === "description" && typeof value === "string") {
      const cleaned = collapseWhitespace(value);
      out[key] = cleaned.length > 300 ? cleaned.slice(0, 300) : cleaned;
      continue;
    }
    if (key === "properties" || key === "patternProperties" || key === "$defs" || key === "definitions") {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        props[name] = sanitizeSchema(sub, depth + 1) ?? {};
      }
      out[key] = props;
      continue;
    }
    if (key === "items" || key === "additionalProperties" || key === "additionalItems" || key === "not" || key === "if" || key === "then" || key === "else" || key === "contains" || key === "propertyNames") {
      if (typeof value === "boolean") {
        out[key] = value;
      } else {
        const sub = sanitizeSchema(value, depth + 1);
        if (sub !== undefined) out[key] = sub;
      }
      continue;
    }
    if (key === "allOf" || key === "anyOf" || key === "oneOf" || key === "prefixItems") {
      out[key] = (value as unknown[]).map((v) => sanitizeSchema(v, depth + 1) ?? {});
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      out[key] = value;
    }
    // Plain nested objects that aren't schema keywords (e.g. `default` objects)
    else {
      out[key] = value;
    }
  }
  return out;
}

function isVagueSchema(schema: JSONSchema | undefined): boolean {
  if (!schema) return true;
  const keys = Object.keys(schema).filter((k) => k !== "description" && k !== "title");
  if (keys.length === 0) return true;
  if (
    schema.type === "object" &&
    !schema.properties &&
    !schema.additionalProperties &&
    !schema.allOf &&
    !schema.anyOf &&
    !schema.oneOf
  ) {
    return true;
  }
  return false;
}

/* ------------------------------ flattening ------------------------------ */

function flattenOperation(
  path: string,
  method: HttpMethod,
  op: RawOperation,
  pathParams: RawParameter[],
  warn: (msg: string) => void,
): Operation | undefined {
  const tag = remapTag(path, op.tags?.[0] ?? "Other");

  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];

  // Path-level params first; operation-level params override on name+in collision.
  const params = [...pathParams, ...(op.parameters ?? [])];
  const seen = new Set<string>();
  for (const param of params.reverse()) {
    if (!param.name || !param.in) continue;
    const dedupeKey = `${param.in}:${param.name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (param.in === "cookie") continue;
    // The Authorization header is gateway boilerplate on every operation.
    if (param.in === "header" && param.name.toLowerCase() === "authorization") continue;

    const schema =
      sanitizeSchema(param.schema) ??
      sanitizeSchema(Object.values(param.content ?? {})[0]?.schema) ??
      {};
    if (param.description && !schema.description) {
      const cleaned = collapseWhitespace(param.description);
      schema.description = cleaned.length > 300 ? cleaned.slice(0, 300) : cleaned;
    }
    schema["x-in"] = param.in;
    const existing = properties[param.name];
    if (existing) {
      // Same name in two locations: a path param must keep its slot (the
      // route placeholder has to stay substitutable), otherwise last write wins.
      if (existing["x-in"] === "path") {
        warn(`${method} ${path}: ${param.in} parameter "${param.name}" collides with the path parameter; path wins`);
        continue;
      }
      warn(`${method} ${path}: parameter "${param.name}" appears in both ${String(existing["x-in"])} and ${param.in}; ${param.in} copy wins`);
    }
    properties[param.name] = schema;
    if (param.required && !required.includes(param.name)) required.push(param.name);
  }

  // Request body: merge object properties flat; non-object bodies become a
  // synthetic `body` property so array-shaped POSTs (DataForSEO) stay expressible.
  const bodyContent = op.requestBody?.content ?? {};
  const bodyMediaType = bodyContent["application/json"]
    ? "application/json"
    : Object.keys(bodyContent)[0];
  const jsonBody = bodyMediaType ? bodyContent[bodyMediaType] : undefined;
  let bodyAdditional: unknown;
  if (jsonBody?.schema) {
    const bodySchema = sanitizeSchema(jsonBody.schema);
    if (bodySchema) {
      const isPlainObject =
        (bodySchema.type === "object" || (!bodySchema.type && bodySchema.properties)) &&
        bodySchema.properties &&
        !bodySchema.allOf && !bodySchema.oneOf && !bodySchema.anyOf;
      if (isPlainObject) {
        for (const [name, sub] of Object.entries(bodySchema.properties as Record<string, JSONSchema>)) {
          if (name in properties) {
            warn(`${method} ${path}: body property "${name}" collides with a parameter; body value wins`);
          }
          const subSchema = typeof sub === "object" && sub !== null ? { ...sub } : {};
          subSchema["x-in"] = "body";
          properties[name] = subSchema;
        }
        for (const name of (bodySchema.required as string[] | undefined) ?? []) {
          if (!required.includes(name)) required.push(name);
        }
        // A body that legitimately accepts arbitrary keys must keep the merged
        // object open; everything else is closed below.
        if (bodySchema.additionalProperties !== undefined && bodySchema.additionalProperties !== false) {
          bodyAdditional = bodySchema.additionalProperties;
        }
      } else {
        bodySchema["x-in"] = "body-root";
        properties.body = bodySchema;
        if (op.requestBody?.required) required.push("body");
      }
    }
  }

  // Closed by default: the property set above is the complete argument
  // namespace, so unknown keys in a plan are misspelled/invented parameters.
  const inputSchema: JSONSchema = {
    type: "object",
    properties,
    additionalProperties: bodyAdditional ?? false,
    ...(required.length > 0 ? { required } : {}),
  };

  // Output schema from the first 2xx JSON response, if meaningfully typed.
  let outputSchema: JSONSchema | undefined;
  for (const [status, response] of Object.entries(op.responses ?? {})) {
    if (!/^2\d\d$/.test(status)) continue;
    const raw = response.content?.["application/json"]?.schema;
    if (!raw) continue;
    const sanitized = sanitizeSchema(raw);
    if (!isVagueSchema(sanitized)) outputSchema = sanitized;
    break;
  }

  const summary = collapseWhitespace(op.summary ?? "");
  let description = cleanDescription(op.description);
  if (description.length < 30) {
    // Empty or near-empty (e.g. "Pricing", "OHLC data") — synthesize a
    // one-liner from summary + tag + route so the embedding has signal.
    description = collapseWhitespace(
      `${description} ${synthesizeOneLiner(summary, tag, method, path)}`,
    );
  }

  const writeOverride = GET_WRITE_OVERRIDES.get(`${method} ${path}`);
  const kind: Operation["kind"] = method === "GET" && !writeOverride ? "read" : "write";
  const costNote = costNoteFor(method, path, op.description ?? "");

  return {
    operationId: op.operationId ?? synthesizeOperationId(method, path),
    method,
    path,
    tag,
    summary,
    description,
    inputSchema,
    requiredParams: required,
    ...(outputSchema ? { outputSchema } : {}),
    kind,
    ...(costNote ? { costNote } : {}),
    ...(bodyMediaType && bodyMediaType !== "application/json" ? { bodyMediaType } : {}),
  };
}

/* -------------------------------- build -------------------------------- */

export async function buildCatalog(opts: BuildCatalogOptions): Promise<BuildCatalogResult> {
  const log = opts.log ?? (() => {});

  log(`Fetching ${opts.specUrl} ...`);
  const res = await fetch(opts.specUrl);
  if (!res.ok) throw new Error(`Failed to fetch spec (HTTP ${res.status}) from ${opts.specUrl}`);
  const specBytes = Buffer.from(await res.arrayBuffer());
  const specSha256 = createHash("sha256").update(specBytes).digest("hex");
  const specFetchedAt = new Date().toISOString();
  log(`Spec: ${(specBytes.length / 1024).toFixed(0)} KB, sha256 ${specSha256.slice(0, 12)}…`);

  // The parser wants a file path (it sniffs YAML/JSON itself). A private
  // mkdtemp dir avoids predictable-name clobbering/races in the shared tmpdir.
  const tmpDir = mkdtempSync(join(tmpdir(), "aisa-planner-"));
  const tmpSpec = join(tmpDir, "spec.yaml");
  writeFileSync(tmpSpec, specBytes);
  let api: { paths?: Record<string, Record<string, unknown> & { parameters?: RawParameter[] }> };
  try {
    log("Dereferencing $refs (circular refs ignored) ...");
    api = (await dereference(tmpSpec, {
      dereference: { circular: "ignore" },
    })) as typeof api;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const operations: Operation[] = [];
  const excluded: { key: string; reason: string }[] = [];
  const warnings: string[] = [];
  const warn = (msg: string) => warnings.push(msg);

  for (const [path, pathItem] of Object.entries(api.paths ?? {})) {
    const pathParams = (pathItem.parameters ?? []) as RawParameter[];
    for (const method of METHODS) {
      const raw = pathItem[method.toLowerCase()] as RawOperation | undefined;
      if (!raw) continue;
      const key = `${method} ${path}`;
      const tag = remapTag(path, raw.tags?.[0] ?? "Other");
      // Operations served off the data plane (op-level servers pointing at the
      // /v1 or /v1beta inference hosts) cannot work against /apis/v1.
      const servers = raw.servers?.map((s) => s.url ?? "").filter(Boolean);
      if (servers && servers.length > 0 && !servers.some((u) => u.includes("/apis/"))) {
        excluded.push({ key, reason: `served from ${servers.join(", ")}, not the data gateway` });
        continue;
      }
      const tagDenied = DENYLIST_TAGS.get(tag);
      if (tagDenied) {
        excluded.push({ key, reason: `tag "${tag}": ${tagDenied}` });
        continue;
      }
      const opDenied = DENYLIST_OPERATIONS.get(key);
      if (opDenied) {
        excluded.push({ key, reason: opDenied });
        continue;
      }
      if (raw.deprecated) {
        excluded.push({ key, reason: "deprecated in spec" });
        continue;
      }
      const op = flattenOperation(path, method, raw, pathParams, warn);
      if (op) operations.push(op);
    }
  }

  // Deterministic order; then make operationIds unique.
  operations.sort(
    (a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
  const takenIds = new Set(operations.map((op) => op.operationId));
  const seenIds = new Set<string>();
  for (const op of operations) {
    if (seenIds.has(op.operationId)) {
      let n = 2;
      let candidate = `${op.operationId}_${n}`;
      while (takenIds.has(candidate) || seenIds.has(candidate)) candidate = `${op.operationId}_${++n}`;
      warn(`duplicate operationId "${op.operationId}" — renamed to "${candidate}"`);
      op.operationId = candidate;
    }
    seenIds.add(op.operationId);
  }

  for (const w of warnings.slice(0, 20)) log(`  warn: ${w}`);
  if (warnings.length > 20) log(`  … and ${warnings.length - 20} more warnings`);
  log(`Flattened ${operations.length} operations (${excluded.length} excluded by clean pass).`);

  let vectors = new Float32Array(0);
  let dims = 0;
  if (opts.embed) {
    const apiKey = resolveApiKey(opts.apiKey);
    const texts = operations.map(embeddingText);
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      const embedded = await embedTexts(batch, {
        apiKey,
        model: opts.embeddingModel,
        baseURL: opts.baseURL,
      });
      all.push(...embedded);
      log(`Embedded ${Math.min(i + EMBED_BATCH_SIZE, texts.length)}/${texts.length} (${opts.embeddingModel})`);
    }
    dims = all[0]?.length ?? 0;
    if (dims === 0) throw new Error("Embeddings endpoint returned empty vectors.");
    for (const [i, vec] of all.entries()) {
      if (vec.length !== dims) {
        throw new Error(`Vector ${i} has ${vec.length} dims, expected ${dims} — aborting.`);
      }
    }
    vectors = new Float32Array(operations.length * dims);
    all.forEach((vec, row) => vectors.set(vec, row * dims));
  } else {
    log("Skipping embeddings (--no-embed): the catalog will load but retrieval stays disabled.");
  }

  const header: CatalogHeader = {
    formatVersion: 1,
    embeddingModel: opts.embeddingModel,
    dims,
    embedded: opts.embed,
    specSha256,
    specFetchedAt,
    operationCount: operations.length,
  };
  const artifact = encodeCatalog(header, operations, vectors);
  mkdirSync(dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, artifact);

  log(
    `Wrote ${opts.outPath}: ${operations.length} operations, ${(artifact.length / 1024).toFixed(0)} KB` +
      (opts.embed ? `, ${dims}-dim vectors (${opts.embeddingModel})` : ", no vectors"),
  );
  if (artifact.length > SIZE_BUDGET_BYTES) {
    log(`  warn: artifact exceeds the ${SIZE_BUDGET_BYTES / 1024 / 1024} MB budget`);
  }

  return {
    outPath: opts.outPath,
    operationCount: operations.length,
    bytes: artifact.length,
    embedded: opts.embed,
    specSha256,
    excluded,
  };
}
