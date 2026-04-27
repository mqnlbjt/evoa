import { describe, expect, it } from "vitest";
import { BenchmarkRunner } from "../src/benchmark/runner.js";
import { BenchmarkEvolutionEngine } from "../src/evolution/engine.js";
import type { AgentRuntimeExecutor, TaskExecutionOutput, TaskGrader } from "../src/benchmark/types.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const baseline: AgentSpec = createAgent("baseline", "baseline");
const candidate = createAgent("candidate", "candidate");
const tasks: TaskSpec[] = [
	{ id: "a", type: "general", title: "A", prompt: "A", scoring: { method: "exact" } },
	{ id: "b", type: "general", title: "B", prompt: "B", scoring: { method: "exact" } },
];

class AnswerRuntime implements AgentRuntimeExecutor {
	constructor(private readonly answers: Record<string, Record<string, string>>) {}

	async runTask(agent: AgentSpec, task: TaskSpec): Promise<TaskExecutionOutput> {
		return { answer: this.answers[agent.id]?.[task.id] ?? "fail" };
	}
}

const grader: TaskGrader = {
	async grade(_agent, _task, output) {
		const passed = output.answer === "pass";
		return { score: passed ? 1 : 0, maxScore: 1, passed, reason: passed ? "pass" : "fail" };
	},
};

describe("BenchmarkEvolutionEngine", () => {
	it("accepts candidates that improve without regressions", async () => {
		const engine = new BenchmarkEvolutionEngine({
			baseline,
			suite: { id: "suite", name: "Suite", tasks },
			generator: { async generate() { return [{ id: "cand", kind: "prompt", parentAgentId: baseline.id, agent: candidate, description: "better" }]; } },
			createRunner: () =>
				new BenchmarkRunner({
					runtime: new AnswerRuntime({ baseline: { a: "pass", b: "fail" }, candidate: { a: "pass", b: "pass" } }),
					grader,
					createId: createIds(),
					now: () => 1,
				}),
		});

		const [generated] = await engine.generateCandidates();
		const comparison = await engine.compare(generated!);

		expect(comparison.deltaScore).toBe(1);
		expect(comparison.improvements).toEqual(["b"]);
		expect(comparison.regressions).toEqual([]);
		expect(comparison.recommendation).toBe("accept");
	});
});

function createAgent(id: string, kind: AgentSpec["kind"]): AgentSpec {
	return {
		id,
		version: "1.0.0",
		name: id,
		kind,
		model: { provider: "fake", model: "fake" },
		prompts: { system: "system" },
		tools: { allowedTools: [] },
		runtime: { maxTurns: 1 },
	};
}

function createIds(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}
