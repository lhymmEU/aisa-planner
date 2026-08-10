import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlan } from "../src/planner.js";
import { renderPlanMarkdown } from "../src/markdown.js";
import { validatePlan } from "../src/validator.js";
import type { Plan } from "../src/types.js";
import { makeCatalog } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

/** OpenAI-style chat completion carrying a JSON object as its content. */
function chatResponse(object: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "cmpl-1",
      object: "chat.completion",
      created: 1,
      model: "test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify(object) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function embeddingsResponse(): Response {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 1, 0, 0] }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Entries are plan objects, or { raw } for verbatim content, or { status } for HTTP errors. */
function stubNetwork(planObjects: unknown[]): ReturnType<typeof vi.fn> {
  let call = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/embeddings")) return embeddingsResponse();
    if (url.includes("/chat/completions")) {
      const entry = planObjects[Math.min(call, planObjects.length - 1)] as
        | { raw?: string; status?: number }
        | Record<string, unknown>;
      call += 1;
      if (entry && typeof entry === "object" && "status" in entry && entry.status) {
        return new Response("denied", { status: entry.status as number });
      }
      if (entry && typeof entry === "object" && "raw" in entry && entry.raw !== undefined) {
        return chatRawResponse(String(entry.raw));
      }
      return chatResponse(entry);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function chatRawResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "cmpl-1",
      object: "chat.completion",
      created: 1,
      model: "test",
      choices: [
        { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const GOOD_PLAN = {
  goal: "find papers",
  assumptions: ["recent = last 12 months"],
  steps: [
    {
      stepNumber: 1,
      operationId: "search_papers",
      argTemplate: { query: "LLM agents" },
      dependsOn: [],
      rationale: "search for the papers",
    },
  ],
};

describe("createPlan", () => {
  it("returns a hydrated, validated plan without ever sending schemas to the LLM", async () => {
    const fetchMock = stubNetwork([GOOD_PLAN]);
    const result = await createPlan("find recent papers about LLM agents", {
      apiKey: "k",
      catalog: makeCatalog(),
    });

    expect(result.validation.ok).toBe(true);
    const step = result.plan.steps[0]!;
    expect(step.method).toBe("GET");
    expect(step.path).toBe("/scholar/search");
    expect(step.inputSchema).toBeDefined();

    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    const body = JSON.parse(String((chatCalls[0]![1] as RequestInit).body));
    const promptText = JSON.stringify(body.messages);
    expect(promptText).toContain("search_papers");
    expect(promptText).not.toContain("inputSchema");
    expect(promptText).not.toContain('"properties"');
  });

  it("retries exactly once on hard validation failures and returns red badges, not exceptions", async () => {
    const badPlan = {
      ...GOOD_PLAN,
      steps: [
        {
          stepNumber: 1,
          operationId: "hallucinated_op",
          argTemplate: {},
          dependsOn: [],
          rationale: "x",
        },
      ],
    };
    const fetchMock = stubNetwork([badPlan, badPlan]);
    const result = await createPlan("whatever", { apiKey: "k", catalog: makeCatalog() });

    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/chat/completions"));
    expect(chatCalls).toHaveLength(2);
    const retryBody = JSON.parse(String((chatCalls[1]![1] as RequestInit).body));
    expect(JSON.stringify(retryBody.messages)).toContain("does not exist");
    expect(result.validation.ok).toBe(false);
    expect(result.validation.steps[0]?.exists).toBe(false);
  });

  it("does not retry when the first plan is valid", async () => {
    const fetchMock = stubNetwork([GOOD_PLAN]);
    await createPlan("x", { apiKey: "k", catalog: makeCatalog() });
    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/chat/completions"));
    expect(chatCalls).toHaveLength(1);
  });

  it("rethrows transport/auth errors immediately without a repair retry", async () => {
    const fetchMock = stubNetwork([{ status: 401 }]);
    await expect(createPlan("x", { apiKey: "bad", catalog: makeCatalog() })).rejects.toThrow();
    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/chat/completions"));
    expect(chatCalls.length).toBeLessThanOrEqual(1);
  });

  it("salvages a plan wrapped in markdown fences without burning the repair retry", async () => {
    const fetchMock = stubNetwork([
      { raw: "Here is your plan:\n```json\n" + JSON.stringify(GOOD_PLAN) + "\n```\nHope this helps!" },
    ]);
    const result = await createPlan("x", { apiKey: "k", catalog: makeCatalog() });
    expect(result.validation.ok).toBe(true);
    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/chat/completions"));
    expect(chatCalls).toHaveLength(1);
  });

  it("salvages a plan preceded by prose without fences", async () => {
    const fetchMock = stubNetwork([
      { raw: "Sure! The plan object is " + JSON.stringify(GOOD_PLAN) + " — let me know." },
    ]);
    const result = await createPlan("x", { apiKey: "k", catalog: makeCatalog() });
    expect(result.validation.ok).toBe(true);
    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/chat/completions"));
    expect(chatCalls).toHaveLength(1);
  });

  it("gives non-JSON model output one repair retry, then succeeds", async () => {
    const fetchMock = stubNetwork([{ raw: "Sorry, here is prose, not JSON." }, GOOD_PLAN]);
    const result = await createPlan("x", { apiKey: "k", catalog: makeCatalog() });
    expect(result.validation.ok).toBe(true);
    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/chat/completions"));
    expect(chatCalls).toHaveLength(2);
  });

  it("normalizes step array order to stepNumber order", async () => {
    const outOfOrder = {
      goal: "two things",
      assumptions: [],
      steps: [
        {
          stepNumber: 2,
          operationId: "get_crypto_price",
          argTemplate: { symbol: "BTC" },
          dependsOn: [],
          rationale: "then price",
        },
        {
          stepNumber: 1,
          operationId: "search_papers",
          argTemplate: { query: "q" },
          dependsOn: [],
          rationale: "papers first",
        },
      ],
    };
    stubNetwork([outOfOrder]);
    const result = await createPlan("x", { apiKey: "k", catalog: makeCatalog() });
    expect(result.plan.steps.map((s) => s.stepNumber)).toEqual([1, 2]);
    expect(result.validation.ok).toBe(true);
  });

  it("fails fast when a tag filter matches nothing", async () => {
    stubNetwork([GOOD_PLAN]);
    await expect(
      createPlan("x", { apiKey: "k", catalog: makeCatalog(), tags: ["No Such Tag"] }),
    ).rejects.toThrow(/No operations match tags/);
  });
});

describe("renderPlanMarkdown", () => {
  it("renders auth preamble, fenced schemas, warnings and badges", () => {
    const catalog = makeCatalog();
    const plan: Plan = {
      goal: "email the summary",
      assumptions: ["inbox already exists"],
      steps: [
        {
          stepNumber: 1,
          operationId: "search_papers",
          argTemplate: { query: "LLM agents" },
          dependsOn: [],
          rationale: "find the papers",
        },
        {
          stepNumber: 2,
          operationId: "send_email",
          argTemplate: {
            inbox_id: "ibx_1",
            to: "me@example.com",
            body: "{{step_1.output.results}}",
          },
          dependsOn: [1],
          rationale: "send the digest",
        },
      ],
    };
    const validation = validatePlan(plan, catalog);
    const md = renderPlanMarkdown(
      {
        ...plan,
        steps: plan.steps.map((s) => ({
          ...s,
          ...catalog.byId.get(s.operationId)!,
          stepNumber: s.stepNumber,
          argTemplate: s.argTemplate,
          dependsOn: s.dependsOn,
          rationale: s.rationale,
        })),
      },
      validation,
    );

    expect(md).toContain("https://api.aisa.one/apis/v1");
    expect(md).toContain("Authorization: Bearer $AISA_API_KEY");
    expect(md).toContain("## Step 1");
    expect(md).toContain("```json");
    expect(md).toContain("⚠ write operation");
    expect(md).toContain("sends a real email");
    expect(md).toContain("✅");
    expect(md).toContain("Depends on: step 1");
  });

  it("keeps badges attached to the right step when step numbers are duplicated", () => {
    const catalog = makeCatalog();
    const plan: Plan = {
      goal: "dup",
      assumptions: [],
      steps: [
        { stepNumber: 1, operationId: "search_papers", argTemplate: { query: "a" }, dependsOn: [], rationale: "ok step" },
        { stepNumber: 1, operationId: "nope_op", argTemplate: {}, dependsOn: [], rationale: "bad step" },
      ],
    };
    const validation = validatePlan(plan, catalog);
    const md = renderPlanMarkdown(plan, validation);
    // The failing duplicate must render ❌ — not inherit the other step's ✅.
    expect(md).toContain("❌");
    expect(md.indexOf("nope_op")).toBeGreaterThan(-1);
    const nopeSection = md.slice(md.indexOf("`nope_op`"));
    expect(nopeSection).toContain("operationId not found in catalog");
    expect(nopeSection.split("## Step")[0]).not.toContain("✅");
  });

  it("marks invalid plans with a prominent stop banner", () => {
    const catalog = makeCatalog();
    const plan: Plan = {
      goal: "broken",
      assumptions: [],
      steps: [
        { stepNumber: 1, operationId: "nope", argTemplate: {}, dependsOn: [], rationale: "x" },
      ],
    };
    const md = renderPlanMarkdown(plan, validatePlan(plan, catalog));
    expect(md).toContain("⛔");
    expect(md).toContain("❌");
  });
});
