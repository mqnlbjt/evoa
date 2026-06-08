import type { AgentSpec } from "../specs.js";
import type { AgentTaskRunResult, BenchmarkSuite, SuiteRunResult } from "./types.js";
import type { BenchmarkRunner } from "./runner.js";

export interface RunStatistics {
	taskResults: Map<string, {
		runs: AgentTaskRunResult[];
		mean: number;
		stddev: number;
		min: number;
		max: number;
		flaky: boolean;
	}>;
}

export interface SuiteRunWithStatsOptions {
	repeatCount?: number;
}

export async function runSuiteWithStats(
	runner: BenchmarkRunner,
	agent: AgentSpec,
	suite: BenchmarkSuite,
	options: SuiteRunWithStatsOptions = {},
): Promise<{ result: SuiteRunResult; stats: RunStatistics }> {
	const repeatCount = options.repeatCount ?? 1;

	const allRuns: AgentTaskRunResult[] = [];
	for (let i = 0; i < repeatCount; i++) {
		const result = await runner.runSuite(agent, suite);
		allRuns.push(...result.runs);
	}

	const taskResults = new Map<string, { runs: AgentTaskRunResult[]; mean: number; stddev: number; min: number; max: number; flaky: boolean }>();
	for (const task of suite.tasks) {
		const taskRuns = allRuns.filter(r => r.task.id === task.id);
		if (taskRuns.length === 0) continue;

		const scores = taskRuns.map(r => r.score.score);
		const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
		const variance = scores.length > 1
			? scores.reduce((s, v) => s + (v - mean) ** 2, 0) / (scores.length - 1)
			: 0;
		const stddev = Math.sqrt(variance);
		const min = Math.min(...scores);
		const max = Math.max(...scores);
		const flaky = scores.length >= 2 && stddev > 0.3;

		taskResults.set(task.id, { runs: taskRuns, mean, stddev, min, max, flaky });
	}

	const result: SuiteRunResult = {
		agent,
		suite,
		runs: allRuns,
		summary: {
			totalTasks: suite.tasks.length * repeatCount,
			passedTasks: allRuns.filter(r => r.status === "passed").length,
			failedTasks: allRuns.filter(r => r.status === "failed").length,
			erroredTasks: allRuns.filter(r => r.status === "errored").length,
			timeoutTasks: allRuns.filter(r => r.status === "timeout").length,
			interruptedTasks: allRuns.filter(r => r.status === "interrupted").length,
			passRate: allRuns.length === 0 ? 0 : allRuns.filter(r => r.status === "passed").length / allRuns.length,
			totalScore: allRuns.reduce((s, r) => s + r.score.score, 0),
			maxScore: allRuns.reduce((s, r) => s + r.score.maxScore, 0),
			averageScore: allRuns.length === 0 ? 0 : allRuns.reduce((s, r) => s + r.score.score, 0) / allRuns.length,
			totalDurationMs: allRuns.reduce((s, r) => s + r.durationMs, 0),
			byTaskType: {},
		},
	};

	return { result, stats: { taskResults } };
}
