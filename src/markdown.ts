import { AISA_DATA_BASE_URL } from "./aisa-client.js";
import type { HydratedPlan, PlanValidation, StepValidation } from "./types.js";

const DOCS_URL = "https://aisa.one";

function fence(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

function stepBadge(v: StepValidation | undefined): string {
  if (!v) return "";
  if (v.ok) return "**Validation:** ✅ operation exists, required params present, literal values match the schema";
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
  const byStep = new Map(validation.steps.map((s) => [s.stepNumber, s]));
  const lines: string[] = [];

  lines.push(`# Plan: ${plan.goal}`, "");
  lines.push(
    `> **Execution:** call \`${AISA_DATA_BASE_URL}\` with header \`Authorization: Bearer $AISA_API_KEY\`.`,
    `> Errors and rate limits: ${DOCS_URL}. Never hardcode the key; read it from the environment.`,
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

  for (const step of plan.steps) {
    const v = byStep.get(step.stepNumber);
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
