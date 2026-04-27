import type { SuiteRunResult } from "./types.js";

export interface LeaderboardEntry {
	rank: number;
	agentId: string;
	agentVersion: string;
	agentName: string;
	suiteId: string;
	passRate: number;
	totalScore: number;
	maxScore: number;
	averageScore: number;
	totalDurationMs: number;
}

export function createLeaderboard(results: SuiteRunResult[]): LeaderboardEntry[] {
	return results
		.map((result) => ({
			rank: 0,
			agentId: result.agent.id,
			agentVersion: result.agent.version,
			agentName: result.agent.name,
			suiteId: result.suite.id,
			passRate: result.summary.passRate,
			totalScore: result.summary.totalScore,
			maxScore: result.summary.maxScore,
			averageScore: result.summary.averageScore,
			totalDurationMs: result.summary.totalDurationMs,
		}))
		.sort((a, b) => {
			if (b.passRate !== a.passRate) return b.passRate - a.passRate;
			if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
			return a.totalDurationMs - b.totalDurationMs;
		})
		.map((entry, index) => ({ ...entry, rank: index + 1 }));
}
