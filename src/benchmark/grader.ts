import type { ModelClient } from "../models/types.js";
import type { AgentSpec, TaskSpec } from "../specs.js";
import type { LlmJudgeConfig, RubricCriterion, ScoreResult, TaskExecutionOutput, TaskGrader, TaskGraderOptions } from "./types.js";

export class CompositeTaskGrader implements TaskGrader {
	private readonly modelClient: ModelClient | undefined;

	constructor(options: TaskGraderOptions = { modelClient: undefined }) {
		this.modelClient = options.modelClient;
	}

	async grade(_agent: AgentSpec, task: TaskSpec, output: TaskExecutionOutput): Promise<ScoreResult> {
		const answer = output.answer ?? "";
		switch (task.scoring.method) {
			case "exact": return gradeExact(task, answer);
			case "rubric": return gradeRubric(task, answer);
			case "llm-judge": return this.gradeLlmJudge(_agent, task, output);
			default: return unsupportedScore(task);
		}
	}

	private async gradeLlmJudge(agent: AgentSpec, task: TaskSpec, output: TaskExecutionOutput): Promise<ScoreResult> {
		if (!this.modelClient) {
			return { score: 0, maxScore: maxScore(task), passed: false, reason: "llm-judge requires a ModelClient; pass one via TaskGraderOptions" };
		}
		const config = (task.scoring.config ?? {}) as unknown as LlmJudgeConfig;
		const criteria = config.criteria ?? "";
		const passThreshold = typeof config.passThreshold === "number" ? config.passThreshold : 0.5;
		try {
			const request = buildJudgeRequest(agent, task, output, criteria, config.instructions);
			const response = await this.modelClient.complete(request);
			return parseJudgeResponse(response.text ?? "", maxScore(task), passThreshold);
		} catch (error) {
			return {
				score: 0, maxScore: maxScore(task), passed: false,
				reason: `llm-judge model error: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
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
		score: passed ? maxScore(task) : 0, maxScore: maxScore(task), passed,
		reason: passed ? "exact match" : `expected ${JSON.stringify(expected)} but got ${JSON.stringify(answer)}`,
	};
}

function gradeRubric(task: TaskSpec, answer: string): ScoreResult {
	const config = task.scoring.config ?? {};
	if (Array.isArray(config.contains) && config.contains.every((item): item is string => typeof item === "string")) {
		return gradeRubricContains(task, answer, config.contains);
	}
	if (Array.isArray(config.criteria) && config.criteria.length > 0) {
		return gradeRubricCriteria(task, answer, config.criteria as RubricCriterion[], config);
	}
	return { score: 0, maxScore: maxScore(task), passed: false, reason: "rubric requires config.contains (string[]) or config.criteria (RubricCriterion[])" };
}

function gradeRubricContains(task: TaskSpec, answer: string, contains: string[]): ScoreResult {
	const missing = contains.filter((item) => !answer.includes(item));
	const passed = missing.length === 0;
	return {
		score: passed ? maxScore(task) : 0, maxScore: maxScore(task), passed,
		reason: passed ? "rubric contains all required strings" : `missing required strings: ${missing.join(", ")}`,
		...(missing.length > 0 ? { details: { missing } } : {}),
	};
}

function gradeRubricCriteria(task: TaskSpec, answer: string, criteria: RubricCriterion[], config: Record<string, unknown>): ScoreResult {
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

function buildJudgeRequest(agent: AgentSpec, task: TaskSpec, output: TaskExecutionOutput, criteria: string, instructions?: string) {
	const systemPrompt = instructions ?? "You are an impartial evaluator. Grade the candidate answer against the criteria. Return only valid JSON.";
	const userPrompt = [
		"<task>", task.prompt, "</task>",
		"<criteria>", criteria, "</criteria>",
		"<answer>", output.answer ?? "", "</answer>",
		"Return JSON: {\"score\":<number>,\"maxScore\":<number>,\"passed\":<boolean>,\"reason\":\"<brief explanation>\"}",
	].join("\n");
	return {
		agent, task, messages: [
			{ role: "system" as const, content: systemPrompt },
			{ role: "user" as const, content: userPrompt },
		],
		turn: 0, purpose: "verification" as const,
	};
}

function parseJudgeResponse(text: string, maxScoreVal: number, passThreshold: number): ScoreResult {
	const json = extractJson(text);
	if (!json) {
		return { score: 0, maxScore: maxScoreVal, passed: false, reason: "llm-judge produced unparseable output", details: { rawResponse: text } };
	}
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		const score = typeof parsed.score === "number" ? parsed.score : 0;
		const parsedMax = typeof parsed.maxScore === "number" ? parsed.maxScore : maxScoreVal;
		const explicitPassed = typeof parsed.passed === "boolean" ? parsed.passed : undefined;
		const reason = typeof parsed.reason === "string" ? parsed.reason : "no reason provided";
		const passed = explicitPassed ?? (parsedMax > 0 ? score / parsedMax >= passThreshold : false);
		return { score, maxScore: parsedMax, passed, reason, details: { rawResponse: text } };
	} catch {
		return { score: 0, maxScore: maxScoreVal, passed: false, reason: "llm-judge JSON parse error", details: { rawResponse: text } };
	}
}

function extractJson(text: string): string | undefined {
	const stripped = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
	try { JSON.parse(stripped); return stripped; } catch { /* continue */ }
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start === -1 || end === -1 || start >= end) return undefined;
	return stripped.slice(start, end + 1);
}

function normalize(value: string, trim: boolean, caseSensitive: boolean): string {
	const trimmed = trim ? value.trim() : value;
	return caseSensitive ? trimmed : trimmed.toLowerCase();
}

function maxScore(task: TaskSpec): number {
	return task.scoring.maxScore ?? 1;
}

function unsupportedScore(task: TaskSpec): ScoreResult {
	return {
		score: 0, maxScore: maxScore(task), passed: false,
		reason: `scoring method ${task.scoring.method} is not yet supported`,
	};
}

export const MinimalTaskGrader = CompositeTaskGrader;
