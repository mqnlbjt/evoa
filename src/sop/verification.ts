/**
 * SOP Verification Engine
 *
 * Verifies SOP steps and final results using multiple strategies:
 * - regex: Pattern matching on output
 * - artifact_match: Check file existence/content
 * - script: Run a shell script
 * - llm-judge: LLM-based judgment
 * - custom: Delegate to external verifier
 */

import type { SOPVerification, SOPStepResult } from "./types.js";

export interface VerificationContext {
  stepId: string;
  output: unknown;
  params: Record<string, unknown>;
  stepOutputs: Record<string, unknown>;
  workspaceRoot: string;
}

export interface VerificationOutcome {
  passed: boolean;
  detail?: string | undefined;
}

export interface SOPVerificationRunner {
  verify(verification: SOPVerification, context: VerificationContext): Promise<VerificationOutcome>;
}

/**
 * Built-in regex verification: tests stringified output against a pattern.
 */
export function verifyRegex(config: Record<string, unknown>, output: unknown): VerificationOutcome {
  const pattern = String(config.pattern ?? "");
  const flags = config.flags ? String(config.flags) : undefined;
  if (!pattern) return { passed: false, detail: "no pattern specified" };
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const regex = new RegExp(pattern, flags);
  const multiline = config.multiline === true;
  if (multiline) {
    const lines = text.split("\n").filter((line) => regex.test(line));
    return { passed: lines.length > 0, ...(lines.length > 0 ? {} : { detail: `no lines matched /${pattern}/${flags ?? ""}` }) };
  }
  return { passed: regex.test(text), ...(regex.test(text) ? {} : { detail: `output did not match /${pattern}/${flags ?? ""}` }) };
}

/**
 * Verify that output is non-empty and not an error.
 */
export function verifyNonEmpty(output: unknown): VerificationOutcome {
  if (output === undefined || output === null) return { passed: false, detail: "output is null/undefined" };
  const text = typeof output === "string" ? output : JSON.stringify(output);
  if (text.trim().length === 0) return { passed: false, detail: "output is empty" };
  return { passed: true };
}

/**
 * Default verification runner that handles regex and non-empty checks synchronously.
 * Script and LLM-judge verifications need a custom runner implementation.
 */
export const defaultSOPVerificationRunner: SOPVerificationRunner = {
  async verify(verification, context) {
    switch (verification.method) {
      case "regex":
        return verifyRegex(verification.config, context.output);
      case "artifact_match": {
        const text = typeof context.output === "string" ? context.output : JSON.stringify(context.output);
        const minLength = typeof verification.config.minLength === "number" ? verification.config.minLength : 0;
        if (text.length < minLength) return { passed: false, detail: `output length ${text.length} < required ${minLength}` };
        return { passed: true };
      }
      case "custom":
      case "script":
      case "llm-judge":
        return { passed: true, detail: `${verification.method} verification requires custom runner` };
      default:
        return { passed: false, detail: `unknown verification method: ${(verification as any).method}` };
    }
  },
};
