/**
 * Repo-side runner for the catalog build:  npm run build:catalog [-- flags]
 * The same logic ships in the CLI as `aisa-planner build-catalog`.
 */
import { parseArgs } from "node:util";
import { buildCatalog } from "../src/catalog-build.js";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "jina-embeddings-v3" },
    out: { type: "string", default: "catalogs/aisa-jina-v3.catalog" },
    spec: { type: "string", default: "https://aisa.one/openapi.yaml" },
    "no-embed": { type: "boolean", default: false },
  },
});

buildCatalog({
  specUrl: values.spec,
  outPath: values.out,
  embeddingModel: values.model,
  embed: !values["no-embed"],
  log: (msg) => console.error(msg),
}).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
