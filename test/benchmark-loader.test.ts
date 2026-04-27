import { describe, expect, it } from "vitest";
import { loadBenchmarkSuite } from "../src/benchmark/loader.js";

describe("loadBenchmarkSuite", () => {
	it("loads a valid suite", () => {
		const suite = loadBenchmarkSuite({ id: "suite", name: "Suite", tasks: [validTask()] });
		expect(suite.tasks).toHaveLength(1);
	});

	it("rejects empty task lists", () => {
		expect(() => loadBenchmarkSuite({ id: "suite", name: "Suite", tasks: [] })).toThrow("tasks");
	});

	it("rejects invalid nested tasks", () => {
		expect(() => loadBenchmarkSuite({ id: "suite", name: "Suite", tasks: [{ ...validTask(), type: "invalid" }] })).toThrow("type");
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
