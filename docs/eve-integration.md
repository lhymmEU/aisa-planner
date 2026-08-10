# Using aisa-planner from an eve agent

No eve-specific code ships in this package — eve is beta and its tool API may
shift, so the integration is copy-paste files in **your** agent repo. Two
variants; pick one (or ship both and let the model choose).

## Variant A — one-call planner tool (batteries included)

Costs one extra LLM call (routed through AIsa with your key) but keeps your
agent's context small: the agent sees only the final validated plan.

`agent/tools/plan_aisa_calls.ts`:

```ts
import { defineTool } from "eve/tools";
import { planAisaCalls } from "aisa-planner/eve-tool";

// planAisaCalls() returns { description, inputSchema, execute } as plain data.
// Reads AISA_API_KEY from the environment; pass { model, topK } to override.
export default defineTool(planAisaCalls());
```

## Variant B — agent-native planning (cheaper, host model composes the plan)

No extra LLM call: the host model gets the top-K candidate operations and
composes the plan itself, then validates it. Two thin tools:

`agent/tools/find_aisa_operations.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { retrieveOperations } from "aisa-planner";

export default defineTool({
  description:
    "Find AIsa API operations relevant to a goal. Returns candidate operations " +
    "(id, method, path, description, required params, write/cost flags) to " +
    "compose into a call plan. Compose steps only from returned operationIds, " +
    "then check the plan with validate_aisa_plan before showing it to the user.",
  inputSchema: z.object({
    goal: z.string().describe("What the user wants to accomplish."),
    topK: z.number().int().min(1).max(25).optional(),
  }),
  async execute({ goal, topK }) {
    const ops = await retrieveOperations(goal, { topK: topK ?? 12 });
    // Summaries only — keep schemas out of the context until validation time.
    return ops.map((op) => ({
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      tag: op.tag,
      summary: op.summary,
      requiredParams: op.requiredParams,
      kind: op.kind,
      costNote: op.costNote,
      score: Number(op.score.toFixed(3)),
    }));
  },
});
```

`agent/tools/validate_aisa_plan.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { loadCatalog, validatePlan, renderPlanMarkdown } from "aisa-planner";

const PlanStep = z.object({
  stepNumber: z.number().int().positive(),
  operationId: z.string(),
  argTemplate: z.record(z.unknown()),
  dependsOn: z.array(z.number().int()).default([]),
  rationale: z.string().max(200),
});

export default defineTool({
  description:
    "Validate a plan of AIsa API calls (composed from find_aisa_operations " +
    "results) against the operation catalog. Returns per-step results and the " +
    "agent-ready markdown with schemas attached. Steps marked ⚠ are write/cost " +
    "operations — surface them to the user before executing. No API key needed.",
  inputSchema: z.object({
    goal: z.string(),
    assumptions: z.array(z.string()).default([]),
    steps: z.array(PlanStep).min(1).max(12),
  }),
  async execute(plan) {
    const catalog = loadCatalog();
    const validation = validatePlan(plan, catalog);
    const hydrated = {
      ...plan,
      steps: plan.steps.map((s) => {
        const op = catalog.byId.get(s.operationId);
        return op
          ? { ...s, method: op.method, path: op.path, summary: op.summary,
              inputSchema: op.inputSchema, outputSchema: op.outputSchema,
              kind: op.kind, costNote: op.costNote }
          : { ...s };
      }),
    };
    return { validation, markdown: renderPlanMarkdown(hydrated, validation) };
  },
});
```

## Skill playbook

`skills/aisa-planning.md` (or `SKILL.md` in your skills directory):

```markdown
# AIsa call planning

When the user asks for research, market data, contact enrichment, email
automation, or anything the AIsa data APIs cover, plan before calling:

1. Reach for the planner when a request needs MORE THAN ONE AIsa call or you
   are unsure which endpoint fits. For a single obvious call, just make it.
2. Variant A: call plan_aisa_calls with the user's goal. Variant B: call
   find_aisa_operations, compose a step list yourself, then ALWAYS run
   validate_aisa_plan before acting on it.
3. Never execute a step marked ❌ (failed validation).
4. ALWAYS surface ⚠ steps (write operations, credit-consuming calls) to the
   user and get explicit confirmation before executing them. Sending email,
   revealing personal contact data, and enrichment calls cost money or have
   real-world effects.
5. Execute steps in order against https://api.aisa.one/apis/v1 with
   `Authorization: Bearer $AISA_API_KEY`. Fill `{{step_N.output.*}}`
   placeholders from the actual responses of earlier steps.
6. If a step's response surprises you (error, empty result), stop and replan
   rather than improvising parameters.
```

## Environment

Both variants read `AISA_API_KEY` from the environment — set it in your eve
agent's env config. The key is pass-through only: it goes to api.aisa.one and
is never logged or stored by the package.

## Bundled runtime note

eve's dev runtime bundles your agent (and its dependencies) into snapshot
directories, which breaks naive asset paths. aisa-planner ≥ 0.1.2 handles
this: when the module-relative catalog path doesn't exist, it falls back to
module resolution and then walks upward from the working directory looking
for `node_modules/aisa-planner/catalogs/`. If your deployment still can't
find it, set `AISA_PLANNER_CATALOG=<absolute path to the .catalog file>` in
the agent's env.
