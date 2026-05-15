/**
 * SOP Runner
 *
 * Executes an SOPSpec by running its steps in DAG order,
 * resolving parameters, executing actions, and collecting results.
 *
 * Action types:
 * - tool: Execute a tool from ToolRegistry
 * - prompt: Build a prompt from template + context
 * - sub_sop: Recursively run another SOP
 */

import type { ToolCall, ToolRegistry, ToolResult } from "../tools/registry.js";
import type { AgentSession } from "../runtime/session.js";
import type { SOPAction, SOPResult, SOPSchema, SOPSpec, SOPStep, SOPStepResult, SOPVerification } from "./types.js";
import { defaultSOPVerificationRunner, type SOPVerificationRunner, type VerificationContext } from "./verification.js";

export interface SOPRunOptions {
  params: Record<string, unknown>;
  session: AgentSession;
  toolRegistry: ToolRegistry;
  workspaceRoot?: string;
  verificationRunner?: SOPVerificationRunner;
  createId?: () => string;
  now?: () => number;
  signal?: AbortSignal;
  /**
   * How to run a sub-SOP. If not provided, sub_sop actions will fail.
   */
  runSubSOP?: (sopId: string, input: Record<string, unknown>, session: AgentSession) => Promise<SOPResult>;
  /**
   * LLM client for prompt actions. If not provided, prompt actions return the rendered template.
   */
  completePrompt?: (prompt: string, session: AgentSession) => Promise<string>;
}

/**
 * Top-level entry point: run an SOP end-to-end and return SOPResult.
 */
export async function runSOP(spec: SOPSpec, options: SOPRunOptions): Promise<SOPResult> {
  const startedAt = (options.now ?? Date.now)();
  const verificationRunner = options.verificationRunner ?? defaultSOPVerificationRunner;
  const stepResults: SOPStepResult[] = [];
  const stepOutputs: Record<string, unknown> = {};

  // Topological sort of steps based on dependsOn
  const orderedSteps = topoSort(spec.steps);
  const executionMode = spec.executionMode ?? "continue_on_failure";
  let overallStatus: SOPResult["status"] = "passed";
  let stopEarly = false;

  for (const step of orderedSteps) {
    if (stopEarly) {
      stepResults.push(makeStepResult(step.id, "skipped", undefined, undefined, 0, "stopped due to earlier failure"));
      continue;
    }
    if (options.signal?.aborted) {
      stepResults.push(makeStepResult(step.id, "skipped", undefined, undefined, 0, "aborted"));
      overallStatus = "failed";
      continue;
    }

    // Check precondition
    if (step.precondition) {
      const preconditionMet = await evaluatePrecondition(step.precondition, options);
      if (!preconditionMet) {
        stepResults.push(makeStepResult(step.id, "skipped", undefined, undefined, 0, "precondition not met"));
        continue;
      }
    }

    // Check all dependencies completed successfully
    const depsFailed = (step.dependsOn ?? []).filter((depId) => {
      const depResult = stepResults.find((r) => r.stepId === depId);
      return !depResult || depResult.status === "failed" || depResult.status === "error";
    });
    if (depsFailed.length > 0) {
      stepResults.push(makeStepResult(step.id, "skipped", undefined, undefined, 0, `dependency(s) failed: ${depsFailed.join(", ")}`));
      overallStatus = "partial";
      continue;
    }

    // Execute action
    const stepStarted = (options.now ?? Date.now)();
    try {
      const output = await executeAction(step.action, {
        spec,
        params: options.params,
        stepOutputs,
        session: options.session,
        toolRegistry: options.toolRegistry,
        workspaceRoot: options.workspaceRoot ?? ".",
        createId: options.createId ?? undefined,
        signal: options.signal ?? undefined,
        runSubSOP: options.runSubSOP ?? undefined,
        completePrompt: options.completePrompt ?? undefined,
      });
      const durationMs = (options.now ?? Date.now)() - stepStarted;
      stepOutputs[step.id] = output;

      // Step-level verification
      let verification: { passed: boolean; detail?: string | undefined } | undefined;
      if (step.verification) {
        const vCtx: VerificationContext = {
          stepId: step.id,
          output,
          params: options.params,
          stepOutputs,
          workspaceRoot: options.workspaceRoot ?? ".",
        };
        verification = await verificationRunner.verify(step.verification, vCtx);
      }

      const stepPassed = !verification || verification.passed;
      stepResults.push(makeStepResult(step.id, stepPassed ? "passed" : "failed", output, verification, durationMs));
      if (!stepPassed) overallStatus = "partial";
    } catch (error) {
      const durationMs = (options.now ?? Date.now)() - stepStarted;
      const errorMessage = error instanceof Error ? error.message : String(error);
      stepResults.push(makeStepResult(step.id, "error", undefined, undefined, durationMs, errorMessage));
      overallStatus = "failed";
      if (executionMode === "stop_on_failure") stopEarly = true;
    }
  }

  // Final verification
  let finalVerification: { passed: boolean; detail?: string | undefined } | undefined;
  if (spec.verification && overallStatus !== "failed") {
    const lastOutput = stepResults.filter((r) => r.status === "passed").at(-1)?.output;
    const vCtx: VerificationContext = {
      stepId: "__final__",
      output: lastOutput,
      params: options.params,
      stepOutputs,
      workspaceRoot: options.workspaceRoot ?? ".",
    };
    const fvResult = await verificationRunner.verify(spec.verification, vCtx);
    finalVerification = fvResult;
    if (!fvResult.passed && overallStatus === "passed") {
      overallStatus = "failed";
    }
  }

  // If any step failed but not all, mark as partial
  const hasFailures = stepResults.some((r) => r.status === "failed" || r.status === "error");
  const allPassed = stepResults.every((r) => r.status === "passed" || r.status === "skipped");
  if (hasFailures && allPassed) overallStatus = "partial";

  const totalDurationMs = (options.now ?? Date.now)() - startedAt;

  return {
    sopId: spec.id,
    status: overallStatus,
    stepResults,
    ...(finalVerification ? { finalVerification } : {}),
    totalDurationMs,
    trace: stepResults, // Reuse stepResults as the serializable trace
  } as SOPResult;
}

