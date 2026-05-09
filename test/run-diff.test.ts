import { describe, expect, it } from "vitest";
import { diffSuiteRuns, diffTaskRuns } from "../src/replay/run-diff.js";
import type { AgentTaskRunResult, SuiteRunResult } from "../src/benchmark/types.js";

const agent = {
	id: "agent-1",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline" as const,
	model: { provider: "local", model: "model" },
	prompts: { system: "system" },
	tools: { allowedTools: [] },
	runtime: { maxTurns: 1 },
};

describe("run diff", () => {
	it("classifies failed to passed as improvement", () => {
		const diff = diffTaskRuns(run("left", "task-1", "failed", 0), run("right", "task-1", "passed", 1));

		expect(diff).toMatchObject({ taskId: "task-1", statusChanged: true, scoreDelta: 1, classification: "improvement" });
	});

	it("classifies passed to failed as regression", () => {
		const diff = diffTaskRuns(run("left", "task-1", "passed", 1), run("right", "task-1", "failed", 0));

		expect(diff).toMatchObject({ statusChanged: true, scoreDelta: -1, classification: "regression" });
	});

	it("counts event deltas", () => {
		const left = run("left", "task-1", "passed", 1, ["tool_call"]);
		const right = run("right", "task-1", "passed", 1, ["tool_call", "tool_call", "error"]);

		const diff = diffTaskRuns(left, right);

		expect(diff).toMatchObject({ eventCountDelta: 2, toolCallCountDelta: 1, errorCountDelta: 1 });
	});

	it("diffs suites by task id", () => {
		const left = suite([run("left-1", "task-1", "failed", 0), run("left-2", "task-2", "passed", 1)]);
		const right = suite([run("right-1", "task-1", "passed", 1), run("right-2", "task-2", "passed", 1), run("right-3", "task-3", "passed", 1)]);

		const diff = diffSuiteRuns(left, right);

		expect(diff.improvements).toEqual(["task-1"]);
		expect(diff.unchanged).toEqual(["task-2"]);
		expect(diff.missingLeft).toEqual(["task-3"]);
	});
});

function suite(runs: AgentTaskRunResult[]): SuiteRunResult {
	return {
		suite: { id: "suite-1", name: "Suite", tasks: runs.map((item) => item.task) },
		agent,
		runs,
		summary: { totalTasks: runs.length, passedTasks: 0, failedTasks: 0, erroredTasks: 0, timeoutTasks: 0, interruptedTasks: 0, passRate: 0, totalScore: 0, maxScore: runs.length, averageScore: 0, totalDurationMs: 0, byTaskType: {} },
	};
}

function run(runId: string, taskId: string, status: AgentTaskRunResult["status"], scoreValue: number, eventTypes: string[] = []): AgentTaskRunResult {
	const task = { id: taskId, type: "general" as const, title: taskId, prompt: "Prompt", scoring: { method: "rubric" as const } };
	return {
		runId,
		agent,
		task,
		status,
		score: { score: scoreValue, maxScore: 1, passed: status === "passed", reason: "ok" },
		startedAt: 1,
		endedAt: 3,
		durationMs: 2,
		trace: eventTypes.map((type, index) => ({ id: `${runId}-${index}`, type: type as never, timestamp: index, agentId: agent.id, taskId, payload: {} })),
	};
}
