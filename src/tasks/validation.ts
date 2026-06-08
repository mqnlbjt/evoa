import type { TaskScoringSpec, TaskSpec, TaskType } from "../specs.js";

const taskTypes = new Set<TaskType>(["coding", "tool", "general", "business"]);
const scoringMethods = new Set<TaskScoringSpec["method"]>(["exact", "rubric", "command", "custom", "llm-judge", "artifact"]);

export function validateTaskSpec(value: unknown): TaskSpec {
	if (!isRecord(value)) throw new Error("task spec must be an object");
	const task = value as Partial<TaskSpec>;

	requireString(task.id, "id");
	if (!taskTypes.has(task.type as TaskType)) throw new Error("type must be coding, tool, general, or business");
	requireString(task.title, "title");
	requireString(task.prompt, "prompt");
	validateScoring(task.scoring);
	if (task.allowedTools !== undefined) validateStringArray(task.allowedTools, "allowedTools");
	if (task.fixtures !== undefined) validateFixtures(task.fixtures);
	if (task.timeoutMs !== undefined && (!Number.isInteger(task.timeoutMs) || task.timeoutMs < 1)) {
		throw new Error("timeoutMs must be a positive integer");
	}
	if (task.expectedArtifacts !== undefined) validateStringArray(task.expectedArtifacts, "expectedArtifacts");
	if (task.metadata !== undefined && !isRecord(task.metadata)) throw new Error("metadata must be an object");

	return task as TaskSpec;
}

function validateScoring(value: unknown): asserts value is TaskScoringSpec {
	if (!isRecord(value)) throw new Error("scoring is required");
	if (!scoringMethods.has(value.method as TaskScoringSpec["method"])) {
		throw new Error("scoring.method must be exact, rubric, command, custom, llm-judge, or artifact");
	}
	if (value.maxScore !== undefined && (typeof value.maxScore !== "number" || value.maxScore <= 0)) {
		throw new Error("scoring.maxScore must be a positive number");
	}
	if (value.config !== undefined && !isRecord(value.config)) throw new Error("scoring.config must be an object");
	validateScoringConfig(value.method as TaskScoringSpec["method"], value.config);
}

function validateScoringConfig(method: TaskScoringSpec["method"], config: Record<string, unknown> | undefined): void {
	switch (method) {
		case "exact": {
			if (!config || typeof config.expected !== "string") throw new Error("exact scoring requires config.expected string");
			break;
		}
		case "rubric": {
			if (!config) throw new Error("rubric scoring requires config");
			const hasContains = Array.isArray(config.contains) && config.contains.every((item): item is string => typeof item === "string");
			const hasCriteria = Array.isArray(config.criteria) && config.criteria.length > 0 && config.criteria.every((c): c is Record<string, unknown> => isRecord(c) && typeof c.description === "string");
			if (!hasContains && !hasCriteria) throw new Error("rubric scoring requires config.contains (string array) or config.criteria (array of { description: string })");
			break;
		}
		case "llm-judge": {
			if (!config || typeof config.criteria !== "string" || config.criteria.trim().length === 0) throw new Error("llm-judge scoring requires config.criteria non-empty string");
			if (config.passThreshold !== undefined && (typeof config.passThreshold !== "number" || config.passThreshold < 0 || config.passThreshold > 1)) {
				throw new Error("scoring.config.passThreshold must be a number between 0 and 1");
			}
			if (config.modelAlias !== undefined && typeof config.modelAlias !== "string") throw new Error("scoring.config.modelAlias must be a string");
			break;
		}
		case "command": {
			if (!config || typeof config.command !== "string" || config.command.trim().length === 0) throw new Error("command scoring requires config.command non-empty string");
			if (config.exitCode !== undefined && (typeof config.exitCode !== "number" || !Number.isInteger(config.exitCode))) throw new Error("scoring.config.exitCode must be an integer");
			if (config.timeoutMs !== undefined && (typeof config.timeoutMs !== "number" || config.timeoutMs <= 0)) throw new Error("scoring.config.timeoutMs must be a positive number");
			break;
		}
		case "artifact": {
			if (!config || typeof config.path !== "string" || config.path.trim().length === 0) throw new Error("artifact scoring requires config.path non-empty string");
			break;
		}
	}
}

function validateFixtures(value: unknown): void {
	if (!Array.isArray(value)) throw new Error("fixtures must be an array");
	for (const fixture of value) {
		if (!isRecord(fixture)) throw new Error("fixtures[] must be an object");
		requireString(fixture.path, "fixtures[].path");
		requireString(fixture.content, "fixtures[].content");
	}
}

function validateStringArray(value: unknown, field: string): void {
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	for (const item of value) requireString(item, `${field}[]`);
}

function requireString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