// ---- Action execution ----

interface ActionContext {
  spec: SOPSpec;
  params: Record<string, unknown>;
  stepOutputs: Record<string, unknown>;
  session: AgentSession;
  toolRegistry: ToolRegistry;
  workspaceRoot: string;
  createId: (() => string) | undefined;
  signal: AbortSignal | undefined;
  runSubSOP: ((sopId: string, input: Record<string, unknown>, session: AgentSession) => Promise<SOPResult>) | undefined;
  completePrompt: ((prompt: string, session: AgentSession) => Promise<string>) | undefined;
}

async function executeAction(action: SOPAction, ctx: ActionContext): Promise<unknown> {
  switch (action.type) {
    case "tool":
      return executeToolAction(action, ctx);
    case "prompt":
      return executePromptAction(action, ctx);
    case "sub_sop":
      return executeSubSOPAction(action, ctx);
  }
}

async function executeToolAction(
  action: Extract<SOPAction, { type: "tool" }>,
  ctx: ActionContext,
): Promise<unknown> {
  const tool = ctx.toolRegistry.get(action.tool);
  if (!tool) throw new Error(`tool "${action.tool}" not found in registry`);

  const resolvedInput = resolveTemplates(action.input, ctx.params, ctx.stepOutputs);
  const call: ToolCall = {
    id: ctx.createId?.() ?? crypto.randomUUID(),
    name: action.tool,
    input: resolvedInput,
  };

  // Execute tool directly (bypassing policy for SOP-internal calls)
  const output = await tool.execute(resolvedInput, ctx.signal, { session: ctx.session, call });
  return output;
}

async function executePromptAction(
  action: Extract<SOPAction, { type: "prompt" }>,
  ctx: ActionContext,
): Promise<unknown> {
  const rendered = resolveTemplateString(action.template, ctx.params, ctx.stepOutputs);
  if (ctx.completePrompt) {
    return ctx.completePrompt(rendered, ctx.session);
  }
  return rendered;
}

