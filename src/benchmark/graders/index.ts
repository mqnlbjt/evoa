import type { AgentSpec, TaskSpec } from "../../specs.js";
import type { ScoreResult, TaskExecutionOutput, TaskGrader } from "../types.js";
import type { GraderContext } from "./types.js";
import { createDefaultRegistry, type GraderFactory, type GraderRegistry } from "./registry.js";
import type { TaskGraderOptions } from "../types.js";

export type { GraderFactory, GraderRegistry };
export { createDefaultRegistry };

export class CompositeTaskGrader implements TaskGrader {
	private readonly registry: GraderRegistry;
	private readonly context: GraderContext;

	constructor(options: TaskGraderOptions = { modelClient: undefined }) {
		this.registry = createDefaultRegistry();
		this.context = options.modelClient ? { modelClient: options.modelClient } : {};
	}

	async grade(agent: AgentSpec, task: TaskSpec, output: TaskExecutionOutput): Promise<ScoreResult> {
		const method = task.scoring.method;
		if (!this.registry.has(method)) {
			return {
				score: 0, maxScore: task.scoring.maxScore ?? 1, passed: false,
				reason: `scoring method ${task.scoring.method} is not yet supported`,
			};
		}
		const grader = this.registry.create(method, this.context);
		return grader.grade(agent, task, output);
	}
}

export const MinimalTaskGrader = CompositeTaskGrader;

export { ExactGrader } from "./exact.js";
export { RubricGrader } from "./rubric.js";
export { LlmJudgeGrader } from "./llm-judge.js";
export { CommandGrader } from "./command.js";
export { ArtifactGrader } from "./artifact.js";
export { CompositeGrader } from "./composite.js";
export * from "./types.js";
