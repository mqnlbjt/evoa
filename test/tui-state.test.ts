import { describe, expect, it } from "vitest";
import { TuiState } from "../src/tui/state.js";
import type { TraceEvent } from "../src/runtime/events.js";

const base = {
	agentName: "Agent",
	agentId: "agent",
	model: "model",
	provider: "provider",
	toolProfile: "coding",
	cwd: ".",
	sessionId: "session",
	now: () => 1,
	createId: (() => {
		let id = 0;
		return () => `log-${++id}`;
	})(),
};

describe("TuiState", () => {
	it("maps model and tool events into snapshot state", () => {
		const state = new TuiState(base);
		state.applyTraceEvent(event("model_request", { turn: 1 }));
		expect(state.snapshot().status).toBe("thinking");
		state.applyTraceEvent(event("model_response", { text: "hi" }));
		expect(state.snapshot().log.at(-1)).toMatchObject({ kind: "assistant", text: "hi" });
		state.applyTraceEvent(event("tool_call", { call: { id: "call", name: "read_file", input: { path: "a" } } }));
		expect(state.snapshot()).toMatchObject({ status: "running_tool", runningToolName: "read_file" });
		state.applyTraceEvent(event("tool_result", { call: { id: "call", name: "read_file" }, decision: { decision: "allow" }, status: "denied", errorMessage: "blocked" }));
		expect(state.snapshot().runningTools).toHaveLength(0);
		expect(state.snapshot().log.at(-1)).toMatchObject({ kind: "tool_result", severity: "error" });
	});

	it("maps run lifecycle events into snapshot status", () => {
		const state = new TuiState(base);
		state.applyTraceEvent(event("run_start", {}));
		expect(state.snapshot()).toMatchObject({ status: "thinking", runStartedAt: 1 });
		state.applyTraceEvent(event("run_end", { status: "passed", durationMs: 3 }));
		expect(state.snapshot()).toMatchObject({ status: "done", runDurationMs: 3 });
		state.applyTraceEvent(event("run_start", {}));
		expect(state.snapshot().runDurationMs).toBeUndefined();
		state.applyTraceEvent(event("run_end", { status: "timeout" }));
		expect(state.snapshot()).toMatchObject({ status: "error", lastError: "run ended with status: timeout" });
	});

	it("aggregates tool timing buckets", () => {
		const state = new TuiState(base);
		state.applyTraceEvent(event("run_start", {}));
		state.applyTraceEvent(event("tool_result", { call: { id: "tool", name: "read_file" }, decision: { decision: "allow" }, status: "success", durationMs: 5 }));
		state.applyTraceEvent(event("tool_result", { call: { id: "mcp", name: "mcp__context7__query-docs" }, decision: { decision: "allow" }, status: "success", durationMs: 7 }));
		state.applyTraceEvent(event("tool_result", { call: { id: "skill", name: "Skill" }, decision: { decision: "allow" }, status: "success", durationMs: 11 }));
		expect(state.snapshot()).toMatchObject({ toolDurationMs: 23, mcpDurationMs: 7, skillDurationMs: 11 });
		state.applyTraceEvent(event("run_start", {}));
		expect(state.snapshot()).toMatchObject({ toolDurationMs: 0, mcpDurationMs: 0, skillDurationMs: 0 });
	});

	it("renders assistant deltas as one finalized assistant log entry", () => {
		const state = new TuiState(base);
		state.applyTraceEvent(event("assistant_delta", { delta: "hel" }));
		state.applyTraceEvent(event("assistant_delta", { text: "lo" }));
		expect(state.snapshot().log).toMatchObject([{ kind: "assistant", text: "hello" }]);
		state.applyTraceEvent(event("model_response", { text: "hello!" }));
		expect(state.snapshot().log).toMatchObject([{ kind: "assistant", text: "hello!" }]);
	});

	it("limits retained log and trace entries", () => {
		const state = new TuiState({ ...base, maxLogEntries: 2, maxTraceEvents: 3 });
		state.addUserMessage("one");
		state.addUserMessage("two");
		state.addUserMessage("three");
		expect(state.snapshot().log.map((entry) => entry.text)).toEqual(["two", "three"]);
		state.applyTraceEvent(event("model_request", { turn: 1 }));
		state.applyTraceEvent(event("model_request", { turn: 2 }));
		state.applyTraceEvent(event("model_request", { turn: 3 }));
		state.applyTraceEvent(event("model_request", { turn: 4 }));
		expect(state.snapshot().trace.map((entry) => (entry.payload as { turn: number }).turn)).toEqual([2, 3, 4]);
		expect(state.snapshot().stats.model.requestCount).toBe(4);
	});

	it("clears log without clearing trace", () => {
		const state = new TuiState(base);
		state.addUserMessage("hello");
		state.applyTraceEvent(event("model_request", { turn: 1 }));
		state.clearLog();
		expect(state.snapshot().log).toHaveLength(0);
		expect(state.snapshot().trace).toHaveLength(1);
		expect(state.snapshot().stats.model.requestCount).toBe(1);
	});

	it("switches active view", () => {
		const state = new TuiState(base);
		expect(state.snapshot().activeView).toBe("chat");
		state.setView("stats");
		expect(state.snapshot().activeView).toBe("stats");
	});
});

function event(type: TraceEvent["type"], payload: unknown): TraceEvent {
	return { id: `event-${type}`, type, timestamp: 1, agentId: "agent", taskId: "task", sessionId: "session", payload };
}
