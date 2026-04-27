import type { AgentSpec } from "../specs.js";
import type { ScoreResult, TaskExecutionOutput, TaskGrader } from "./types.js";
import type { TaskSpec } from "../specs.js";

export class MinimalTaskGrader implements TaskGrader {
	async grade(_agent: AgentSpec, task: TaskSpec, output: TaskExecutionOutput): Promise<ScoreResult> {
		if (task.scoring.method === "exact") {
			return gradeExact(task, output.answer ?? "");
		}
		if (task.scoring.method === "rubric") {
			return gradeRubric(task, output.answer ?? "");
		}

		return {
			score: 0,
			maxScore: maxScore(task),
			passed: false,
			reason: `scoring method ${task.scoring.method} is not supported by MinimalTaskGrader`,
		};
	}
}

function gradeExact(task: TaskSpec, answer: string): ScoreResult {
	const config = task.scoring.config ?? {};
	const expected = config.expected;
	if (typeof expected !== "string") {
		return { score: 0, maxScore: maxScore(task), passed: false, reason: "exact scoring requires config.expected string" };
	}

	const trim = config.trim !== false;
	const caseSensitive = config.caseSensitive !== false;
	const actual = normalize(answer, trim, caseSensitive);
	const target = normalize(expected, trim, caseSensitive);
	const passed = actual === target;

	return {
		score: passed ? maxScore(task) : 0,
		maxScore: maxScore(task),
		passed,
		reason: passed ? "exact match" : `expected ${JSON.stringify(expected)} but got ${JSON.stringify(answer)}`,
	};
}

function gradeRubric(task: TaskSpec, answer: string): ScoreResult {
	const config = task.scoring.config ?? {};
	const contains = config.contains;
	if (!Array.isArray(contains) || contains.some((item) => typeof item !== "string")) {
		return { score: 0, maxScore: maxScore(task), passed: false, reason: "rubric scoring requires config.contains string array" };
	}

	const missing = contains.filter((item) => !answer.includes(item));
	const passed = missing.length === 0;
	return {
		score: passed ? maxScore(task) : 0,
		maxScore: maxScore(task),
		passed,
		reason: passed ? "rubric contains all required strings" : `missing required strings: ${missing.join(", ")}`,
		...(missing.length > 0 ? { details: { missing } } : {}),
	};
}

function normalize(value: string, trim: boolean, caseSensitive: boolean): string {
	const trimmed = trim ? value.trim() : value;
	return caseSensitive ? trimmed : trimmed.toLowerCase();
}

function maxScore(task: TaskSpec): number {
	return task.scoring.maxScore ?? 1;
}
