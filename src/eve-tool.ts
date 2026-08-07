import { z } from "zod";
import { createPlan } from "./planner.js";
import { listSources } from "./retrieval.js";

/**
 * Ready-made tool config for eve's `defineTool` — shaped as plain data so this
 * package never imports eve itself (eve is beta; its API surface is theirs to
 * move). Usage, in your agent's tools/ directory:
 *
 *   import { defineTool } from "eve/tools";
 *   import { planAisaCalls } from "aisa-planner/eve-tool";
 *   export default defineTool(planAisaCalls());
 *
 * See docs/eve-integration.md for the agent-native variant that skips the
 * extra LLM call and lets the host model compose the plan itself.
 */
export interface PlanAisaCallsOptions {
  /** AIsa chat model for the planning call; defaults to the package default. */
  model?: string;
  topK?: number;
}

export function planAisaCalls(options: PlanAisaCallsOptions = {}) {
  return {
    description:
      "Plan a sequence of AIsa API calls for a research or data goal. Returns an ordered, " +
      "validated call list with input schemas, ready to execute against " +
      "https://api.aisa.one/apis/v1 with the AISA_API_KEY from the environment. " +
      "Steps marked ⚠ have side effects or cost credits — surface those to the user " +
      "and get confirmation before executing them.",
    inputSchema: z.object({
      goal: z.string().describe("What the user wants to accomplish, in natural language."),
      sources: z
        .array(z.string())
        .optional()
        .describe(
          'Optional AIsa source tags to restrict planning to, e.g. ["Financial Data", "Scholar Search"].',
        ),
    }),
    async execute({ goal, sources }: { goal: string; sources?: string[] }) {
      const result = await createPlan(goal, {
        tags: sources,
        model: options.model,
        topK: options.topK,
      });
      return result.exportMarkdown();
    },
  };
}

/** Tag list helper for building a `list_aisa_sources` tool without a key. */
export function listAisaSources(): { tag: string; count: number; example: string }[] {
  return listSources();
}
