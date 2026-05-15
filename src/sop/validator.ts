/**
 * SOP Validator
 *
 * Validates SOPSpec objects at runtime:
 * - Required fields
 * - Step ID uniqueness
 * - Dependency references exist
 * - No circular dependencies
 * - Tool references (when knownTools is provided)
 */

import type { SOPSpec } from "./types.js";

export interface ValidateOptions {
  /** If provided, validate that all tool actions reference known tools. */
  knownTools?: Set<string>;
}

export function validateSOPSpec(value: unknown, options: ValidateOptions = {}): SOPSpec {
  if (!value || typeof value !== "object") {
    throw new Error("SOP spec must be an object");
  }

  const spec = value as Record<string, unknown>;

  // Required string fields
  for (const field of ["id", "version", "name"]) {
    if (typeof spec[field] !== "string" || (spec[field] as string).trim().length === 0) {
      throw new Error(`SOP "${spec.id ?? "?"}" missing required field "${field}"`);
    }
  }

  const id = spec.id as string;

  // description
  if (spec.description !== undefined && typeof spec.description !== "string") {
    throw new Error(`SOP "${id}": "description" must be a string`);
  }

  // params
  if (!spec.params || typeof spec.params !== "object") {
    throw new Error(`SOP "${id}": "params" is required and must be an object`);
  }
  const params = spec.params as Record<string, unknown>;
  if (params.type !== "object") {
    throw new Error(`SOP "${id}": params.type must be "object"`);
  }

  // steps
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    throw new Error(`SOP "${id}": "steps" must be a non-empty array`);
  }

  const steps = spec.steps as Record<string, unknown>[];
  const stepIds = new Set<string>();

  // First pass: collect all step IDs and validate basic fields
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const stepId = step.id;
    if (typeof stepId !== "string" || stepId.trim().length === 0) {
      throw new Error(`SOP "${id}": step[${i}] missing "id"`);
    }
    if (stepIds.has(stepId)) {
      throw new Error(`SOP "${id}": duplicate step id "${stepId}"`);
    }
    stepIds.add(stepId);

    if (typeof step.name !== "string") {
      throw new Error(`SOP "${id}" step "${stepId}": "name" is required`);
    }

    const action = step.action as Record<string, unknown> | undefined;
    if (!action || typeof action !== "object") {
      throw new Error(`SOP "${id}" step "${stepId}": "action" is required`);
    }

    const actionType = action.type;
    if (actionType === "tool") {
      if (typeof action.tool !== "string" || action.tool.trim().length === 0) {
        throw new Error(`SOP "${id}" step "${stepId}": tool action requires "tool" name`);
      }
      if (options.knownTools && !options.knownTools.has(action.tool as string)) {
        throw new Error(`SOP "${id}" step "${stepId}": unknown tool "${action.tool}"`);
      }
    } else if (actionType === "prompt") {
      if (typeof action.template !== "string") {
        throw new Error(`SOP "${id}" step "${stepId}": prompt action requires "template" string`);
      }
    } else if (actionType === "sub_sop") {
      if (typeof action.sopId !== "string" || action.sopId.trim().length === 0) {
        throw new Error(`SOP "${id}" step "${stepId}": sub_sop action requires "sopId"`);
      }
    } else {
      throw new Error(`SOP "${id}" step "${stepId}": unknown action type "${String(actionType)}"`);
    }
  }

  // Second pass: validate dependsOn references (all step IDs are known)
  for (const step of steps) {
    const stepId = step.id as string;
    if (step.dependsOn !== undefined) {
      if (!Array.isArray(step.dependsOn)) {
        throw new Error(`SOP "${id}" step "${stepId}": "dependsOn" must be an array`);
      }
      for (const dep of step.dependsOn as string[]) {
        if (!stepIds.has(dep)) {
          throw new Error(`SOP "${id}" step "${stepId}": dependsOn references undefined step "${dep}"`);
        }
        if (dep === stepId) {
          throw new Error(`SOP "${id}" step "${stepId}": dependsOn cannot reference itself`);
        }
      }
    }
  }

  // Validate executionMode
  if (spec.executionMode !== undefined) {
    if (spec.executionMode !== "stop_on_failure" && spec.executionMode !== "continue_on_failure") {
      throw new Error(`SOP "${id}": executionMode must be "stop_on_failure" or "continue_on_failure"`);
    }
  }

  // Detect circular dependencies via topological sort
  detectCycles(id, steps);

  // timeoutMs
  if (spec.timeoutMs !== undefined && (typeof spec.timeoutMs !== "number" || spec.timeoutMs <= 0)) {
    throw new Error(`SOP "${id}": timeoutMs must be a positive number`);
  }

  return value as unknown as SOPSpec;
}

function detectCycles(sopId: string, steps: Record<string, unknown>[]): void {
  const stepMap = new Map<string, string[]>();
  for (const step of steps) {
    const deps = (step.dependsOn as string[] | undefined) ?? [];
    stepMap.set(step.id as string, [...deps]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(stepId: string): void {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) {
      throw new Error(`SOP "${sopId}": circular dependency detected involving step "${stepId}"`);
    }
    visiting.add(stepId);
    for (const dep of stepMap.get(stepId) ?? []) {
      visit(dep);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  }

  for (const stepId of stepMap.keys()) {
    visit(stepId);
  }
}
