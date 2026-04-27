import { describe, expect, it } from "vitest";
import { loadTaskSpec } from "../src/tasks/loader.js";

describe("loadTaskSpec", () => {
	it("loads a valid task", () => {
		expect(loadTaskSpec(validTask())).toMatchObject({ id: "task", type: "general" });
	});

	it("rejects missing id", () => {
		const task = validTask();
		delete task.id;
		expect(() => loadTaskSpec(task)).toThrow("id");
	});

	it("rejects invalid task type", () => {
		expect(() => loadTaskSpec({ ...validTask(), type: "invalid" })).toThrow("type");
	});

	it("rejects invalid scoring method", () => {
		expect(() => loadTaskSpec({ ...validTask(), scoring: { method: "invalid" } })).toThrow("scoring.method");
	});
});

function validTask(): Record<string, unknown> {
	return {
		id: "task",
		type: "general",
		title: "Task",
		prompt: "Say pong",
		scoring: { method: "exact", config: { expected: "pong" } },
	};
}
