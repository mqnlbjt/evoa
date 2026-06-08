import type { AgentSpec, TaskSpec } from "../../specs.js";
import type { ScoreResult, TaskGrader } from "../types.js";
import type { ExactScoringConfig } from "./types.js";

export class ExactGrader implements TaskGrader {
	async grade(_agent: AgentSpec, task: TaskSpec, output: { answer?: string }): Promise<ScoreResult> {
		const config = (task.scoring.config ?? {}) as unknown as ExactScoringConfig;
		const expected = config.expected;
		if (typeof expected !== "string") {
			return { score: 0, maxScore: maxScore(task), passed: false, reason: "exact scoring requires config.expected string" };
		}
		const answer = output.answer ?? "";
		const trim = config.trim !== false;
		const caseSensitive = config.caseSensitive !== false;
		const actual = normalize(answer, trim, caseSensitive);
		const target = normalize(expected, trim, caseSensitive);
		const passed = actual === target;
		return {
			score: passed ? maxScore(task) : 0, maxScore: maxScore(task), passed,
			reason: passed ? "exact match" : `expected ${JSON.stringify(expected)} but got ${JSON.stringify(answer)}`,
		};
	}
}

function normalize(value: string, trim: boolean, caseSensitive: boolean): string {
	const trimmed = trim ? value.trim() : value;
	return caseSensitive ? trimmed : trimmed.toLowerCase();
}

function maxScore(task: TaskSpec): number {
	return task.scoring.maxScore ?? 1;
}
