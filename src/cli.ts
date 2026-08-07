#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { defaultCatalogPath, loadCatalog } from "./catalog.js";
import { createPlan } from "./planner.js";
import { listSources } from "./retrieval.js";
import { validatePlan } from "./validator.js";
import type { Plan } from "./types.js";

const program = new Command();

program
  .name("aisa-planner")
  .description(
    "Turn a natural-language intent into a validated, ordered list of AIsa API calls.",
  )
  .version("0.1.0");

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

program
  .command("plan")
  .description("Create a validated call plan for an intent (needs AISA_API_KEY)")
  .argument("<intent>", "what you want to accomplish, in natural language")
  .option("--tags <tags>", "comma-separated source tags to restrict planning to")
  .option("--top-k <n>", "retrieval candidate count", (v) => Number.parseInt(v, 10))
  .option("--model <id>", "AIsa chat model for the planning call")
  .option("--catalog <path>", "path to a catalog artifact (defaults to the bundled one)")
  .option("--json", "emit the raw { plan, validation } object instead of markdown")
  .action(async (intent: string, opts: {
    tags?: string;
    topK?: number;
    model?: string;
    catalog?: string;
    json?: boolean;
  }) => {
    try {
      const result = await createPlan(intent, {
        tags: opts.tags?.split(",").map((t) => t.trim()).filter(Boolean),
        topK: opts.topK,
        model: opts.model,
        catalogPath: opts.catalog,
      });
      if (opts.json) {
        console.log(JSON.stringify({ plan: result.plan, validation: result.validation }, null, 2));
      } else {
        console.log(result.exportMarkdown());
      }
      if (!result.validation.ok) process.exitCode = 2;
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("sources")
  .description("List AIsa source families from the bundled catalog (no key, no network)")
  .option("--catalog <path>", "path to a catalog artifact")
  .option("--json", "emit JSON")
  .action((opts: { catalog?: string; json?: boolean }) => {
    try {
      const catalog = loadCatalog(opts.catalog);
      const sources = listSources(catalog);
      if (opts.json) {
        console.log(JSON.stringify(sources, null, 2));
        return;
      }
      const width = Math.max(...sources.map((s) => s.tag.length));
      for (const s of sources) {
        console.log(`${s.tag.padEnd(width)}  ${String(s.count).padStart(3)} ops  ${s.example}`);
      }
      const h = catalog.header;
      console.log(
        `\n${h.operationCount} operations | embeddings: ${h.embedded ? h.embeddingModel : "none (retrieval disabled — rebuild with a key)"} | spec ${h.specSha256.slice(0, 12)} fetched ${h.specFetchedAt}`,
      );
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("validate")
  .description("Validate a saved plan JSON against the catalog (no key needed)")
  .argument("<file>", "path to a plan JSON file ({ plan } wrapper or bare plan)")
  .option("--catalog <path>", "path to a catalog artifact")
  .option("--json", "emit the validation object as JSON")
  .action((file: string, opts: { catalog?: string; json?: boolean }) => {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { plan?: Plan } & Plan;
      const plan: Plan = raw.plan ?? raw;
      if (!Array.isArray(plan.steps)) {
        fail(`${file} does not look like a plan (no steps array). See docs/plan-format.md.`);
      }
      const validation = validatePlan(plan, loadCatalog(opts.catalog));
      if (opts.json) {
        console.log(JSON.stringify(validation, null, 2));
      } else {
        for (const s of validation.steps) {
          const marker = s.ok ? "✅" : "❌";
          console.log(`${marker} step ${s.stepNumber} ${s.operationId}`);
          if (!s.exists) console.log("   - operationId not found in catalog");
          for (const p of s.missingParams) console.log(`   - missing required param: ${p}`);
          for (const e of s.schemaErrors) console.log(`   - ${e}`);
          for (const e of s.referenceErrors) console.log(`   - ${e}`);
          for (const w of s.warnings) console.log(`   ⚠ ${w}`);
        }
        for (const e of validation.planErrors) console.log(`❌ plan: ${e}`);
        console.log(validation.ok ? "\nPlan is valid." : "\nPlan has hard failures.");
      }
      if (!validation.ok) process.exitCode = 2;
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("build-catalog")
  .description("Rebuild the operation catalog from the live AIsa OpenAPI spec")
  .option("--model <id>", "embedding model ID", "jina-embeddings-v3")
  .option(
    "--out <path>",
    "output artifact path (default: the catalog this install loads, so plan/sources pick it up directly)",
    defaultCatalogPath(),
  )
  .option("--spec <url>", "spec URL", "https://aisa.one/openapi.yaml")
  .option("--no-embed", "skip embeddings (catalog loads, but retrieval is disabled)")
  .action(async (opts: { model: string; out: string; spec: string; embed: boolean }) => {
    try {
      const { buildCatalog } = await import("./catalog-build.js");
      await buildCatalog({
        specUrl: opts.spec,
        outPath: opts.out,
        embeddingModel: opts.model,
        embed: opts.embed,
        log: (msg) => console.error(msg),
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("mcp")
  .description("Serve the planner as a local MCP stdio server")
  .action(async () => {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
  });

program.parseAsync().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
