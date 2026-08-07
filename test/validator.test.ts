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

  it("rejects invented/misspelled parameter names (closed schema backstop)", () => {
    const v = validatePlan(
      planWith([
        {
          stepNumber: 1,
          operationId: "get_crypto_price",
          argTemplate: { symbol: "BTC", dayz: 7 },
          dependsOn: [],
          rationale: "x",
        },
      ]),
      catalog,
    );
    expect(v.ok).toBe(false);
    expect(v.steps[0]?.schemaErrors.join("\n")).toMatch(/"dayz" is not a known parameter/);
  });

  it("still rejects invented params whose value is a placeholder", () => {
    const v = validatePlan(
      planWith([
        { stepNumber: 1, operationId: "search_papers", argTemplate: { query: "q" }, dependsOn: [], rationale: "x" },
        {
          stepNumber: 2,
          operationId: "get_crypto_price",
          argTemplate: { symbol: "BTC", invented: "{{step_1.output.x}}" },
          dependsOn: [1],
          rationale: "x",
        },
      ]),
      catalog,
    );
    expect(v.ok).toBe(false);
    expect(v.steps[1]?.schemaErrors.join("\n")).toMatch(/"invented" is not a known parameter/);
  });

  it("never throws on malformed step shapes — reports them instead", () => {
    const v = validatePlan(
      planWith([
        // dependsOn missing entirely
        {
          stepNumber: 1,
          operationId: "search_papers",
          argTemplate: { query: "q" },
          rationale: "x",
        } as never,
        // argTemplate is a string, not an object
        {
          stepNumber: 2,
          operationId: "send_email",
          argTemplate: "not an object" as never,
          dependsOn: [1],
          rationale: "x",
        },
      ]),
      catalog,
    );
    expect(v.ok).toBe(false);
    expect(v.steps[0]?.ok).toBe(true);
    expect(v.steps[1]?.schemaErrors.join()).toMatch(/argTemplate must be a JSON object/);
    expect(v.steps[1]?.missingParams.sort()).toEqual(["body", "inbox_id", "to"]);
  });

  it("handles a plan whose steps field is not an array", () => {
    const v = validatePlan({ goal: "x", assumptions: [], steps: "nope" as never }, catalog);
    expect(v.ok).toBe(false);
    expect(v.planErrors.join()).toMatch(/must be an array/);
  });

  it("flags a steps array not ordered by stepNumber", () => {
    const v = validatePlan(
      planWith([
        { stepNumber: 2, operationId: "search_papers", argTemplate: { query: "b" }, dependsOn: [], rationale: "x" },
        { stepNumber: 1, operationId: "search_papers", argTemplate: { query: "a" }, dependsOn: [], rationale: "x" },
      ]),
      catalog,
    );
    expect(v.ok).toBe(false);
    expect(v.planErrors.join()).toMatch(/not ordered by stepNumber/);
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
