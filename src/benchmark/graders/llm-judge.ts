import type { AgentSpec, TaskSpec } from "../../specs.js";
import type { ScoreResult, TaskExecutionOutput, TaskGrader } from "../types.js";
import type { GraderContext, LlmJudgeScoringConfig } from "./types.js";

export class LlmJudgeGrader implements TaskGrader {
	constructor(private readonly context: GraderContext) {}

	async grade(agent: AgentSpec, task: TaskSpec, output: TaskExecutionOutput): Promise<ScoreResult> {
		if (!this.context.modelClient) {
			return { score: 0, maxScore: maxScore(task), passed: false, reason: "llm-judge requires a ModelClient; pass one via GraderContext" };
		}
		const config = (task.scoring.config ?? {}) as unknown as LlmJudgeScoringConfig;
		const criteria = config.criteria ?? "";
		const passThreshold = typeof config.passThreshold === "number" ? config.passThreshold : 0.5;
		try {
			const request = buildJudgeRequest(agent, task, output, criteria, config.instructions);
			const response = await this.context.modelClient.complete(request);
			return parseJudgeResponse(response.text ?? "", maxScore(task), passThreshold);
		} catch (error) {
			return {
				score: 0, maxScore: maxScore(task), passed: false,
				reason: `llm-judge model error: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
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

function maxScore(task: TaskSpec): number {
	return task.scoring.maxScore ?? 1;
}
