import { describe, expect, it } from "vitest";
import { createEvolutionReport, formatEvolutionReportMarkdown } from "../src/evolution/report.js";
import type { EvolutionComparison } from "../src/evolution/types.js";
import type { AgentSpec } from "../src/specs.js";
import type { SuiteRunResult } from "../src/benchmark/types.js";

const baselineAgent = agent("baseline", "Baseline", "baseline");
const candidateAgent = agent("candidate", "Candidate", "candidate");

const comparison: EvolutionComparison = {
	baseline: suiteRun(baselineAgent, [run("keep", "passed", 1), run("fix", "failed", 0)]),
	candidate: suiteRun(candidateAgent, [run("keep", "failed", 0), run("fix", "passed", 1)]),
	deltaScore: 0,
	deltaPassRate: 0,
	regressions: ["keep"],
	improvements: ["fix"],
	recommendation: "needs-review",
	metadata: { candidateId: "candidate" },
};

describe("evolution reports", () => {
	it("creates a stable JSON report DTO", () => {
		const report = createEvolutionReport(comparison, { generatedAt: "2026-01-01T00:00:00.000Z" });

		expect(report).toMatchObject({
			version: 1,
			generatedAt: "2026-01-01T00:00:00.000Z",
			suite: { id: "suite", name: "Suite", taskCount: 2 },
			baselineAgent: { id: "baseline", version: "1.0.0" },
			candidateAgent: { id: "candidate", version: "1.0.0" },
			summary: { regressions: ["keep"], improvements: ["fix"], recommendation: "needs-review" },
			verification: { verdict: "fail" },
		});
	});

	it("formats markdown reports", () => {
		const report = createEvolutionReport(comparison, { generatedAt: "2026-01-01T00:00:00.000Z" });
		const markdown = formatEvolutionReportMarkdown(report);

		expect(markdown).toContain("# Evolution Report: Suite");
		expect(markdown).toContain("Recommendation: `needs-review`");
		expect(markdown).toContain("Improvements: `fix`");
		expect(markdown).toContain("Regressions: `keep`");
		expect(markdown).toContain("| regression | blocking | keep |");
	});
});

function agent(id: string, name: string, kind: AgentSpec["kind"]): AgentSpec {
	return {
		id,
		version: "1.0.0",
		name,
		kind,
		model: { provider: "fake", model: "fake" },
		prompts: { system: "system" },
		tools: { allowedTools: [] },
		runtime: { maxTurns: 1 },
	};
}

function suiteRun(agentSpec: AgentSpec, runs: SuiteRunResult["runs"]): SuiteRunResult {
	return {
		agent: agentSpec,
		suite: { id: "suite", name: "Suite", tasks: runs.map((item) => item.task) },
		runs,
		summary: {
			totalTasks: 2,
			passedTasks: runs.filter((item) => item.status === "passed").length,
			failedTasks: runs.filter((item) => item.status === "failed").length,
			erroredTasks: 0,
			timeoutTasks: 0,
			interruptedTasks: 0,
			passRate: runs.filter((item) => item.status === "passed").length / 2,
			totalScore: runs.reduce((sum, item) => sum + item.score.score, 0),
			maxScore: 2,
			averageScore: runs.reduce((sum, item) => sum + item.score.score, 0) / 2,
			totalDurationMs: runs.reduce((sum, item) => sum + item.durationMs, 0),
			byTaskType: {},
		},
	};
}

function run(taskId: string, status: "passed" | "failed", score: number): SuiteRunResult["runs"][number] {
	return {
		runId: `run-${taskId}`,
		agent: undefined as never,
		task: { id: taskId, type: "general", title: taskId, prompt: taskId, scoring: { method: "exact" } },
		status,
		score: { score, maxScore: 1, passed: status === "passed", reason: status },
		startedAt: 0,
		endedAt: 1,
		durationMs: 1,
		trace: [],
	};
}
