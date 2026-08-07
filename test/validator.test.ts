import { describe, expect, it } from "vitest";
import { formatValidationFailures, validatePlan } from "../src/validator.js";
import type { Plan } from "../src/types.js";
import { makeCatalog } from "./helpers.js";

const catalog = makeCatalog();

function planWith(steps: Plan["steps"]): Plan {
  return { goal: "test", assumptions: [], steps };
}

describe("validatePlan", () => {
  it("passes a well-formed single step", () => {
    const v = validatePlan(
      planWith([
        {
          stepNumber: 1,
          operationId: "get_crypto_price",
          argTemplate: { symbol: "BTC", days: 7 },
          dependsOn: [],
          rationale: "look up the price",
        },
      ]),
      catalog,
    );
    expect(v.ok).toBe(true);
    expect(v.steps[0]?.ok).toBe(true);
    expect(v.steps[0]?.warnings).toEqual([]);
  });

  it("hard-fails an operationId missing from the catalog", () => {
    const v = validatePlan(
      planWith([
        {
          stepNumber: 1,
          operationId: "not_a_real_op",
          argTemplate: {},
          dependsOn: [],
          rationale: "x",
        },
      ]),
      catalog,
    );
    expect(v.ok).toBe(false);
    expect(v.steps[0]?.exists).toBe(false);
  });

  it("lists missing required params", () => {
    const v = validatePlan(
      planWith([
        {
          stepNumber: 1,
          operationId: "send_email",
          argTemplate: { inbox_id: "ibx_1" },
          dependsOn: [],
          rationale: "x",
        },
      ]),
      catalog,
    );
    expect(v.ok).toBe(false);
    expect(v.steps[0]?.missingParams.sort()).toEqual(["body", "to"]);
    // missing-required must not be double-reported through ajv
    expect(v.steps[0]?.schemaErrors).toEqual([]);
  });

  it("type-checks literal values via ajv", () => {
    const v = validatePlan(
      planWith([
        {
          stepNumber: 1,
          operationId: "get_crypto_price",
          argTemplate: { symbol: "BTC", days: "seven", currency: "gbp" },
          dependsOn: [],
          rationale: "x",
        },
      ]),
      catalog,
    );
    expect(v.ok).toBe(false);
    expect(v.steps[0]?.schemaErrors.join("\n")).toMatch(/days/);
    expect(v.steps[0]?.schemaErrors.join("\n")).toMatch(/currency|enum/);
  });

  it("exempts {{step_N}} placeholders from type checks but counts them as present", () => {
    const v = validatePlan(
      planWith([
        {
          stepNumber: 1,
          operationId: "search_papers",
          argTemplate: { query: "LLM agents" },
          dependsOn: [],
          rationale: "x",
        },
        {
          stepNumber: 2,
          operationId: "get_crypto_price",
          // days would fail as a string literal, but it's a placeholder
          argTemplate: { symbol: "{{step_1.output.results.0.ticker}}", days: "{{step_1.output.window}}" },
          dependsOn: [1],
          rationale: "x",
        },
      ]),
      catalog,
    );
    expect(v.ok).toBe(true);
    expect(v.steps[1]?.missingParams).toEqual([]);
    expect(v.steps[1]?.schemaErrors).toEqual([]);
  });

  it("fails forward and self references from placeholders and dependsOn", () => {
    const v = validatePlan(
      planWith([
        {
          stepNumber: 1,
          operationId: "get_crypto_price",
          argTemplate: { symbol: "{{step_2.output.symbol}}" },
          dependsOn: [],
          rationale: "forward via placeholder",
        },
        {
          stepNumber: 2,
          operationId: "search_papers",
          argTemplate: { query: "q" },
          dependsOn: [2],
          rationale: "self via dependsOn",
        },
        {
          stepNumber: 3,
          operationId: "search_papers",
          argTemplate: { query: "q" },
          dependsOn: [99],
          rationale: "unknown step",
        },
      ]),
      catalog,
    );
    expect(v.ok).toBe(false);
    expect(v.steps[0]?.referenceErrors.join()).toMatch(/forward/);
    expect(v.steps[1]?.referenceErrors.join()).toMatch(/itself/);
    expect(v.steps[2]?.referenceErrors.join()).toMatch(/does not exist/);
  });

  it("emits write and cost warnings without failing the step", () => {
    const v = validatePlan(
      planWith([
        {
          stepNumber: 1,
          operationId: "send_email",
          argTemplate: { inbox_id: "ibx", to: "a@b.co", body: "hi" },
          dependsOn: [],
          rationale: "x",
        },
      ]),
      catalog,
    );
    expect(v.ok).toBe(true);
    expect(v.steps[0]?.warnings.join("\n")).toMatch(/write operation/);
    expect(v.steps[0]?.warnings.join("\n")).toMatch(/sends a real email/);
  });

  it("reports duplicate step numbers at plan level", () => {
    const v = validatePlan(
      planWith([
        { stepNumber: 1, operationId: "search_papers", argTemplate: { query: "a" }, dependsOn: [], rationale: "x" },
        { stepNumber: 1, operationId: "search_papers", argTemplate: { query: "b" }, dependsOn: [], rationale: "x" },
      ]),
      catalog,
    );
    expect(v.ok).toBe(false);
    expect(v.planErrors.join()).toMatch(/stepNumber 1/);
  });

  it("formats hard failures for the repair prompt", () => {
    const v = validatePlan(
      planWith([
        { stepNumber: 1, operationId: "nope", argTemplate: {}, dependsOn: [], rationale: "x" },
      ]),
      catalog,
    );
    const text = formatValidationFailures(v);
    expect(text).toMatch(/step 1/);
    expect(text).toMatch(/does not exist/);
  });
});
