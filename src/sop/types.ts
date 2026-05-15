/**
 * SOP Core Types
 *
 * Defines the Standard Operating Procedure (SOP) structure.
 * Based on docs/sop-example.ts.
 */

export interface SOPSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface SOPCondition {
  type: "artifact_exists" | "tool_available" | "script" | "custom";
  config: Record<string, unknown>;
}

export type SOPAction =
  | { type: "tool"; tool: string; input: Record<string, unknown> }
  | { type: "prompt"; template: string }
  | { type: "sub_sop"; sopId: string; input: Record<string, unknown> };

export interface SOPVerification {
  method: "artifact_match" | "script" | "llm-judge" | "regex" | "custom";
  config: Record<string, unknown>;
}

export interface SOPStep {
  id: string;
  name: string;
  description: string;
  dependsOn?: string[];
  precondition?: SOPCondition;
  action: SOPAction;
  outputSchema?: unknown;
  verification?: SOPVerification;
}

export interface SOPSpec {
  id: string;
  version: string;
  name: string;
  description: string;
  params: SOPSchema;
  steps: SOPStep[];
  executionMode?: "stop_on_failure" | "continue_on_failure";
  verification?: SOPVerification;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface SOPStepResult {
  stepId: string;
  status: "passed" | "failed" | "skipped" | "timeout" | "error";
  output: unknown;
  verification?: { passed: boolean; detail?: string | undefined } | undefined;
  durationMs: number;
  error?: string | undefined;
}

export interface SOPResult {
  sopId: string;
  status: "passed" | "failed" | "partial";
  stepResults: SOPStepResult[];
  finalVerification?: { passed: boolean; detail?: string | undefined } | undefined;
  totalDurationMs: number;
  trace: unknown;
}
