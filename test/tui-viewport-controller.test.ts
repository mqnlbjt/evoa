import { describe, expect, it } from "vitest";
import { TuiViewportController } from "../src/tui/viewport-controller.js";
import type { TuiStateSnapshot, TuiView } from "../src/tui/types.js";

describe("TuiViewportController", () => {
	it("scrolls chat by log entries", () => {
		const viewport = new TuiViewportController();

		expect(viewport.handleScrollInput("\x1b[5~", snapshot("chat"), 10)).toBe(true);
		expect(viewport.logScrollOffset()).toBe(1);
		expect(viewport.handleScrollInput("\x1b[6~", snapshot("chat"), 10)).toBe(true);
		expect(viewport.logScrollOffset()).toBe(0);
	});

	it("scrolls trace and stats by page size", () => {
		const viewport = new TuiViewportController();

		viewport.handleScrollInput("\x1b[5~", snapshot("trace"), 20);
		expect(viewport.viewScrollOffset("trace")).toBe(13);
		viewport.handleScrollInput("\x1b[5~", snapshot("stats", 2), 20);
		expect(viewport.viewScrollOffset("stats")).toBe(11);
	});

	it("resets only the selected view", () => {
		const viewport = new TuiViewportController();
		viewport.handleScrollInput("\x1b[5~", snapshot("chat"), 10);
		viewport.handleScrollInput("\x1b[5~", snapshot("trace"), 20);

		viewport.reset("trace");
		expect(viewport.logScrollOffset()).toBe(1);
		expect(viewport.viewScrollOffset("trace")).toBe(0);
	});

	it("ignores non-scroll input", () => {
		const viewport = new TuiViewportController();

		expect(viewport.handleScrollInput("a", snapshot("chat"), 10)).toBe(false);
		expect(viewport.logScrollOffset()).toBe(0);
	});
});

function snapshot(activeView: TuiView, runningToolCount = 0): TuiStateSnapshot {
	return {
		agentName: "Agent",
		agentId: "agent",
		model: "model",
		provider: "provider",
		toolProfile: "coding",
		cwd: ".",
		sessionId: "session",
		status: "idle",
		turnCount: 0,
		toolCallCount: 0,
		activeView,
		stats: {
			overview: { eventCount: 0, turnCount: 0 },
			runs: { count: 0, passed: 0, failed: 0, errored: 0, timeout: 0, totalDurationMs: 0 },
			model: { requestCount: 0, responseCount: 0, assistantDeltaCount: 0, tokens: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, latency: { count: 0, totalMs: 0 } },
			tools: { callCount: 0, resultCount: 0, statuses: { success: 0, error: 0, denied: 0, unknown: 0, limit_exceeded: 0, timeout: 0 }, totalDurationMs: 0, mcpCount: 0, mcpDurationMs: 0, skillCount: 0, skillDurationMs: 0, memory: {} },
			scores: { count: 0, passed: 0 },
			errors: { count: 0 },
			topToolsByCount: [],
			topToolsByDuration: [],
		},
		log: [],
		runningTools: Array.from({ length: runningToolCount }, (_, index) => ({ id: `tool-${index}`, name: "tool", startedAt: index, status: "running" })),
		trace: [],
		toolDurationMs: 0,
		mcpDurationMs: 0,
		skillDurationMs: 0,
	};
}
