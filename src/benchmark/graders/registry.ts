import type { TaskGrader } from "../types.js";
import type { GraderContext } from "./types.js";
import { ExactGrader } from "./exact.js";
import { RubricGrader } from "./rubric.js";
import { LlmJudgeGrader } from "./llm-judge.js";
import { CommandGrader } from "./command.js";
import { ArtifactGrader } from "./artifact.js";

import { CompositeGrader } from "./composite.js";

export type GraderFactory = (context: GraderContext) => TaskGrader;

export class GraderRegistry {
	private readonly factories = new Map<string, GraderFactory>();

	register(method: string, factory: GraderFactory): void {
		this.factories.set(method, factory);
	}

	create(method: string, context: GraderContext): TaskGrader {
		const factory = this.factories.get(method);
		if (!factory) throw new Error(`Unknown grader method: ${method}`);
		return factory(context);
	}

	has(method: string): boolean {
		return this.factories.has(method);
	}
}

export function createDefaultRegistry(): GraderRegistry {
	const registry = new GraderRegistry();
	registry.register("exact", () => new ExactGrader());
	registry.register("rubric", () => new RubricGrader());
	registry.register("llm-judge", (ctx) => new LlmJudgeGrader(ctx));
	registry.register("command", (ctx) => new CommandGrader(ctx));
	registry.register("artifact", (ctx) => new ArtifactGrader(ctx));
	registry.register("custom", (ctx) => new CompositeGrader(registry, ctx));
	return registry;
}
