import type { SuiteRunResult } from "../benchmark/types.js";

export interface VerificationIssue {
	type: "regression" | "error" | "timeout" | "tool-policy" | "memory-regression";
	severity: "blocking" | "warning";
	taskId: string;
	message: string;
}

export interface VerificationReport {
	verdict: "pass" | "fail" | "partial";
	blocking: boolean;
	issues: VerificationIssue[];
	summary: string;
}

export function verifyEvolutionComparison(baseline: SuiteRunResult, candidate: SuiteRunResult): VerificationReport {
	const issues: VerificationIssue[] = [];
	const baselineRuns = new Map(baseline.runs.map((run) => [run.task.id, run]));

	for (const run of candidate.runs) {
		const baselineRun = baselineRuns.get(run.task.id);
		if (baselineRun?.status === "passed" && run.status !== "passed") {
			issues.push(blockingIssue("regression", run.task.id, `candidate regressed from ${baselineRun.status} to ${run.status}`));
		}
		if (run.status === "errored") {
			issues.push(blockingIssue("error", run.task.id, run.errorMessage ?? "candidate errored"));
		}
		if (run.status === "timeout") {
			issues.push(blockingIssue("timeout", run.task.id, run.errorMessage ?? "candidate timed out"));
		}
		for (const event of run.trace) {
			if (event.type !== "tool_result") continue;
			const payload = event.payload as { decision?: { decision?: string; reason?: string }; errorMessage?: string };
			if (payload.decision?.decision === "deny") {
				issues.push(blockingIssue("tool-policy", run.task.id, payload.errorMessage ?? payload.decision.reason ?? "tool use denied"));
			}
		}
		const baselineMemory = memoryIssueCount(baselineRun?.score.details);
		const candidateMemory = memoryIssueCount(run.score.details);
		if (candidateMemory > baselineMemory) {
			issues.push(blockingIssue("memory-regression", run.task.id, `candidate memory issues increased from ${baselineMemory} to ${candidateMemory}`));
		}
	}

	const blocking = issues.some((issue) => issue.severity === "blocking");
	return {
		verdict: issues.length === 0 ? "pass" : blocking ? "fail" : "partial",
		blocking,
		issues,
		summary: issues.length === 0 ? "No regressions or runtime issues detected" : `${issues.length} verification issue(s) detected`,
	};
}

function blockingIssue(type: VerificationIssue["type"], taskId: string, message: string): VerificationIssue {
	return { type, severity: "blocking", taskId, message };
}

function memoryIssueCount(details: Record<string, unknown> | undefined): number {
	const memory = details && typeof details.memory === "object" && details.memory !== null ? details.memory as Record<string, unknown> : undefined;
	return numberField(memory, "contaminationCount") + numberField(memory, "missingSourceRefs") + numberField(memory, "revokedCount");
}

function numberField(value: Record<string, unknown> | undefined, key: string): number {
	const field = value?.[key];
	return typeof field === "number" ? field : 0;
}
