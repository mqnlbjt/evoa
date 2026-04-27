import type { BenchmarkSuite } from "./types.js";
import { validateTaskSpec } from "../tasks/validation.js";

export function validateBenchmarkSuite(value: unknown): BenchmarkSuite {
	if (!isRecord(value)) throw new Error("benchmark suite must be an object");
	const suite = value as Partial<BenchmarkSuite>;

	requireString(suite.id, "id");
	requireString(suite.name, "name");
	if (suite.description !== undefined && typeof suite.description !== "string") throw new Error("description must be a string");
	if (!Array.isArray(suite.tasks) || suite.tasks.length === 0) throw new Error("tasks must be a non-empty array");
	const tasks = suite.tasks.map(validateTaskSpec);
	if (suite.metadata !== undefined && !isRecord(suite.metadata)) throw new Error("metadata must be an object");

	return {
		id: suite.id,
		name: suite.name,
		...(suite.description !== undefined ? { description: suite.description } : {}),
		tasks,
		...(suite.metadata ? { metadata: suite.metadata } : {}),
	};
}

function requireString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
