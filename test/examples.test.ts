import { describe, expect, it } from "vitest";
import { loadAgentSpecFromFile } from "../src/agents/loader.js";
import { loadBenchmarkSuiteFromFile } from "../src/benchmark/loader.js";
import { loadTaskSpecFromFile } from "../src/tasks/loader.js";

describe("examples", () => {
	it("loads example agent, task, and suite", async () => {
		const agent = await loadAgentSpecFromFile("/home/wyq/data/pi/evolving-agent/examples/agents/basic.json");
		const task = await loadTaskSpecFromFile("/home/wyq/data/pi/evolving-agent/examples/tasks/smoke.json");
		const suite = await loadBenchmarkSuiteFromFile("/home/wyq/data/pi/evolving-agent/examples/suites/smoke.json");

		expect(agent.id).toBe("basic");
		expect(task.id).toBe("smoke-task");
		expect(suite.tasks).toHaveLength(1);
	});
});
