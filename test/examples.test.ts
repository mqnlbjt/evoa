import { describe, expect, it } from "vitest";
import { loadAgentDefinitionsFromFile } from "../src/agents/loader.js";
import { loadBenchmarkSuiteFromFile } from "../src/benchmark/loader.js";
import { loadDeterministicCandidateGeneratorFromFile } from "../src/evolution/deterministic-generator-loader.js";
import { loadTaskSpecFromFile } from "../src/tasks/loader.js";

describe("examples", () => {
	it("loads example agent, task, and suite", async () => {
		const bundle = await loadAgentDefinitionsFromFile("/home/wyq/data/pi/evolving-agent/examples/agents/basic.json");
		const task = await loadTaskSpecFromFile("/home/wyq/data/pi/evolving-agent/examples/tasks/smoke.json");
		const suite = await loadBenchmarkSuiteFromFile("/home/wyq/data/pi/evolving-agent/examples/suites/smoke.json");

		expect(bundle.agents[0]!.id).toBe("basic");
		expect(task.id).toBe("smoke-task");
		expect(suite.tasks).toHaveLength(1);
	});

	it("loads the deterministic candidate generator example", async () => {
		const bundle = await loadAgentDefinitionsFromFile("/home/wyq/data/pi/evolving-agent/examples/agents/basic.json");
		const generator = await loadDeterministicCandidateGeneratorFromFile("/home/wyq/data/pi/evolving-agent/examples/generators/deterministic-smoke.json");
		const candidates = await generator.generate(bundle.agents[0]!);

		expect(candidates).toHaveLength(2);
		expect(candidates[0]).toMatchObject({ id: "basic-candidate-exact-answer", parentAgentId: "basic", agent: { kind: "candidate" } });
		expect(candidates[1]?.agent.model.options).toMatchObject({ temperature: 0 });
	});
});
