import type { AgentSpec, TaskSpec } from "../../specs.js";
import type { ScoreResult, TaskExecutionOutput, TaskGrader } from "../types.js";
import type { CustomScoringConfig, GraderContext } from "./types.js";
import type { GraderRegistry } from "./registry.js";

export class CompositeGrader implements TaskGrader {
	constructor(
		private readonly registry: GraderRegistry,
		private readonly context: GraderContext,
	) {}

	async grade(agent: AgentSpec, task: TaskSpec, output: TaskExecutionOutput): Promise<ScoreResult> {
		const config = (task.scoring.config ?? {}) as unknown as CustomScoringConfig;
		if (!Array.isArray(config.subscores) || config.subscores.length === 0) {
			return { score: 0, maxScore: maxScore(task), passed: false, reason: "custom scoring requires config.subscores non-empty array" };
		}

		const passThreshold = typeof config.passThreshold === "number" ? config.passThreshold : 0.6;
		const results: Array<{ method: string; weight: number; score: number; maxScore: number; passed: boolean }> = [];
		let totalWeight = 0;
		let earnedWeight = 0;

		for (const sub of config.subscores) {
			const grader = this.registry.create(sub.method, this.context);
			const subTask: TaskSpec = { ...task, scoring: { method: sub.method as TaskSpec["scoring"]["method"], maxScore: 1, config: sub.config } };
			const result = await grader.grade(agent, subTask, output);
			results.push({ method: sub.method, weight: sub.weight, score: result.score, maxScore: result.maxScore, passed: result.passed });
			totalWeight += sub.weight;
			earnedWeight += result.passed ? sub.weight : 0;
		}

		const ratio = totalWeight > 0 ? earnedWeight / totalWeight : 0;
		const passed = ratio >= passThreshold;
		const max = maxScore(task);

		return {
			score: Math.round(ratio * max * 100) / 100,
			maxScore: max,
			passed,
			reason: passed ? `custom composite: ${earnedWeight}/${totalWeight} weight passed` : `custom composite: ${earnedWeight}/${totalWeight} weight passed (threshold ${passThreshold})`,
			details: { subscores: results, passThreshold, totalWeight, earnedWeight },
		};
	}
}

function maxScore(task: TaskSpec): number {
	return task.scoring.maxScore ?? 1;
}
