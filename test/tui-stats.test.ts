import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../src/runtime/events.js";
import { TuiStatsAccumulator, latencySummary } from "../src/tui/stats.js";

describe("TuiStatsAccumulator", () => {
	it("aggregates run model token latency and score metrics", () => {
		const stats = new TuiStatsAccumulator();
		stats.apply(event("run_start", {}, 10));
		stats.apply(event("model_request", { turn: 2 }, 20));
		stats.apply(event("assistant_delta", { delta: "h" }, 25));
		stats.apply(event("model_response", {
			text: "hello",
			requestId: "req-1",
			timing: { startedAt: 20, endedAt: 70, durationMs: 50 },
			usage: { inputTokens: 100, outputTokens: 25, reasoningTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3, totalTokens: 125, costUsd: 0.01 },
			metadata: { stopReason: "end_turn" },
		}, 70));
		stats.apply(event("score", { score: 8, maxScore: 10, passed: true }, 80));
		stats.apply(event("run_end", { status: "passed", durationMs: 100 }, 110));

		const snapshot = stats.snapshot(120);
		expect(snapshot.overview).toMatchObject({ eventCount: 6, turnCount: 2 });
		expect(snapshot.runs).toMatchObject({ count: 1, passed: 1, totalDurationMs: 100, avgDurationMs: 100 });
		expect(snapshot.model).toMatchObject({ requestCount: 1, responseCount: 1, assistantDeltaCount: 1, ttftMs: 5, recentRequestId: "req-1", recentStopReason: "end_turn" });
		expect(snapshot.model.tokens).toMatchObject({ inputTokens: 100, outputTokens: 25, reasoningTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3, totalTokens: 125, costUsd: 0.01 });
		expect(snapshot.model.latency).toMatchObject({ count: 1, totalMs: 50, avgMs: 50, p50Ms: 50 });
		expect(snapshot.model.outputTokensPerSecond).toBe(500);
		expect(snapshot.scores).toMatchObject({ count: 1, passed: 1, avgRatio: 0.8, latestRatio: 0.8 });
	});

	it("parses legacy provider usage from metadata", () => {
		const stats = new TuiStatsAccumulator();
		stats.apply(event("model_request", { turn: 1 }, 1));
		stats.apply(event("model_response", { metadata: { usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }, requestId: "legacy" } }, 6));
		stats.apply(event("model_response", { metadata: { usage: { prompt_tokens: 5, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 }, prompt_tokens_details: { cached_tokens: 1 } } } }, 9));

		const tokens = stats.snapshot().model.tokens;
		expect(tokens).toMatchObject({ inputTokens: 14, outputTokens: 7, reasoningTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 21 });
	});

	it("aggregates tool statuses categories top tools and sizes", () => {
		const stats = new TuiStatsAccumulator();
		stats.apply(event("tool_call", { call: { id: "read-1", name: "read_file", input: { path: "a" } } }));
		stats.apply(event("tool_result", { call: { id: "read-1", name: "read_file", input: { path: "a" } }, decision: { decision: "allow" }, status: "success", output: { text: "ok" }, durationMs: 10 }));
		stats.apply(event("tool_result", { call: { id: "mcp-1", name: "mcp__context7__query-docs" }, decision: { decision: "allow" }, status: "timeout", errorMessage: "slow", durationMs: 20 }));
		stats.apply(event("tool_result", { call: { id: "mem-1", name: "memory_read" }, decision: { decision: "allow" }, status: "denied", errorMessage: "blocked", durationMs: 5 }));

		const snapshot = stats.snapshot();
		expect(snapshot.tools).toMatchObject({ callCount: 1, resultCount: 3, totalDurationMs: 35, avgDurationMs: 35 / 3, maxDurationMs: 20, mcpCount: 1, mcpDurationMs: 20 });
		expect(snapshot.tools.statuses).toMatchObject({ success: 1, denied: 1, timeout: 1 });
		expect(snapshot.tools.memory.memory_read).toBe(1);
		expect(snapshot.topToolsByDuration.map((tool) => tool.name)).toEqual(["mcp__context7__query-docs", "read_file", "memory_read"]);
		expect(snapshot.topToolsByCount[0]).toMatchObject({ count: 1 });
		expect(snapshot.topToolsByCount.find((tool) => tool.name === "read_file")?.inputBytes).toBeGreaterThan(0);
	});

	it("keeps cumulative stats independent from retained trace length", () => {
		const stats = new TuiStatsAccumulator();
		for (let index = 0; index < 10; index += 1) {
			stats.apply(event("tool_result", { call: { id: `call-${index}`, name: "read_file" }, decision: { decision: "allow" }, status: "success", durationMs: 1 }));
		}
		expect(stats.snapshot().tools.resultCount).toBe(10);
		expect(stats.snapshot().topToolsByCount[0]).toMatchObject({ name: "read_file", count: 10, totalDurationMs: 10 });
	});

	it("summarizes latency percentiles", () => {
		expect(latencySummary([30, 10, 20, 40])).toMatchObject({ count: 4, totalMs: 100, avgMs: 25, minMs: 10, maxMs: 40, p50Ms: 20, p95Ms: 40, p99Ms: 40 });
	});
});

function event(type: TraceEvent["type"], payload: unknown, timestamp = 1): TraceEvent {
	return { id: `${type}-${timestamp}`, type, timestamp, agentId: "agent", taskId: "task", sessionId: "session", payload } as TraceEvent;
}
