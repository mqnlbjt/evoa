import type { AgentSpec, TaskSpec } from "../../specs.js";
import type { RubricCriterion, ScoreResult, TaskGrader } from "../types.js";
import type { RubricScoringConfig } from "./types.js";

export class RubricGrader implements TaskGrader {
	async grade(_agent: AgentSpec, task: TaskSpec, output: { answer?: string }): Promise<ScoreResult> {
		const config = (task.scoring.config ?? {}) as unknown as RubricScoringConfig;
		const answer = output.answer ?? "";
		if (Array.isArray(config.contains) && config.contains.every((item): item is string => typeof item === "string")) {
			return gradeContains(task, answer, config.contains);
		}
		if (Array.isArray(config.criteria) && config.criteria.length > 0) {
			return gradeCriteria(task, answer, config.criteria, config);
		}
		return { score: 0, maxScore: maxScore(task), passed: false, reason: "rubric requires config.contains (string[]) or config.criteria (RubricCriterion[])" };
	}
}

function gradeContains(task: TaskSpec, answer: string, contains: string[]): ScoreResult {
	const missing = contains.filter((item) => !answer.includes(item));
	const passed = missing.length === 0;
	return {
		score: passed ? maxScore(task) : 0, maxScore: maxScore(task), passed,
		reason: passed ? "rubric contains all required strings" : `missing required strings: ${missing.join(", ")}`,
		...(missing.length > 0 ? { details: { missing } } : {}),
	};
}

function gradeCriteria(task: TaskSpec, answer: string, criteria: RubricCriterion[], config: RubricScoringConfig): ScoreResult {
	const passThreshold = typeof config.passThreshold === "number" ? config.passThreshold : 0.5;
	const results = criteria.map((criterion) => {
		const weight = typeof criterion.weight === "number" ? criterion.weight : 1;
		const matched = answer.includes(criterion.description);
		return { description: criterion.description, weight, required: criterion.required === true, matched };
	});
	const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
	const earnedWeight = results.filter((r) => r.matched).reduce((sum, r) => sum + r.weight, 0);
	const requiredOk = results.filter((r) => r.required && !r.matched).length === 0;
	const ratio = totalWeight > 0 ? earnedWeight / totalWeight : 1;
	const passed = ratio >= passThreshold && requiredOk;
	const max = maxScore(task);
	return {
		score: Math.round(ratio * max * 100) / 100, maxScore: max, passed,
		reason: passed ? `rubric criteria: ${earnedWeight}/${totalWeight} weight matched` : `rubric criteria: ${earnedWeight}/${totalWeight} weight matched (threshold ${passThreshold})`,
		details: { criteria: results, passThreshold, earnedWeight, totalWeight },
	};
}

function maxScore(task: TaskSpec): number {
	return task.scoring.maxScore ?? 1;
}
