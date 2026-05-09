import { describe, expect, it } from "vitest";
import { verifyEvolutionComparison } from "../src/verification/verifier.js";
import type { AgentTaskRunResult, SuiteRunResult } from "../src/benchmark/types.js";
import type { TraceEvent } from "../src/runtime/events.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "system" },
	tools: { allowedTools: [] },
	runtime: { maxTurns: 1 },
};
const task: TaskSpec = { id: "task", type: "general", title: "Task", prompt: "prompt", scoring: { method: "exact" } };

describe("verifyEvolutionComparison", () => {
	it("fails on regressions", () => {
		const report = verifyEvolutionComparison(suite(run("passed")), suite(run("failed")));

		expect(report.verdict).toBe("fail");
		expect(report.blocking).toBe(true);
		expect(report.issues[0]).toMatchObject({ type: "regression", severity: "blocking" });
	});

	it("passes when no issues are found", () => {
		const report = verifyEvolutionComparison(suite(run("passed")), suite(run("passed")));

		expect(report).toMatchObject({ verdict: "pass", blocking: false, issues: [] });
	});

	it("blocks on timeout", () => {
		const report = verifyEvolutionComparison(suite(run("failed")), suite(run("timeout")));

		expect(report).toMatchObject({ verdict: "fail", blocking: true });
		expect(report.issues[0]).toMatchObject({ type: "timeout", severity: "blocking" });
	});

	it("reports memory regressions", () => {
		const report = verifyEvolutionComparison(
			suite(run("passed")),
			suite({ ...run("passed"), score: { score: 1, maxScore: 1, passed: true, reason: "ok", details: { memory: { contaminationCount: 1, missingSourceRefs: 1, revokedCount: 0 } } } }),
		);

		expect(report.verdict).toBe("fail");
		expect(report.issues[0]).toMatchObject({ type: "memory-regression", severity: "blocking" });
	});

	it("blocks on compaction circuit breaker", () => {
			const report = verifyEvolutionComparison(
				suite(run("passed")),
				suite({
					...run("passed"),
					trace: makeEvent("context_compaction", { reason: "circuit_breaker" }),
				}),
			);

			expect(report.verdict).toBe("fail");
			expect(report.blocking).toBe(true);
			expect(report.issues[0]).toMatchObject({ type: "compaction-failure", severity: "blocking" });
		});

		it("warns on compaction failure", () => {
			const report = verifyEvolutionComparison(
				suite(run("passed")),
				suite({
					...run("passed"),
					trace: makeEvent("context_compaction", { reason: "failed", failure: "model error" }),
				}),
			);

			expect(report.verdict).toBe("partial");
			expect(report.blocking).toBe(false);
			expect(report.issues[0]).toMatchObject({ type: "compaction-failure", severity: "warning" });
		});

		it("warns on untrimmable context", () => {
			const report = verifyEvolutionComparison(
				suite(run("passed")),
				suite({
					...run("passed"),
					trace: makeEvent("context_trim", { reason: "untrimmable", tokenEstimateAfter: 100_000 }),
				}),
			);

			expect(report.verdict).toBe("partial");
			expect(report.blocking).toBe(false);
			expect(report.issues[0]).toMatchObject({ type: "context-untrimmable", severity: "warning" });
		});

		it("reports denied tool policy events", () => {
		const report = verifyEvolutionComparison(
			suite(run("failed")),
			suite({
				...run("failed"),
				trace: [
					{
						id: "event",
						type: "tool_result",
						timestamp: 1,
						agentId: "agent",
						taskId: "task",
						payload: { call: { id: "c1", name: "test" }, decision: { decision: "deny", reason: "denied" }, status: "denied", visibleContentPreview: "denied" },
					} as TraceEvent,
				],
			}),
		);

		expect(report.verdict).toBe("fail");
		expect(report.blocking).toBe(true);
		expect(report.issues[0]).toMatchObject({ type: "tool-policy", severity: "blocking" });
	});
});

function suite(runResult: AgentTaskRunResult): SuiteRunResult {
	return {
		agent,
		suite: { id: "suite", name: "Suite", tasks: [task] },
		runs: [runResult],
		summary: {
			totalTasks: 1,
			passedTasks: runResult.status === "passed" ? 1 : 0,
			failedTasks: runResult.status === "failed" ? 1 : 0,
			erroredTasks: runResult.status === "errored" ? 1 : 0,
			timeoutTasks: runResult.status === "timeout" ? 1 : 0,
			passRate: runResult.status === "passed" ? 1 : 0,
			totalScore: runResult.score.score,
			maxScore: 1,
			averageScore: runResult.score.score,
			totalDurationMs: 1,
			byTaskType: {},
		},
	};
}

function run(status: AgentTaskRunResult["status"]): AgentTaskRunResult {
	return {
		runId: "run",
		agent,
		task,
		status,
		score: { score: status === "passed" ? 1 : 0, maxScore: 1, passed: status === "passed", reason: status },
		startedAt: 1,
		endedAt: 2,
		durationMs: 1,
		trace: [],
	};
}

function makeEvent(type: TraceEvent["type"], overrides: Record<string, unknown>): TraceEvent[] {
	return [{ id: "event", type, timestamp: 1, agentId: "agent", taskId: "task", payload: overrides } as TraceEvent];
}
