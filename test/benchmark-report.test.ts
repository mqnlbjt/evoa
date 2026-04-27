import { describe, expect, it } from "vitest";
import { createBenchmarkReport, formatBenchmarkReportMarkdown } from "../src/benchmark/report.js";
import type { SuiteRunResult } from "../src/benchmark/types.js";

const result: SuiteRunResult = {
	suite: {
		id: "suite",
		name: "Smoke Suite",
		description: "Basic smoke checks",
		tasks: [
			{ id: "pass", type: "general", title: "Pass task", prompt: "pass", scoring: { method: "exact" } },
			{ id: "fail", type: "tool", title: "Fail task", prompt: "fail", scoring: { method: "exact" } },
		],
	},
	agent: {
		id: "agent",
		version: "1.0.0",
		name: "Agent",
		kind: "baseline",
		model: { provider: "fake", model: "fake" },
		prompts: { system: "system" },
		tools: { allowedTools: [], permissionMode: "allow" },
		runtime: { maxTurns: 1 },
	},
	runs: [
		{
			runId: "run-pass",
			agent: undefined as never,
			task: { id: "pass", type: "general", title: "Pass task", prompt: "pass", scoring: { method: "exact" } },
			status: "passed",
			score: { score: 1, maxScore: 1, passed: true, reason: "exact match" },
			startedAt: 0,
			endedAt: 5,
			durationMs: 5,
			trace: [{ id: "event-pass", type: "run_start", timestamp: 0, agentId: "agent", taskId: "pass", payload: {} }],
		},
		{
			runId: "run-fail",
			agent: undefined as never,
			task: { id: "fail", type: "tool", title: "Fail task", prompt: "fail", scoring: { method: "exact" } },
			status: "errored",
			score: { score: 0, maxScore: 1, passed: false, reason: "boom" },
			startedAt: 10,
			endedAt: 20,
			durationMs: 10,
			trace: [{ id: "event-fail", type: "error", timestamp: 11, agentId: "agent", taskId: "fail", payload: { message: "boom" } }],
			errorMessage: "boom",
		},
	],
	summary: {
		totalTasks: 2,
		passedTasks: 1,
		failedTasks: 0,
		erroredTasks: 1,
		timeoutTasks: 0,
		passRate: 0.5,
		totalScore: 1,
		maxScore: 2,
		averageScore: 0.5,
		totalDurationMs: 15,
		byTaskType: {
			general: { totalTasks: 1, passedTasks: 1, passRate: 1, totalScore: 1, maxScore: 1 },
			tool: { totalTasks: 1, passedTasks: 0, passRate: 0, totalScore: 0, maxScore: 1 },
		},
	},
};

describe("benchmark reports", () => {
	it("creates a stable JSON report DTO", () => {
		const report = createBenchmarkReport(result, { generatedAt: "2026-01-01T00:00:00.000Z" });

		expect(report).toMatchObject({
			version: 1,
			generatedAt: "2026-01-01T00:00:00.000Z",
			suite: { id: "suite", name: "Smoke Suite", taskCount: 2 },
			agent: { id: "agent", version: "1.0.0", name: "Agent", kind: "baseline" },
			summary: { totalTasks: 2, passedTasks: 1, passRate: 0.5 },
			tasks: [
				expect.objectContaining({ taskId: "pass", title: "Pass task", status: "passed", durationMs: 5 }),
				expect.objectContaining({ taskId: "fail", title: "Fail task", status: "errored", errorMessage: "boom" }),
			],
		});
		expect(report.tasks[0]).not.toHaveProperty("trace");
	});

	it("can include traces", () => {
		const report = createBenchmarkReport(result, { includeTrace: true });

		expect(report.tasks[0]?.trace).toEqual(result.runs[0]?.trace);
	});

	it("formats markdown reports", () => {
		const report = createBenchmarkReport(result, { generatedAt: "2026-01-01T00:00:00.000Z" });
		const markdown = formatBenchmarkReportMarkdown(report);

		expect(markdown).toContain("# Benchmark Report: Smoke Suite");
		expect(markdown).toContain("Pass rate: 50%");
		expect(markdown).toContain("| pass | general | passed | 1/1 | 5ms | exact match |");
		expect(markdown).toContain("## Errors");
		expect(markdown).toContain("`fail`: boom");
	});
});
