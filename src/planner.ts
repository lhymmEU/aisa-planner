import { generateObject, NoObjectGeneratedError } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { AISA_INFERENCE_BASE_URL, resolveApiKey } from "./aisa-client.js";
import { loadCatalog } from "./catalog.js";
import { renderPlanMarkdown } from "./markdown.js";
import { retrieveOperations } from "./retrieval.js";
import { formatValidationFailures, validatePlan } from "./validator.js";
import type {
  Catalog,
  HydratedPlan,
  Plan,
  PlanResult,
  ScoredOperation,
} from "./types.js";

/**
 * Overridable via createPlan({ model }) or AISA_PLANNER_MODEL. Kept cheap:
 * planning is one small call, and this is the only mini-tier chat model the
 * AIsa spec names.
 */
export const DEFAULT_PLANNER_MODEL = "claude-haiku-4-5-20251001";

/**
 * Salvage a JSON object from fenced or prose-wrapped model output. Models
 * routed through the OpenAI-compatible gateway (Claude ones especially) often
 * wrap the object in ```json fences or a sentence of preamble.
 */
export function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

const PlanStepZ = z.object({
  stepNumber: z.number().int().positive(),
  operationId: z.string(),
  argTemplate: z.record(z.unknown()),
  dependsOn: z.array(z.number().int()).default([]),
  rationale: z.string().max(200),
});

const PlanZ = z.object({
  goal: z.string(),
  assumptions: z.array(z.string()).default([]),
  steps: z.array(PlanStepZ).min(1).max(12),
});

export interface CreatePlanOptions {
  /** Explicit key; falls back to the AISA_API_KEY environment variable. */
  apiKey?: string;
  /** Chat model for the single planning call (an AIsa model ID). */
  model?: string;
  topK?: number;
  /** Restrict retrieval to these catalog tags. */
  tags?: string[];
  catalog?: Catalog;
  catalogPath?: string;
  /** Override the inference base URL (testing). */
  baseURL?: string;
}

/** One line per candidate — never full schemas. */
function candidateLine(op: ScoredOperation): string {
  const oneLiner = (op.summary || op.description.split(/(?<=\.)\s/)[0] || op.operationId)
    .replace(/\s+/g, " ")
    .slice(0, 200);
  const flags = [
    op.kind === "write" ? "WRITE" : null,
    op.costNote ? `COST: ${op.costNote}` : null,
  ].filter(Boolean);
  const required = op.requiredParams.length > 0 ? op.requiredParams.join(", ") : "none";
  return `- ${op.operationId} [${op.method} ${op.path}] (${op.tag}${flags.length ? "; " + flags.join("; ") : ""}) — ${oneLiner} | required params: ${required}`;
}

const SYSTEM_PROMPT = `You turn a user's intent into an ordered plan of AIsa API calls.

Rules:
- Use ONLY operationIds from the provided candidate list. Never invent operations or parameters.
- Each step's argTemplate contains the arguments for that call. Use literal values where the intent provides them. When a value must come from an earlier step's response, use a placeholder string: "{{step_N.output.<field path>}}".
- dependsOn lists the step numbers a step needs output from. References (dependsOn and placeholders) may only point to earlier steps.
- Number steps 1..N in execution order. Prefer the fewest steps that satisfy the intent.
- Record anything you had to guess (defaults, tickers, IDs, interpretations) in assumptions.
- Prefer read operations. Include a WRITE or COST operation only when the intent clearly requires it.
- Keep each rationale under 200 characters.
- Respond with a single JSON object of the shape
  {"goal": string, "assumptions": string[], "steps": [{"stepNumber": number, "operationId": string, "argTemplate": object, "dependsOn": number[], "rationale": string}]}
  and nothing else.`;

function hydrate(plan: Plan, catalog: Catalog): HydratedPlan {
  return {
    goal: plan.goal,
    assumptions: plan.assumptions,
    steps: plan.steps.map((step) => {
      const op = catalog.byId.get(step.operationId);
      if (!op) return { ...step };
      return {
        ...step,
        method: op.method,
        path: op.path,
        summary: op.summary,
        inputSchema: op.inputSchema,
        outputSchema: op.outputSchema,
        kind: op.kind,
        costNote: op.costNote,
        bodyMediaType: op.bodyMediaType,
      };
    }),
  };
}

