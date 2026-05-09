import type { SuiteRunResult } from "../benchmark/types.js";

export interface VerificationIssue {
	type: "regression" | "error" | "timeout" | "tool-policy" | "memory-regression" | "compaction-failure" | "context-untrimmable";
	severity: "blocking" | "warning";
	taskId: string;
	message: string;
	details?: Record<string, unknown>;
}

export interface PolicyEventArtifact {
	taskId: string;
	toolName: string;
	toolCallId: string;
	decision: string;
	reason?: string | undefined;
	errorMessage?: string | undefined;
}

export interface TruncationArtifact {
	taskId: string;
	toolName: string;
	toolCallId: string;
	strategy: string;
	originalBytes: number;
	visibleBytes: number;
	omittedBytes: number;
}

export interface ErrorArtifact {
	taskId: string;
	errorCategory?: string | undefined;
	errorSource?: string | undefined;
	errorPhase?: string | undefined;
	rawErrorName?: string | undefined;
	errorMessage?: string | undefined;
}

export interface VerificationArtifact {
	policyEvents: PolicyEventArtifact[];
	truncationEvents: TruncationArtifact[];
	errors: ErrorArtifact[];
	summary: {
		totalFailures: number;
		totalPolicyDenials: number;
		totalTruncations: number;
		totalTruncationBytesOmitted: number;
		totalErrors: number;
	};
}

export interface VerificationReport {
	verdict: "pass" | "fail" | "partial";
	blocking: boolean;
	issues: VerificationIssue[];
	summary: string;
	artifact: VerificationArtifact;
}

