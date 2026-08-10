#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadCatalog } from "./catalog.js";
import { createPlan } from "./planner.js";
import { listSources } from "./retrieval.js";

function textResult(markdown: string, json: unknown) {
  return {
    content: [
      { type: "text" as const, text: markdown },
      { type: "text" as const, text: "```json\n" + JSON.stringify(json, null, 2) + "\n```" },
    ],
  };
}

function errorResult(err: unknown) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
  };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "aisa-planner", version: "0.1.2" });

  server.registerTool(
    "list_sources",
    {
      title: "List AIsa data sources",
      description:
        "List the AIsa API source families (catalog tags) available for planning, with operation counts. " +
        "No API key needed. Use these tag names as the `sources` filter of create_plan.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const sources = listSources();
        const md = [
          "| Source | Operations | Example |",
          "|---|---|---|",
          ...sources.map((s) => `| ${s.tag} | ${s.count} | ${s.example} |`),
        ].join("\n");
        return textResult(md, sources);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "create_plan",
    {
      title: "Plan AIsa API calls",
      description:
        "Turn a natural-language goal into an ordered, validated list of AIsa API calls with full " +
        "input schemas, ready to execute against https://api.aisa.one/apis/v1 with Bearer $AISA_API_KEY. " +
        "Requires AISA_API_KEY in the server's environment. " +
        "IMPORTANT: steps marked ⚠ are write operations (real side effects, e.g. sending email) or " +
        "consume paid credits — surface those warnings to the user and get explicit confirmation " +
        "before executing those steps. Steps marked ❌ failed validation and must not be executed as-is.",
      inputSchema: {
        goal: z.string().describe("The user's goal in natural language."),
        sources: z
          .array(z.string())
          .optional()
          .describe("Optional source tags (from list_sources) to restrict planning to."),
      },
    },
    async ({ goal, sources }) => {
      try {
        const result = await createPlan(goal, { tags: sources });
        return textResult(result.exportMarkdown(), {
          plan: result.plan,
          validation: result.validation,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_operation",
    {
      title: "Get one AIsa operation",
      description:
        "Fetch the full catalog record for one AIsa operation by operationId: method, path, " +
        "description, input/output JSON schemas, required params, and write/cost flags. " +
        "No API key needed.",
      inputSchema: {
        operationId: z.string().describe("The operationId, e.g. from a plan step or create_plan output."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ operationId }) => {
      try {
        const catalog = loadCatalog();
        const op = catalog.byId.get(operationId);
        if (!op) {
          return errorResult(
            new Error(
              `Unknown operationId "${operationId}". Use list_sources / create_plan to discover operations.`,
            ),
          );
        }
        const md = [
          `### \`${op.operationId}\``,
          "",
          `\`${op.method} ${op.path}\` (${op.tag})`,
          "",
          op.summary,
          "",
          op.description,
          op.kind === "write" ? "\n⚠ Write operation — has real side effects." : "",
          op.costNote ? `\n⚠ ${op.costNote}` : "",
        ].join("\n");
        return textResult(md, op);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

/** Serve MCP over stdio until the transport closes. */
export async function runMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Allow `node dist/mcp.js` directly (the CLI's `mcp` subcommand also calls this).
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runMcpServer().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