/**
 * Batteries-included planning: retrieve candidates, make one LLM call through
 * AIsa's OpenAI-compatible endpoint with the caller's key, hydrate schemas
 * from the catalog (the LLM never sees or emits schemas), validate, and — on
 * hard validation failures — retry once with the failures appended. Validation
 * results are returned alongside the plan, never thrown.
 */
export async function createPlan(
  intent: string,
  opts: CreatePlanOptions = {},
): Promise<PlanResult> {
  const catalog = opts.catalog ?? loadCatalog(opts.catalogPath);
  const apiKey = resolveApiKey(opts.apiKey);
  const modelId = opts.model ?? process.env.AISA_PLANNER_MODEL ?? DEFAULT_PLANNER_MODEL;

  const candidates = await retrieveOperations(intent, {
    apiKey,
    topK: opts.topK ?? 12,
    tags: opts.tags,
    catalog,
    baseURL: opts.baseURL,
  });
  if (candidates.length === 0) {
    throw new Error(
      opts.tags?.length
        ? `No operations match tags [${opts.tags.join(", ")}]. Run \`aisa-planner sources\` for valid tags.`
        : "Retrieval returned no candidate operations.",
    );
  }

  // No structured-output flag: AIsa fronts heterogeneous models, so the JSON
  // contract lives in the system prompt and zod validates the result.
  const provider = createOpenAICompatible({
    name: "aisa",
    baseURL: opts.baseURL ?? AISA_INFERENCE_BASE_URL,
    apiKey,
  });
  const model = provider(modelId);

  const basePrompt = `Intent: ${intent}

Candidate operations (the only ones you may use):
${candidates.map(candidateLine).join("\n")}`;

  const attempt = async (prompt: string) => {
    const { object } = await generateObject({
      model,
      schema: PlanZ,
      system: SYSTEM_PROMPT,
      prompt,
      experimental_repairText: async ({ text }) => extractJsonObject(text),
    });
    const plan = object as Plan;
    // Execution order is defined by stepNumber; normalize the array so every
    // downstream consumer (validation, markdown, JSON) sees that order.
    plan.steps.sort((a, b) => a.stepNumber - b.stepNumber);
    return { plan, validation: validatePlan(plan, catalog) };
  };

  let plan: Plan | undefined;
  let validation: ReturnType<typeof validatePlan> | undefined;
  let firstFailure: string | undefined;
  try {
    ({ plan, validation } = await attempt(basePrompt));
  } catch (err) {
    // Only unusable model output earns the repair retry; transport/auth/rate
    // errors propagate immediately as what they are.
    if (!NoObjectGeneratedError.isInstance(err)) throw err;
    firstFailure = `your previous response was not the required JSON object (${
      err.message.split("\n")[0]
    })`;
  }

  if (!plan || !validation?.ok) {
    // One repair pass; whatever comes back second is the answer — validation
    // failures surface as red badges in the result, not exceptions.
    const failures = plan && validation
      ? `Your previous plan was:\n${JSON.stringify(plan)}\n\nIt had these validation failures:\n${formatValidationFailures(validation)}`
      : `Note: ${firstFailure ?? "your previous response was unusable"}.`;
    const repairPrompt = `${basePrompt}

${failures}

Produce a corrected plan that fixes every failure. Same rules apply.`;
    try {
      ({ plan, validation } = await attempt(repairPrompt));
    } catch (err) {
      if (!plan || !validation) {
        if (!NoObjectGeneratedError.isInstance(err)) throw err;
        const snippet = err.text ? ` Model output started with: ${JSON.stringify(err.text.slice(0, 200))}` : "";
        throw new Error(
          `The planning model (${modelId}) failed to return a plan twice: ${err.message}.${snippet} ` +
            `Try another model via { model } or AISA_PLANNER_MODEL.`,
        );
      }
      // Keep the first attempt's plan + failures rather than losing everything.
    }
  }

  const hydrated = hydrate(plan, catalog);
  return {
    plan: hydrated,
    validation,
    exportMarkdown: () => renderPlanMarkdown(hydrated, validation),
  };
}