export function verifyEvolutionComparison(baseline: SuiteRunResult, candidate: SuiteRunResult): VerificationReport {
	const issues: VerificationIssue[] = [];
	const policyEvents: PolicyEventArtifact[] = [];
	const truncationEvents: TruncationArtifact[] = [];
	const errors: ErrorArtifact[] = [];
	const baselineRuns = new Map(baseline.runs.map((run) => [run.task.id, run]));

	for (const run of candidate.runs) {
		const baselineRun = baselineRuns.get(run.task.id);
		if (baselineRun?.status === "passed" && run.status !== "passed") {
			const details: Record<string, unknown> = { baselineStatus: baselineRun.status, candidateStatus: run.status, candidateError: run.errorMessage ?? null };
			issues.push(blockingIssue("regression", run.task.id, `candidate regressed from ${baselineRun.status} to ${run.status}`, details));
		}
		if (run.status === "errored") {
			const details: Record<string, unknown> = { errorMessage: run.errorMessage ?? null };
			issues.push(blockingIssue("error", run.task.id, run.errorMessage ?? "candidate errored", details));
			errors.push({ taskId: run.task.id, errorMessage: run.errorMessage });
		}
		if (run.status === "timeout") {
			const details: Record<string, unknown> = { errorMessage: run.errorMessage ?? null, durationMs: run.durationMs };
			issues.push(blockingIssue("timeout", run.task.id, run.errorMessage ?? "candidate timed out", details));
		}
		for (const event of run.trace) {
			if (event.type === "tool_result") {
				const payload = event.payload;
				if (payload.decision?.decision === "deny") {
					const reason = payload.errorMessage ?? payload.decision.reason ?? "tool use denied";
					const details: Record<string, unknown> = { toolName: payload.call.name, toolCallId: payload.call.id, decision: payload.decision.decision, reason: payload.decision.reason ?? null, errorMessage: payload.errorMessage ?? null };
					issues.push(blockingIssue("tool-policy", run.task.id, reason, details));
					policyEvents.push({
						taskId: run.task.id,
						toolName: payload.call.name,
						toolCallId: payload.call.id,
						decision: payload.decision.decision,
						reason: payload.decision.reason,
						errorMessage: payload.errorMessage,
					});
				}
				if (payload.metadata?.toolOutput?.truncated) {
					const meta = payload.metadata.toolOutput;
					const details: Record<string, unknown> = { toolName: payload.call.name, toolCallId: payload.call.id, strategy: meta.strategy, originalBytes: meta.originalBytes, visibleBytes: meta.visibleBytes, omittedBytes: meta.omittedBytes ?? 0 };
					issues.push(warningIssue("tool-policy", run.task.id, `tool output truncated: ${payload.call.name} (${meta.originalBytes} → ${meta.visibleBytes} bytes, strategy=${meta.strategy})`, details));
					truncationEvents.push({
						taskId: run.task.id,
						toolName: payload.call.name,
						toolCallId: payload.call.id,
						strategy: meta.strategy,
						originalBytes: meta.originalBytes,
						visibleBytes: meta.visibleBytes,
						omittedBytes: meta.omittedBytes ?? 0,
					});
				}
				if (payload.errorMessage && payload.errorCategory) {
					errors.push({
						taskId: run.task.id,
						errorCategory: payload.errorCategory,
						errorSource: payload.errorSource,
						errorPhase: payload.errorPhase,
						rawErrorName: payload.rawErrorName,
						errorMessage: payload.errorMessage,
					});
				}
				continue;
			}
			if (event.type === "context_compaction") {
				const payload = event.payload;
				if (payload.reason === "circuit_breaker") {
					const details: Record<string, unknown> = { reason: payload.reason, tokenEstimateBefore: payload.tokenEstimateBefore };
					issues.push(blockingIssue("compaction-failure", run.task.id, "context compaction circuit breaker triggered", details));
				} else if (payload.reason === "failed" && payload.failure) {
					const details: Record<string, unknown> = { reason: payload.reason, failure: payload.failure, tokenEstimateBefore: payload.tokenEstimateBefore };
					issues.push(warningIssue("compaction-failure", run.task.id, `context compaction failed: ${payload.failure}`, details));
				}
				continue;
			}
			if (event.type === "context_trim" && event.payload.reason === "untrimmable") {
				const details: Record<string, unknown> = { reason: event.payload.reason, tokenEstimateAfter: event.payload.tokenEstimateAfter };
				issues.push(warningIssue("context-untrimmable", run.task.id, `context untrimmable: ${event.payload.tokenEstimateAfter} tokens after trim`, details));
				continue;
			}
		}
		const baselineMemory = memoryIssueCount(baselineRun?.score.details);
		const candidateMemory = memoryIssueCount(run.score.details);
		if (candidateMemory > baselineMemory) {
			const details: Record<string, unknown> = { baselineMemoryIssues: baselineMemory, candidateMemoryIssues: candidateMemory };
			issues.push(blockingIssue("memory-regression", run.task.id, `candidate memory issues increased from ${baselineMemory} to ${candidateMemory}`, details));
		}
	}

	const blocking = issues.some((issue) => issue.severity === "blocking");
	const totalTruncationBytesOmitted = truncationEvents.reduce((sum, t) => sum + t.omittedBytes, 0);
	return {
		verdict: issues.length === 0 ? "pass" : blocking ? "fail" : "partial",
		blocking,
		issues,
		summary: issues.length === 0 ? "No regressions or runtime issues detected" : `${issues.length} verification issue(s) detected`,
		artifact: {
			policyEvents,
			truncationEvents,
			errors,
			summary: {
				totalFailures: issues.filter((i) => i.severity === "blocking").length,
				totalPolicyDenials: policyEvents.length,
				totalTruncations: truncationEvents.length,
				totalTruncationBytesOmitted,
				totalErrors: errors.length,
			},
		},
	};
}

function blockingIssue(type: VerificationIssue["type"], taskId: string, message: string, details?: Record<string, unknown>): VerificationIssue {
	return { type, severity: "blocking", taskId, message, ...(details ? { details } : {}) };
}

function warningIssue(type: VerificationIssue["type"], taskId: string, message: string, details?: Record<string, unknown>): VerificationIssue {
	return { type, severity: "warning", taskId, message, ...(details ? { details } : {}) };
}

function memoryIssueCount(details: Record<string, unknown> | undefined): number {
	const memory = details && typeof details.memory === "object" && details.memory !== null ? details.memory as Record<string, unknown> : undefined;
	return numberField(memory, "contaminationCount") + numberField(memory, "missingSourceRefs") + numberField(memory, "revokedCount");
}

function numberField(value: Record<string, unknown> | undefined, key: string): number {
	const field = value?.[key];
	return typeof field === "number" ? field : 0;
}