async function executeSubSOPAction(
  action: Extract<SOPAction, { type: "sub_sop" }>,
  ctx: ActionContext,
): Promise<unknown> {
  if (!ctx.runSubSOP) throw new Error("sub_sop action requires runSubSOP option");
  const resolvedInput = resolveTemplates(action.input, ctx.params, ctx.stepOutputs) as Record<string, unknown>;
  const result = await ctx.runSubSOP(action.sopId, resolvedInput, ctx.session);
  return result;
}

// ---- Template resolution ----

/**
 * Recursively resolve {{params.xxx}} and {{steps.xxx.output}} placeholders in objects.
 */
function resolveTemplates(obj: unknown, params: Record<string, unknown>, stepOutputs: Record<string, unknown>): unknown {
  if (typeof obj === "string") return resolveTemplateString(obj, params, stepOutputs);
  if (Array.isArray(obj)) return obj.map((item) => resolveTemplates(item, params, stepOutputs));
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveTemplates(value, params, stepOutputs);
    }
    return result;
  }
  return obj;
}

/**
 * Replace {{params.xxx}} and {{steps.xxx.output}} in a string.
 */
function resolveTemplateString(template: string, params: Record<string, unknown>, stepOutputs: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const trimmed = path.trim();
    if (trimmed.startsWith("params.")) {
      const key = trimmed.slice("params.".length);
      const value = resolvePath(params, key);
      return value !== undefined ? String(value) : `{{${trimmed}}}`;
    }
    if (trimmed.startsWith("steps.")) {
      const parts = trimmed.split(".");
      // steps.<stepId>.output[.nested...]
      const stepId = parts[1];
      if (stepId && stepOutputs[stepId] !== undefined) {
        const output = stepOutputs[stepId];
        const rest = parts.slice(2);
        // "output" is a keyword meaning the full step output
        if (rest.length === 0 || (rest.length === 1 && rest[0] === "output")) {
          return typeof output === "string" ? output : JSON.stringify(output);
        }
        if (rest[0] === "output") {
          const value = resolvePath(output as Record<string, unknown>, rest.slice(1).join("."));
          return value !== undefined ? (typeof value === "string" ? value : JSON.stringify(value)) : `{{${trimmed}}}`;
        }
      }
    }
    return `{{${trimmed}}}`;
  });
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ---- Precondition evaluation ----

async function evaluatePrecondition(precondition: SOPStep["precondition"], options: SOPRunOptions): Promise<boolean> {
  if (!precondition) return true;
  switch (precondition.type) {
    case "artifact_exists": {
      const path = String(precondition.config.path ?? "");
      try {
        const fs = await import("node:fs/promises");
        await fs.access(path);
        return true;
      } catch {
        return false;
      }
    }
    case "tool_available": {
      const toolName = String(precondition.config.tool ?? "");
      return options.toolRegistry.get(toolName) !== undefined;
    }
    case "script": {
      const command = String(precondition.config.command ?? "");
      if (!command) return false;
      try {
        const { execSync } = await import("node:child_process");
        execSync(command, { timeout: 10_000, stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    }
    default:
      return true;
  }
}

// ---- DAG Sort ----

function topoSort(steps: SOPStep[]): SOPStep[] {
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: SOPStep[] = [];

  function visit(stepId: string) {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) {
      throw new Error(`circular dependency detected: step "${stepId}" is part of a cycle`);
    }
    visiting.add(stepId);
    const step = stepMap.get(stepId);
    if (!step) {
      visiting.delete(stepId);
      return;
    }
    for (const dep of step.dependsOn ?? []) {
      visit(dep);
    }
    visiting.delete(stepId);
    visited.add(stepId);
    result.push(step);
  }

  for (const step of steps) {
    visit(step.id);
  }
  return result;
}

// ---- Helpers ----

function makeStepResult(
  stepId: string,
  status: SOPStepResult["status"],
  output: unknown,
  verification: { passed: boolean; detail?: string | undefined } | undefined,
  durationMs: number,
  error?: string,
): SOPStepResult {
  return {
    stepId,
    status,
    output,
    ...(verification ? { verification } : {}),
    durationMs,
    ...(error ? { error } : {}),
  };
}
