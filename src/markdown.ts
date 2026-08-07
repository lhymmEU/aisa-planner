import { AISA_DATA_BASE_URL } from "./aisa-client.js";
import type { HydratedPlan, PlanValidation, StepValidation } from "./types.js";

const DOCS_URL = "https://aisa.one";

function fence(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

function stepBadge(v: StepValidation | undefined): string {
  if (!v) return "";
  if (v.ok) {
    const uncompiled = v.warnings.some((w) => w.includes("could not be compiled"));
    return uncompiled
      ? "**Validation:** ✅ operation exists, required params present (schema could not be compiled — literal values were NOT type-checked)"
      : "**Validation:** ✅ operation exists, required params present, literal values match the schema";
  }
  const problems: string[] = [];
  if (!v.exists) problems.push(`operationId not found in catalog`);
  if (v.missingParams.length > 0) problems.push(`missing required params: ${v.missingParams.join(", ")}`);
  problems.push(...v.schemaErrors, ...v.referenceErrors);
  return "**Validation:** ❌\n" + problems.map((p) => `> - ${p}`).join("\n");
}

/**
 * Render the agent-ready markdown block: auth preamble, numbered steps with
 * fenced schemas, ⚠ lines for write/cost steps, and per-step validation badges.
 */
export function renderPlanMarkdown(plan: HydratedPlan, validation: PlanValidation): string {
  // validation.steps is index-aligned with plan.steps by construction; pairing
  // by index (not stepNumber) keeps badges correct even with duplicate step
  // numbers, and display order follows execution order.
  const paired = plan.steps
    .map((step, i) => ({ step, v: validation.steps[i] }))
    .sort((a, b) => a.step.stepNumber - b.step.stepNumber);
  const lines: string[] = [];

  lines.push(`# Plan: ${plan.goal}`, "");
  lines.push(
    `> **Execution:** call \`${AISA_DATA_BASE_URL}\` with header \`Authorization: Bearer $AISA_API_KEY\`.`,
    `> Errors and rate limits: ${DOCS_URL} (DataForSEO steps: https://docs.dataforseo.com/v3/appendix/errors.md).`,
    `> Never hardcode the key; read it from the environment.`,
    "",
  );

  if (!validation.ok) {
    lines.push(
      `> ⛔ **This plan has validation failures** (marked ❌ below). Fix or drop those steps before executing.`,
      "",
    );
  }
  for (const err of validation.planErrors) lines.push(`> ⛔ ${err}`);
  if (validation.planErrors.length > 0) lines.push("");

  if (plan.assumptions.length > 0) {
    lines.push("**Assumptions:**", "");
    for (const a of plan.assumptions) lines.push(`- ${a}`);
    lines.push("");
  }

  for (const { step, v } of paired) {
    lines.push(`## Step ${step.stepNumber} — \`${step.operationId}\``, "");
    if (step.method && step.path) {
      lines.push(`\`${step.method} ${step.path}\`${step.summary ? ` — ${step.summary}` : ""}`, "");
    }
    lines.push(`_${step.rationale}_`, "");
    if (step.dependsOn.length > 0) {
      lines.push(`Depends on: ${step.dependsOn.map((n) => `step ${n}`).join(", ")}`, "");
    }
    for (const w of v?.warnings ?? []) lines.push(`⚠ ${w}`);
    if ((v?.warnings.length ?? 0) > 0) lines.push("");

    lines.push(
      "**Arguments** (values like `{{step_N.output.*}}` are filled from earlier step responses):",
      "",
      fence(step.argTemplate),
      "",
    );
    if (step.inputSchema) {
      lines.push("**Input schema:**", "", fence(step.inputSchema), "");
    }
    if (step.outputSchema) {
      lines.push("**Output schema (200):**", "", fence(step.outputSchema), "");
    }
    lines.push(stepBadge(v), "");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
