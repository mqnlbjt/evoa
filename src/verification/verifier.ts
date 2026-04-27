import type { SuiteRunResult } from "../benchmark/types.js";

export interface VerificationIssue {
	type: "regression" | "error" | "timeout" | "tool-policy";
	taskId: string;
	message: string;
}

export interface VerificationReport {
	verdict: "pass" | "fail" | "partial";
	issues: VerificationIssue[];
	summary: string;
}

export function verifyEvolutionComparison(baseline: SuiteRunResult, candidate: SuiteRunResult): VerificationReport {
	const issues: VerificationIssue[] = [];
	const baselineRuns = new Map(baseline.runs.map((run) => [run.task.id, run]));

	for (const run of candidate.runs) {
		const baselineRun = baselineRuns.get(run.task.id);
		if (baselineRun?.status === "passed" && run.status !== "passed") {
			issues.push({ type: "regression", taskId: run.task.id, message: `candidate regressed from ${baselineRun.status} to ${run.status}` });
		}
		if (run.status === "errored") {
			issues.push({ type: "error", taskId: run.task.id, message: run.errorMessage ?? "candidate errored" });
		}
		if (run.status === "timeout") {
			issues.push({ type: "timeout", taskId: run.task.id, message: run.errorMessage ?? "candidate timed out" });
		}
		for (const event of run.trace) {
			if (event.type !== "tool_result") continue;
			const payload = event.payload as { decision?: { decision?: string; reason?: string }; errorMessage?: string };
			if (payload.decision?.decision === "deny") {
				issues.push({
					type: "tool-policy",
					taskId: run.task.id,
					message: payload.errorMessage ?? payload.decision.reason ?? "tool use denied",
				});
			}
		}
	}

	return {
		verdict: issues.length === 0 ? "pass" : issues.some((issue) => issue.type === "regression" || issue.type === "error") ? "fail" : "partial",
		issues,
		summary: issues.length === 0 ? "No regressions or runtime issues detected" : `${issues.length} verification issue(s) detected`,
	};
}
