import { describe, expect, it } from "vitest";
import { extractReplayInputs, replayTrace } from "../src/replay/trace-replay.js";
import type { AgentTaskRunResult, SuiteRunResult } from "../src/benchmark/types.js";
import type { TraceEvent } from "../src/runtime/events.js";

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
const task = {
	id: "task-1",
	type: "general" as const,
	title: "Task",
	prompt: "Prompt",
	scoring: { method: "rubric" as const },
};
const score = { score: 1, maxScore: 1, passed: true, reason: "ok" };

describe("trace replay", () => {
	it("summarizes a task run trace", () => {
		const run = runResult("run-1", events([
			["run_start", "e1", 1, {}],
			["model_request", "e2", 2, {}],
			["model_response", "e3", 3, {}],
			["tool_call", "e4", 4, { callId: "call-1" }],
			["tool_result", "e5", 5, { callId: "call-1" }],
			["run_end", "e6", 6, {}],
		]));

		const summary = replayTrace(extractReplayInputs(run)[0]!);

		expect(summary).toMatchObject({ runId: "run-1", eventCount: 6, modelRequestCount: 1, modelResponseCount: 1, toolCallCount: 1, toolResultCount: 1, warnings: [] });
	});

	it("extracts suite run traces", () => {
		const suite: SuiteRunResult = {
			suite: { id: "suite-1", name: "Suite", tasks: [task] },
			agent,
			runs: [runResult("run-1", events([["run_start", "e1", 1, {}], ["run_end", "e2", 2, {}]]))],
			summary: { totalTasks: 1, passedTasks: 1, failedTasks: 0, erroredTasks: 0, timeoutTasks: 0, interruptedTasks: 0, passRate: 1, totalScore: 1, maxScore: 1, averageScore: 1, totalDurationMs: 1, byTaskType: {} },
		};

		expect(extractReplayInputs(suite)).toHaveLength(1);
	});

	it("extracts embedded subagent traces as independent replay inputs", () => {
		const subTrace = events([["model_request", "s1", 10, {}], ["model_response", "s2", 11, {}]]).map((event) => ({ ...event, agentId: "worker", taskId: "sub-task", parentSessionId: "parent-session", parentToolCallId: "call-1", subagentId: "worker" }));
		const run = runResult("run-1", events([
			["tool_call", "e1", 1, { call: { id: "call-1", name: "subagent" } }],
			["tool_result", "e2", 2, { call: { id: "call-1", name: "subagent" }, output: { subagentId: "worker", agentId: "worker", taskId: "sub-task", sessionId: "sub-session", status: "completed", answer: "ok", trace: subTrace } }],
		]));

		const inputs = extractReplayInputs(run);
		const summaries = inputs.map(replayTrace);

		expect(inputs).toHaveLength(2);
		expect(summaries[1]).toMatchObject({ kind: "subagent", subagentId: "worker", agentId: "worker", taskId: "sub-task", eventCount: 2 });
	});

	it("warns about missing terminal events and unmatched tool calls", () => {
		const summary = replayTrace({ agentId: "agent-1", taskId: "task-1", trace: events([["run_start", "e1", 1, {}], ["tool_call", "e2", 2, { callId: "call-1" }]]) });

		expect(summary.warnings).toContain("tool_call call-1 has no matching tool_result");
		expect(summary.warnings).toContain("trace has no run_end or error event");
	});

	it("warns about out-of-order timestamps", () => {
		const summary = replayTrace({ trace: events([["run_start", "e1", 2, {}], ["run_end", "e2", 1, {}]]) });

		expect(summary.warnings).toContain("event e2 timestamp is out of order");
	});
});

function runResult(runId: string, trace: TraceEvent[]): AgentTaskRunResult {
	return { runId, agent, task, status: "passed", score, startedAt: 1, endedAt: 2, durationMs: 1, trace };
}

function events(items: Array<[TraceEvent["type"], string, number, unknown]>): TraceEvent[] {
	return items.map(([type, id, timestamp, payload]) => ({ id, type, timestamp, agentId: "agent-1", taskId: "task-1", payload } as TraceEvent));
}
