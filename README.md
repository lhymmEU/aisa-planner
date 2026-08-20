# aisa-planner

Turn a natural-language intent into a **validated, ordered list of [AIsa](https://aisa.one) API calls** — ready for you or your agent to execute with your own `AISA_API_KEY`.

- **683 operations** across 14 source families (Financial Data, Crypto, Scholar Search, Prediction Markets, Web & News Search, SEO & Search Data, Twitter/X, Instagram, Reddit, YouTube, …) bundled as a prebuilt catalog — no spec download at runtime.
- The LLM only **picks operations and fills arguments**. Schemas are attached from the OpenAPI spec, never invented by the model.
- Every step is **validated before anything runs**. Write operations and credit-consuming calls are flagged with ⚠ so a human can approve them first.
- Planning is decoupled from execution: this package never calls the data APIs, and your agent never loads a 4.5 MB spec.

Requires **Node ≥ 20** and an `AISA_API_KEY` (get one at [aisa.one](https://aisa.one)). The key is pass-through only — sent to `api.aisa.one`, never logged or stored.

## Example

```bash
AISA_API_KEY=sk-... npx aisa-planner plan "find recent papers about LLM agents and check related prediction markets"
```

Output (abridged — schemas truncated):

````markdown
# Plan: find recent papers about LLM agents and check related prediction markets

> **Execution:** call `https://api.aisa.one/apis/v1` with header `Authorization: Bearer $AISA_API_KEY`.
> Never hardcode the key; read it from the environment.

**Assumptions:**

- "recent" means papers published since 2025

## Step 1 — `searchScholar`

`POST /scholar/search/scholar` — Search academic papers

_Find recent papers on LLM agents first._

⚠ write operation (POST /scholar/search/scholar) — has side effects; confirm before executing

**Arguments** (values like `{{step_N.output.*}}` are filled from earlier step responses):

```json
{ "query": "LLM agents", "as_ylo": 2025 }
```

**Input schema:**

```json
{ "type": "object", "properties": { "query": { "type": "string", … }, … }, "required": ["query"] }
```

**Validation:** ✅ operation exists, required params present, literal values match the schema

## Step 2 — `get_kalshi_markets`

`GET /kalshi/markets` — Get Kalshi Markets

_Check prediction markets related to AI/LLM topics._

**Arguments** …
**Validation:** ✅ operation exists, required params present, literal values match the schema
````

Steps that depend on earlier responses use placeholders like `"{{step_1.output.results.0.id}}"` — the executor fills them at run time. Validation failures render as ❌ badges with the exact problems listed; they are returned, never thrown.

## Quick start: npx

No install needed:

```bash
export AISA_API_KEY=sk-...
npx aisa-planner plan "what is the current price of bitcoin in USD?"
```

All commands:

| Command | Needs key | What it does |
|---|---|---|
| `plan "<intent>" [--tags a,b] [--top-k n] [--model id] [--json]` | yes | Markdown plan to stdout (`--json` for the raw object; exit code 2 on validation failure) |
| `sources` | no | List source families in the catalog |
| `validate <plan.json>` | no | Re-validate a saved plan |
| `build-catalog [--out path] [--no-embed]` | yes | Rebuild the catalog from the live spec (~a few cents of embeddings) |
| `mcp` | yes | Serve the planner over MCP stdio |

The planning model defaults to a cheap one; override with `--model` or `AISA_PLANNER_MODEL`.

## Quick start: in your project

```bash
npm install aisa-planner
```

```ts
import { createPlan } from "aisa-planner";

const { plan, validation, exportMarkdown } = await createPlan(
  "what is the current price of bitcoin in USD?",
  { apiKey: process.env.AISA_API_KEY }, // omit to read the env var directly
);

if (!validation.ok) console.warn("plan has failed steps — inspect before running");
console.log(exportMarkdown());
```

Deterministic core, no LLM call:

```ts
import { retrieveOperations, validatePlan, loadCatalog } from "aisa-planner";

const candidates = await retrieveOperations("crypto prices", { topK: 8 });
const validation = validatePlan(myPlan, loadCatalog());
```

### MCP (Claude Code, Cursor, any MCP client)

```json
{
  "mcpServers": {
    "aisa-planner": {
      "command": "npx",
      "args": ["-y", "aisa-planner", "mcp"],
      "env": { "AISA_API_KEY": "sk-..." }
    }
  }
}
```

Tools: `list_sources`, `create_plan(goal, sources?)`, `get_operation(operationId)`. The `create_plan` tool tells the calling agent to surface ⚠ write/cost steps to the user before executing them.

## How it works

1. **Catalog (built offline, shipped in the package).** The AIsa OpenAPI spec is cleaned and compiled into a catalog artifact: 683 operations with merged input schemas, output schemas, read/write kind, cost notes, and a `jina-embeddings-v3` vector per operation. The artifact stamps the embedding model, the spec's sha256, and the fetch timestamp; a weekly CI job checks the live spec for drift.
2. **Retrieve.** Your intent is embedded with the stamped model and matched against the catalog by pure cosine top-K. Scope with `tags` (source-family filter) or raise `topK` for compound goals.
3. **Plan.** A small LLM sees only the retrieved candidates and produces steps: `operationId`, an `argTemplate` of literals or `{{step_N.output.*}}` placeholders, `dependsOn`, and a rationale. It never sees or writes schemas.
4. **Hydrate.** Method, path, and input/output schemas are attached to each step from the catalog.
5. **Validate.** Each step is checked: operation exists, required params present, literal values pass the JSON schema (ajv), references point backwards only. Hard failures trigger one retry with the errors fed back; whatever remains is returned with ❌ badges. Write/cost operations get ⚠ warnings.
6. **You execute.** The plan is markdown (or JSON) for your agent to run against `https://api.aisa.one/apis/v1` with your own key. This package never executes anything.

## Notes

- **Bundlers** (Next.js, etc.): the catalog loader falls back to module resolution and a `node_modules` walk; if your bundler still defeats it, set `AISA_PLANNER_CATALOG` to the artifact's absolute path or pass `catalogPath`.
- **"catalog was built without embeddings"**: your catalog was built with `--no-embed`. Rebuild in place: `AISA_API_KEY=... npx aisa-planner build-catalog`.
- Full plan JSON shape and validation semantics: [docs/plan-format.md](docs/plan-format.md). eve integration (copy-paste tool files): [docs/eve-integration.md](docs/eve-integration.md).

## License

MIT
