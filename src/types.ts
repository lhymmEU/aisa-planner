/** A JSON Schema fragment (draft 2020-12, as used by OpenAPI 3.1). */
export type JSONSchema = Record<string, unknown>;

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

/** One API operation flattened out of the AIsa OpenAPI spec. */
export interface Operation {
  operationId: string;
  method: HttpMethod;
  path: string;
  tag: string;
  summary: string;
  /** Full (cleaned) description; the embedding text may use a truncated form. */
  description: string;
  /** Merged schema: path params + query params + request body properties. */
  inputSchema: JSONSchema;
  requiredParams: string[];
  /** 200-response schema when the spec types it meaningfully; omitted if vague. */
  outputSchema?: JSONSchema;
  kind: "read" | "write";
  /** Present when the operation consumes provider credits or sends real messages. */
  costNote?: string;
  /** Request body media type when it is not application/json (e.g. multipart/form-data). */
  bodyMediaType?: string;
}

export interface CatalogHeader {
  formatVersion: 1;
  /** Embedding model the vectors were computed with, e.g. "jina-embeddings-v3". */
  embeddingModel: string;
  /** Vector dimensionality, e.g. 1024. */
  dims: number;
  /** False when the catalog was built without an API key (no vectors). */
  embedded: boolean;
  specSha256: string;
  specFetchedAt: string;
  operationCount: number;
}

export interface Catalog {
  header: CatalogHeader;
  operations: Operation[];
  /** Row-major vectors aligned with `operations`; empty when !header.embedded. */
  vectors: Float32Array;
  byId: Map<string, Operation>;
}

export interface ScoredOperation extends Operation {
  /** Cosine similarity of the operation to the query intent. */
  score: number;
}

/** A plan step as emitted by the LLM — schemas are never part of this shape. */
export interface PlanStep {
  stepNumber: number;
  operationId: string;
  /** Literal args or references like "{{step_1.output.some.field}}". */
  argTemplate: Record<string, unknown>;
  dependsOn: number[];
  rationale: string;
}

export interface Plan {
  goal: string;
  assumptions: string[];
  steps: PlanStep[];
}

/** A plan step after hydration: schemas attached from the catalog, not the LLM. */
export interface HydratedPlanStep extends PlanStep {
  method?: HttpMethod;
  path?: string;
  summary?: string;
  inputSchema?: JSONSchema;
  outputSchema?: JSONSchema;
  kind?: "read" | "write";
  costNote?: string;
  bodyMediaType?: string;
}

export interface HydratedPlan {
  goal: string;
  assumptions: string[];
  steps: HydratedPlanStep[];
}

export interface StepValidation {
  stepNumber: number;
  operationId: string;
  /** Hard fail when the operationId is not in the catalog. */
  exists: boolean;
  /** Required params absent from argTemplate (hard fail when non-empty). */
  missingParams: string[];
  /** Ajv errors for literal values (placeholders are exempt). */
  schemaErrors: string[];
  /** Forward/self/unknown step references (hard fail when non-empty). */
  referenceErrors: string[];
  /** Non-fatal: write-operation and cost notes. */
  warnings: string[];
  /** True when the step has no hard failures. */
  ok: boolean;
}

export interface PlanValidation {
  ok: boolean;
  steps: StepValidation[];
  /** Plan-level problems, e.g. duplicate step numbers. */
  planErrors: string[];
}

export interface PlanResult {
  plan: HydratedPlan;
  validation: PlanValidation;
  /** Renders the agent-ready markdown block (auth preamble, steps, schemas, ⚠ lines). */
  exportMarkdown(): string;
}
