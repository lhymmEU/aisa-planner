# aisa-planner

Turn a natural-language intent into a **validated, ordered list of [AIsa](https://aisa.one) API calls** — with input schemas hydrated from the OpenAPI spec and per-step validation results — for you or your agent to execute with your own `AISA_API_KEY`.

**Why:** planning decoupled from execution. Your agent's context stays small (it never loads a 4.5 MB spec), the LLM never invents schemas (it only picks operations and fills argument templates; schemas are attached from a prebuilt catalog), and every step is checked before anything runs: does the operation exist, are required params present, do literal values match the schema, do step references point backwards only. Write operations and credit-consuming calls are flagged with ⚠ so a human can approve them first.

The bundled catalog covers **683 operations** across 14 source families (Financial Data, Crypto, Scholar Search, Prediction Markets, Web & News Search, Agent Email, Sales Intelligence, SEO & Search Data, Twitter/X, Instagram, Reddit, Pinterest, YouTube, WaveInflu).

## Quickstart

Everything needs Node ≥ 20 and an `AISA_API_KEY` (get one at [aisa.one](https://aisa.one)). The key is **pass-through only**: it is sent to `api.aisa.one` and never logged or stored.

> **If retrieval refuses to run** ("catalog was built without embeddings"): the catalog you have was built with `--no-embed`. Rebuild it once with your key — by default this regenerates the catalog in place, so `plan` picks it up with no extra flags:
>
> ```bash
> AISA_API_KEY=... npx aisa-planner build-catalog
> ```
>
> `sources` and `validate` work without embeddings. To keep the artifact elsewhere, use `--out FILE` and point at it with `--catalog FILE` (CLI), `catalogPath` (API), or `AISA_PLANNER_CATALOG=FILE` (env).

### CLI

```bash
AISA_API_KEY=... npx aisa-planner plan "find recent papers about LLM agents and check related prediction markets"
```

- `aisa-planner plan "<intent>" [--tags a,b] [--top-k n] [--model id] [--json]` — markdown plan to stdout (`--json` for the raw object; exit code 2 when validation failed)
- `aisa-planner sources` — list source families from the catalog (no key, no network)
- `aisa-planner validate <plan.json>` — re-validate a saved plan (no key)
- `aisa-planner build-catalog [--model id] [--out path] [--spec url] [--no-embed]` — rebuild the catalog from the live spec with your key
- `aisa-planner mcp` — serve the planner over MCP stdio

### Programmatic

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

Tools: `list_sources`, `create_plan(goal, sources?)`, `get_operation(operationId)`. The `create_plan` tool description instructs the calling agent to surface ⚠ write/cost steps to the user before executing them.

### eve

Docs-only integration (no eve code in this package): copy-paste tool files and a skill playbook in [docs/eve-integration.md](docs/eve-integration.md) — a one-call planner tool wrapping `createPlan`, and a cheaper agent-native variant wrapping `retrieveOperations` + `validatePlan` so the host model composes the plan itself.

## Plan format

See [docs/plan-format.md](docs/plan-format.md). Highlights:

- Steps carry `argTemplate` with literals or `"{{step_N.output.field}}"` placeholders; references may only point to earlier steps.
- Schemas in the output come from the catalog, never from the LLM.
- Validation failures are **returned, not thrown** — red badges in the markdown, structured results in `validation`.
- `kind: "write"` (any non-GET operation) and `costNote` (Apollo credits, DataForSEO metered calls, real email sends, …) steps render ⚠ lines. Surface them to a human before executing.

## Catalog versioning & staleness

The catalog artifact (`catalogs/aisa-jina-v3.catalog`) is built offline from `https://aisa.one/openapi.yaml` and stamps: the embedding model (`jina-embeddings-v3`, 1024 dims), the spec's sha256, the fetch timestamp, and the operation count. At runtime:

- the query-embedding model is read **from the stamp**, never from config; an explicit override that differs is refused with an error naming both IDs;
- a catalog whose format version this package doesn't understand is refused;
- a weekly CI job re-fetches the live spec and opens an issue when its hash drifts from the stamp.

Rebuild anytime with your key (a few cents of embeddings):

```bash
AISA_API_KEY=... npx aisa-planner build-catalog
```

By default this writes to the catalog location the same install loads (env `AISA_PLANNER_CATALOG` when set, else the bundled artifact), so the next `plan` uses it directly.

## Development

```bash
npm install
npm run typecheck && npm test   # unit tests: no network, no key
npm run build                   # tsup: ESM + CJS + d.ts
npm run build:catalog           # rebuild catalogs/aisa-jina-v3.catalog (needs AISA_API_KEY)
AISA_LIVE=1 AISA_API_KEY=... npm test   # + live retrieval/planning tests
```

Release: tag `v*` → GitHub Actions runs typecheck/tests/build, inspects the pack contents, and publishes with `--provenance` (needs the `NPM_TOKEN` secret).

## License

MIT
