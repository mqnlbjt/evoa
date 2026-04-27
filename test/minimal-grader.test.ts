import { describe, expect, it } from "vitest";
import { MinimalTaskGrader } from "../src/benchmark/grader.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "local", model: "model" },
	prompts: { system: "Test" },
	tools: { allowedTools: [] },
	runtime: { maxTurns: 1 },
};

describe("MinimalTaskGrader", () => {
	it("passes exact matches with trimming", async () => {
		const score = await new MinimalTaskGrader().grade(agent, exactTask({ expected: "pong" }), { answer: " pong\n" });
		expect(score).toMatchObject({ score: 1, maxScore: 1, passed: true, reason: "exact match" });
	});

	it("fails exact mismatches", async () => {
		const score = await new MinimalTaskGrader().grade(agent, exactTask({ expected: "pong" }), { answer: "hello" });
		expect(score).toMatchObject({ score: 0, passed: false });
	});

	it("respects case sensitivity", async () => {
		const score = await new MinimalTaskGrader().grade(agent, exactTask({ expected: "PONG", caseSensitive: false }), { answer: "pong" });
		expect(score.passed).toBe(true);
	});

	it("grades rubric contains", async () => {
		const pass = await new MinimalTaskGrader().grade(agent, rubricTask(["foo", "bar"]), { answer: "foo and bar" });
		const fail = await new MinimalTaskGrader().grade(agent, rubricTask(["foo", "bar"]), { answer: "foo" });
		expect(pass.passed).toBe(true);
		expect(fail).toMatchObject({ passed: false, details: { missing: ["bar"] } });
	});

	it("fails unsupported scoring methods deterministically", async () => {
		const score = await new MinimalTaskGrader().grade(agent, { ...exactTask({ expected: "pong" }), scoring: { method: "command" } }, { answer: "pong" });
		expect(score).toMatchObject({ score: 0, passed: false });
		expect(score.reason).toContain("not supported");
	});
});

function exactTask(config: Record<string, unknown>): TaskSpec {
	return {
		id: "task",
		type: "general",
		title: "Task",
		prompt: "Say pong",
		scoring: { method: "exact", maxScore: 1, config },
	};
}

function rubricTask(contains: string[]): TaskSpec {
	return {
		id: "task",
		type: "general",
		title: "Task",
		prompt: "Say foo and bar",
		scoring: { method: "rubric", maxScore: 1, config: { contains } },
	};
}
