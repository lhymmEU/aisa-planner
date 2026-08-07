import { Ajv2020, type ValidateFunction, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type {
  Catalog,
  JSONSchema,
  Plan,
  PlanValidation,
  StepValidation,
} from "./types.js";

/** Matches "{{step_3.output.anything}}" anywhere inside a string value. */
const STEP_REF = /\{\{\s*step[_.\s-]?(\d+)[^}]*\}\}/gi;

const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  allowUnionTypes: true,
});
addFormats(ajv);

const compiled = new WeakMap<JSONSchema, ValidateFunction | null>();

function compileSchema(schema: JSONSchema): ValidateFunction | null {
  if (compiled.has(schema)) return compiled.get(schema) ?? null;
  let fn: ValidateFunction | null = null;
  try {
    fn = ajv.compile(schema);
  } catch {
    fn = null; // catalog-side schema problem; reported as a warning, not a plan error
  }
  compiled.set(schema, fn);
  return fn;
}

interface TemplateScan {
  /** JSON-pointer paths (ajv instancePath format) of placeholder string values. */
  placeholderPaths: Set<string>;
  /** All step numbers referenced via {{step_N...}} placeholders. */
  referencedSteps: number[];
}

function scanTemplate(value: unknown, path: string, out: TemplateScan): void {
  if (typeof value === "string") {
    let matched = false;
    for (const m of value.matchAll(STEP_REF)) {
      matched = true;
      out.referencedSteps.push(Number(m[1]));
    }
    if (matched) out.placeholderPaths.add(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanTemplate(v, `${path}/${i}`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scanTemplate(v, `${path}/${escapePointer(k)}`, out);
    }
  }
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function formatAjvError(err: ErrorObject): string {
  const where = err.instancePath === "" ? "argTemplate" : `argTemplate${err.instancePath}`;
  const extra =
    err.keyword === "additionalProperties"
      ? ` ("${String((err.params as { additionalProperty?: string }).additionalProperty)}" is not a known parameter)`
      : "";
  return `${where} ${err.message ?? "is invalid"}${extra}`;
}

/**
 * Pure plan validation against a catalog. Never throws on plan content —
 * every problem is reported in the returned structure. Hard failures
 * (existence, missing required params, schema violations on literal values,
 * bad step references) set `ok: false`; write/cost notes are warnings only.
 */
export function validatePlan(plan: Plan, catalog: Catalog): PlanValidation {
  const planErrors: string[] = [];

  const seen = new Map<number, number>();
  for (const step of plan.steps) {
    seen.set(step.stepNumber, (seen.get(step.stepNumber) ?? 0) + 1);
  }
  for (const [num, count] of seen) {
    if (count > 1) planErrors.push(`stepNumber ${num} is used by ${count} steps`);
    if (!Number.isInteger(num) || num < 1) {
      planErrors.push(`stepNumber ${num} is not a positive integer`);
    }
  }
  if (plan.steps.length === 0) planErrors.push("plan has no steps");

  const knownSteps = new Set(seen.keys());
  const steps: StepValidation[] = plan.steps.map((step) => {
    const op = catalog.byId.get(step.operationId);
    const result: StepValidation = {
      stepNumber: step.stepNumber,
      operationId: step.operationId,
      exists: op !== undefined,
      missingParams: [],
      schemaErrors: [],
      referenceErrors: [],
      warnings: [],
      ok: true,
    };

    const scan: TemplateScan = { placeholderPaths: new Set(), referencedSteps: [] };
    scanTemplate(step.argTemplate, "", scan);

    // Every reference — explicit dependsOn or embedded {{step_N}} — must point
    // to an existing, strictly earlier step.
    const refs = new Set<number>([...step.dependsOn, ...scan.referencedSteps]);
    for (const ref of refs) {
      if (!knownSteps.has(ref)) {
        result.referenceErrors.push(`references step ${ref}, which does not exist in the plan`);
      } else if (ref === step.stepNumber) {
        result.referenceErrors.push(`references itself (step ${ref})`);
      } else if (ref > step.stepNumber) {
        result.referenceErrors.push(
          `references step ${ref}, which runs after step ${step.stepNumber} (forward reference)`,
        );
      }
    }

    if (op === undefined) {
      result.ok = false;
      return result;
    }

    // Required params must be present as keys; a placeholder value counts as present.
    for (const param of op.requiredParams) {
      if (!(param in step.argTemplate)) result.missingParams.push(param);
    }

    // Ajv over the template; errors at placeholder paths are exempt (their
    // runtime type is unknowable until an earlier step produces output).
    const validate = compileSchema(op.inputSchema);
    if (validate === null) {
      result.warnings.push(
        `input schema for ${op.operationId} could not be compiled; literal values were not type-checked`,
      );
    } else {
      validate(step.argTemplate);
      for (const err of validate.errors ?? []) {
        if (scan.placeholderPaths.has(err.instancePath)) continue;
        if (
          err.keyword === "required" &&
          err.instancePath === "" &&
          result.missingParams.includes(
            String((err.params as { missingProperty?: string }).missingProperty),
          )
        ) {
          continue; // already reported via missingParams
        }
        result.schemaErrors.push(formatAjvError(err));
      }
    }

    if (op.kind === "write") {
      result.warnings.push(
        `write operation (${op.method} ${op.path}) — has side effects; confirm before executing`,
      );
    }
    if (op.costNote) {
      result.warnings.push(`cost: ${op.costNote}`);
    }

    result.ok =
      result.missingParams.length === 0 &&
      result.schemaErrors.length === 0 &&
      result.referenceErrors.length === 0;
    return result;
  });

  return {
    ok: planErrors.length === 0 && steps.every((s) => s.ok),
    steps,
    planErrors,
  };
}

/** Render hard failures as a compact block, e.g. for the planner's repair retry. */
export function formatValidationFailures(validation: PlanValidation): string {
  const lines: string[] = [];
  for (const err of validation.planErrors) lines.push(`- plan: ${err}`);
  for (const s of validation.steps) {
    if (s.ok) continue;
    if (!s.exists) lines.push(`- step ${s.stepNumber}: operationId "${s.operationId}" does not exist`);
    if (s.missingParams.length > 0) {
      lines.push(`- step ${s.stepNumber} (${s.operationId}): missing required params: ${s.missingParams.join(", ")}`);
    }
    for (const e of s.schemaErrors) lines.push(`- step ${s.stepNumber} (${s.operationId}): ${e}`);
    for (const e of s.referenceErrors) lines.push(`- step ${s.stepNumber} (${s.operationId}): ${e}`);
  }
  return lines.join("\n");
}
