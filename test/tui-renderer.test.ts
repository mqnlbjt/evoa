import { describe, expect, it } from "vitest";
import { InputEditor } from "../src/tui/input-editor.js";
import { renderTui as renderTuiWithAnsi } from "../src/tui/renderer.js";
import { TuiState } from "../src/tui/state.js";

function renderTui(...args: Parameters<typeof renderTuiWithAnsi>): string {
	return plain(renderTuiWithAnsi(...args));
}

function plain(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("renderTui", () => {
	it("renders header log footer and input", () => {
		const state = createState();
		state.addUserMessage("hello");
		state.addSystemMessage("# title\n- item\n```\ncode\n```");
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 80, height: 20, now: 2 });
		expect(output).toContain("evolving-agent | Agent");
		expect(output).toContain("┃ You  hello");
		expect(output).toContain("status: idle");
		expect(output).not.toContain("task:");
		expect(output).toContain("> ");
		expect(output.endsWith("\n")).toBe(false);
	});

	it("colors user assistant and tool log prefixes", () => {
		const state = createState();
		state.addUserMessage("hello");
		state.applyTraceEvent({ id: "response", type: "model_response", timestamp: 1, agentId: "agent", taskId: "task", payload: { text: "hi" } });
		state.applyTraceEvent({ id: "call", type: "tool_call", timestamp: 1, agentId: "agent", taskId: "task", payload: { call: { id: "call", name: "read_file", input: { path: "a" } } } });
		const output = renderTuiWithAnsi(state.snapshot(), new InputEditor(), { width: 100, height: 20, now: 2 });
		expect(output).toContain("\x1b[36m┃ You  \x1b[0mhello");
		expect(output).toContain("\x1b[32m┃ LLM  \x1b[0mhi");
		expect(output).toContain("\x1b[33m┆ Tool \x1b[0m→ read_file a");
	});

	it("renders streaming assistant status running tools and errors", () => {
		const state = createState();
		state.applyTraceEvent({ id: "start", type: "run_start", timestamp: 1, agentId: "agent", taskId: "task", payload: {} });
		state.applyTraceEvent({ id: "delta", type: "assistant_delta", timestamp: 1, agentId: "agent", taskId: "task", payload: { delta: "working" } });
		state.applyTraceEvent({ id: "call", type: "tool_call", timestamp: 1, agentId: "agent", taskId: "task", payload: { call: { id: "call", name: "read_file", input: { path: "a" } } } });
		state.applyTraceEvent({ id: "end", type: "run_end", timestamp: 1, agentId: "agent", taskId: "task", payload: { status: "failed" } });
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 100, height: 20, now: 2 });
		expect(output).toContain("┃ LLM  working");
		expect(output).toContain("┆ Tool → read_file a");
		expect(output).toContain("running: read_file");
		expect(output).toContain("status: error");
		expect(output).toContain("task: 0ms");
		expect(output).toContain("error: run ended with status: failed");
	});

	it("renders task and categorized tool timings", () => {
		const state = createState();
		state.applyTraceEvent({ id: "start", type: "run_start", timestamp: 10, agentId: "agent", taskId: "task", payload: {} });
		state.applyTraceEvent(toolResult("tool", "read_file", 5));
		state.applyTraceEvent(toolResult("mcp", "mcp__context7__query-docs", 7));
		state.applyTraceEvent(toolResult("skill", "Skill", 11));
		state.applyTraceEvent({ id: "end", type: "run_end", timestamp: 40, agentId: "agent", taskId: "task", payload: { status: "passed", durationMs: 30 } });
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 120, height: 20, now: 50 });
		expect(output).toContain("runs: 1");
		expect(output).toContain("task: 30ms");
		expect(output).toContain("tool: 23ms");
		expect(output).toContain("mcp: 7ms");
		expect(output).toContain("skill: 11ms");
	});

	it("renders running task timing before run end", () => {
		const state = createState();
		state.applyTraceEvent({ id: "start", type: "run_start", timestamp: 10, agentId: "agent", taskId: "task", payload: {} });
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 80, height: 20, now: 25 });
		expect(output).toContain("task: 15ms");
	});

	it("renders stats page", () => {
		const state = createState();
		state.applyTraceEvent({ id: "request", type: "model_request", timestamp: 1, agentId: "agent", taskId: "task", payload: { turn: 1 } });
		state.applyTraceEvent({ id: "response", type: "model_response", timestamp: 11, agentId: "agent", taskId: "task", payload: { text: "hi", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, timing: { startedAt: 1, endedAt: 11, durationMs: 10 } } });
		state.applyTraceEvent(toolResult("tool", "read_file", 5));
		state.setView("stats");
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 120, height: 30, now: 20 });
		expect(output).toContain("STATS OVERVIEW");
		expect(output).toContain("TOKENS");
		expect(output).toContain("total: 15");
		expect(output).toContain("MODEL LATENCY");
		expect(output).toContain("TOP TOOLS BY DURATION");
		expect(output).toContain("read_file");
		expect(output).toContain("view: stats");
	});

	it("renders trace page", () => {
		const state = createState();
		state.applyTraceEvent({ id: "request", type: "model_request", timestamp: 1, agentId: "agent", taskId: "task", payload: { turn: 1 } });
		state.setView("trace");
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 100, height: 20, now: 2 });
		expect(output).toContain("TRACE EVENTS");
		expect(output).toContain("model_request | request");
		expect(output).toContain("view: trace");
	});

	it("shows only the latest turn by default in a small viewport", () => {
		const state = createState();
		for (const value of ["one", "two", "three", "four", "five"]) state.addUserMessage(value);
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 80, height: 10, now: 2 });
		expect(output).not.toContain("┃ You  four");
		expect(output).toContain("┃ You  five");
	});

	it("uses logScrollOffset to move to previous turns without mixing them", () => {
		const state = createState();
		for (const value of ["one", "two", "three", "four", "five"]) state.addUserMessage(value);
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 80, height: 10, now: 2, logScrollOffset: 2 });
		expect(output).toContain("┃ You  three");
		expect(output).not.toContain("┃ You  two");
		expect(output).not.toContain("┃ You  four");
	});

	it("clamps logScrollOffset to the oldest turn", () => {
		const state = createState();
		for (const value of ["one", "two", "three", "four", "five"]) state.addUserMessage(value);
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 80, height: 10, now: 2, logScrollOffset: 100 });
		expect(output).toContain("┃ You  one");
		expect(output).not.toContain("┃ You  two");
		expect(output).not.toContain("┃ You  five");
	});

	it("can scroll to the beginning of a long assistant message", () => {
		const state = createState();
		state.applyTraceEvent({ id: "response", type: "model_response", timestamp: 1, agentId: "agent", taskId: "task", payload: { text: "line1\nline2\nline3\nline4\nline5\nline6" } });
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 80, height: 10, now: 2, logScrollOffset: 3 });
		expect(output).toContain("┃ LLM  line1");
		expect(output).toContain("┃      line2");
		expect(output).not.toContain("┃      line6");
	});

	it("wraps long assistant lines before applying the viewport", () => {
		const state = createState();
		state.applyTraceEvent({ id: "response", type: "model_response", timestamp: 1, agentId: "agent", taskId: "task", payload: { text: "abcdefghijklmnopqrstuvwxyz" } });
		const bottom = renderTui(state.snapshot(), new InputEditor(), { width: 18, height: 10, now: 2 });
		expect(bottom).toContain("┃ LLM  abcdefghijk");
		expect(bottom).toContain("┃      lmnopqrstuv");
		expect(bottom).toContain("┃      wxyz");
		const top = renderTui(state.snapshot(), new InputEditor(), { width: 18, height: 8, now: 2, logScrollOffset: 3 });
		expect(top).toContain("┃ LLM  abcdefghijk");
		expect(top).toContain("┃      wxyz");
	});

	it("does not backfill a short viewport with lines from another turn", () => {
		const state = createState();
		state.addUserMessage("first question");
		state.applyTraceEvent({ id: "first", type: "model_response", timestamp: 1, agentId: "agent", taskId: "task", payload: { text: "first answer" } });
		state.addUserMessage("second question");
		state.applyTraceEvent({ id: "second", type: "model_response", timestamp: 1, agentId: "agent", taskId: "task", payload: { text: "line1\nline2\nline3\nline4\nline5\nline6" } });
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 80, height: 10, now: 2, logScrollOffset: 3 });
		expect(output).toContain("┃ LLM  line1");
		expect(output).toContain("┃      line3");
		expect(output).not.toContain("first question");
		expect(output).not.toContain("first answer");
	});

	it("wraps wide characters by display width", () => {
		const state = createState();
		state.addUserMessage("你好世界abc");
		const output = renderTui(state.snapshot(), new InputEditor(), { width: 10, height: 12, now: 2 });
		expect(output).toContain("┃ You  你");
		expect(output).toContain("┃      好");
		expect(output).toContain("┃      世");
		expect(output).toContain("┃      界a");
		expect(output).toContain("┃      bc");
	});
});

function createState(): TuiState {
	return new TuiState({ agentName: "Agent", agentId: "agent", model: "model", provider: "provider", toolProfile: "coding", cwd: ".", sessionId: "session", now: () => 1, createId: () => "id" });
}

function toolResult(id: string, name: string, durationMs: number) {
	return {
		id,
		type: "tool_result" as const,
		timestamp: 20,
		agentId: "agent",
		taskId: "task",
		payload: { call: { id, name }, decision: { decision: "allow" }, status: "success", durationMs },
	};
}
