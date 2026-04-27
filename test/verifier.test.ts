import { describe, expect, it } from "vitest";
import { verifyEvolutionComparison } from "../src/verification/verifier.js";
import type { AgentTaskRunResult, SuiteRunResult } from "../src/benchmark/types.js";
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
		expect(report.issues[0]?.type).toBe("regression");
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
						payload: { decision: { decision: "deny", reason: "denied" } },
					},
				],
			}),
		);

		expect(report.verdict).toBe("partial");
		expect(report.issues[0]?.type).toBe("tool-policy");
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
