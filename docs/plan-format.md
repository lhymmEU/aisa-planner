# Plan format

`aisa-planner` produces plans in two forms: a JSON object (the source of truth)
and a rendered markdown block (`exportMarkdown()` / CLI default output) meant to
be pasted into an agent's context.

## JSON shape

```jsonc
{
  "plan": {
    "goal": "find recent papers about LLM agents and check related prediction markets",
    "assumptions": ["\"recent\" means the last 12 months"],
    "steps": [
      {
        "stepNumber": 1,                       // 1..N, execution order
        "operationId": "search_scholar",       // must exist in the catalog
        "argTemplate": {                       // literals or placeholders
          "query": "LLM agents",
          "year_min": 2025
        },
        "dependsOn": [],                       // step numbers this step needs
        "rationale": "Find the papers first.", // ≤ 200 chars

        // ── hydrated by the package from the catalog — never LLM output ──
        "method": "GET",
        "path": "/scholar/search",
        "summary": "Search academic papers",
        "inputSchema": { "type": "object", "properties": { /* … */ } },
        "outputSchema": { /* present when the spec types the 200 response */ },
        "kind": "read",                        // "read" | "write"
        "costNote": "consumes Apollo credits"  // present on credit-consuming ops
      }
    ]
  },
  "validation": {
    "ok": true,
    "planErrors": [],
    "steps": [
      {
        "stepNumber": 1,
        "operationId": "search_scholar",
        "exists": true,          // hard fail when false
        "missingParams": [],     // hard fail when non-empty
        "schemaErrors": [],      // ajv failures on literal values; hard fail
        "referenceErrors": [],   // forward/self/unknown refs; hard fail
        "warnings": [],          // non-fatal: write/cost notices
        "ok": true
      }
    ]
  }
}
```

### Placeholders

A step argument whose value depends on an earlier step's response uses a
placeholder string instead of a literal:

```
"{{step_2.output.results.0.id}}"
```

Rules:

- Placeholders and `dependsOn` entries may only reference **earlier** steps
  (`N < stepNumber`). Forward and self references are hard validation failures.
- Placeholder values are exempt from schema **type** checks (their runtime type
  is unknown until the referenced step runs), but they still count as
  "present" for required-parameter checks.
- The path after `output.` is the executor's business: it addresses into the
  actual HTTP response of the referenced step.

### Argument locations

The merged `inputSchema` flattens path parameters, query parameters and JSON
body properties into one object. Each property carries a non-standard `x-in`
annotation (`"path" | "query" | "header" | "body" | "body-root"`) so the
executor knows where to put it. `body-root` means the property named `body`
*is* the whole request body (used for array-shaped bodies, e.g. DataForSEO
task lists).

The merged object is **closed** (`additionalProperties: false` unless the
spec's body schema explicitly allows extra keys), so misspelled or invented
parameter names are hard validation failures, not silent passengers. When a
request body is not JSON, the step carries `bodyMediaType`
(e.g. `"multipart/form-data"`) and validation emits a warning to send body
params as form parts.

## Validation semantics

Hard failures (`ok: false`) — the step must not be executed as-is:

| Check | Field |
|---|---|
| operationId not in catalog | `exists: false` |
| required parameter missing from argTemplate | `missingParams` |
| literal value violates the input schema | `schemaErrors` |
| reference to a forward/self/unknown step | `referenceErrors` |

Warnings (non-fatal, but must be surfaced to a human before execution):

- `kind: "write"` — the operation has real side effects (sending email,
  posting, mutating state).
- `costNote` — the operation consumes metered provider credits.

`createPlan` retries **once** with the validation failures appended to the
prompt when the first attempt has hard failures. Whatever comes back second is
returned with its validation results attached — failures are output ("red
badges"), never exceptions.

## Markdown form

`exportMarkdown()` renders, in order: the auth preamble (base URL
`https://api.aisa.one/apis/v1`, `Authorization: Bearer $AISA_API_KEY`, docs
links), plan-level ⛔ banners when validation failed, assumptions, then one
section per step with the rationale, `⚠` warning lines, the fenced
`argTemplate`, the fenced input/output schemas, and a ✅/❌ validation badge.

## Catalog versioning

The catalog artifact stamps: `formatVersion`, `embeddingModel`, `dims`,
`specSha256`, `specFetchedAt`, `operationCount`. The runtime refuses to
retrieve with a query-embedding model different from the stamp, and refuses
vectorless catalogs. A weekly CI job compares the live spec's sha256 against
the bundled stamp and opens an issue on drift; `aisa-planner build-catalog`
regenerates the artifact with your own key at any time.
