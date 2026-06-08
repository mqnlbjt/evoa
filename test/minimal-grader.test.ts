import { describe, expect, it } from "vitest";
import { CompositeTaskGrader } from "../src/benchmark/grader.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/models/types.js";
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

describe("CompositeTaskGrader", () => {
	describe("exact", () => {
		it("passes exact matches with trimming", async () => {
			const score = await new CompositeTaskGrader().grade(agent, exactTask({ expected: "pong" }), { answer: " pong\n" });
			expect(score).toMatchObject({ score: 1, maxScore: 1, passed: true, reason: "exact match" });
		});

		it("fails exact mismatches", async () => {
			const score = await new CompositeTaskGrader().grade(agent, exactTask({ expected: "pong" }), { answer: "hello" });
			expect(score).toMatchObject({ score: 0, passed: false });
		});

		it("respects case sensitivity", async () => {
			const score = await new CompositeTaskGrader().grade(agent, exactTask({ expected: "PONG", caseSensitive: false }), { answer: "pong" });
			expect(score.passed).toBe(true);
		});
	});

	describe("rubric", () => {
		it("passes contains when all required strings present", async () => {
			const pass = await new CompositeTaskGrader().grade(agent, rubricContainsTask(["foo", "bar"]), { answer: "foo and bar" });
			expect(pass.passed).toBe(true);
			expect(pass.score).toBe(1);
		});

		it("fails contains when strings are missing", async () => {
			const fail = await new CompositeTaskGrader().grade(agent, rubricContainsTask(["foo", "bar"]), { answer: "foo" });
			expect(fail).toMatchObject({ passed: false, details: { missing: ["bar"] } });
		});

		it("passes criteria with all matched", async () => {
			const task = rubricCriteriaTask([{ description: "First Law" }, { description: "Asimov" }], { passThreshold: 0.5, maxScore: 2 });
			const score = await new CompositeTaskGrader().grade(agent, task, { answer: "First Law: robots must not harm humans. Created by Asimov." });
			expect(score.passed).toBe(true);
			expect(score.score).toBe(2);
		});

		it("scores criteria proportionally with partial match", async () => {
			const task = rubricCriteriaTask([{ description: "First Law" }, { description: "Second Law" }], { passThreshold: 0.5, maxScore: 2 });
			const score = await new CompositeTaskGrader().grade(agent, task, { answer: "First Law: robots must not harm humans." });
			expect(score.score).toBe(1);
			expect(score.maxScore).toBe(2);
			expect(score.passed).toBe(true);
			expect(score.details).toMatchObject({ earnedWeight: 1, totalWeight: 2 });
		});

		it("fails when required criterion is missing", async () => {
			const task = rubricCriteriaTask([{ description: "First Law" }, { description: "Asimov", required: true }], { passThreshold: 0.5 });
			const score = await new CompositeTaskGrader().grade(agent, task, { answer: "First Law: robots must not harm humans." });
			expect(score.passed).toBe(false);
		});

		it("respects custom weights", async () => {
			const task = rubricCriteriaTask([{ description: "First Law", weight: 1 }, { description: "Asimov", weight: 3 }], { maxScore: 8, passThreshold: 0.5 });
			const score = await new CompositeTaskGrader().grade(agent, task, { answer: "First Law and Asimov" });
			expect(score.score).toBe(8);
			expect(score.maxScore).toBe(8);
		});

		it("respects passThreshold for criteria", async () => {
			const task = rubricCriteriaTask([{ description: "First Law" }, { description: "Second Law" }, { description: "Third Law" }], { passThreshold: 0.8 });
			const score = await new CompositeTaskGrader().grade(agent, task, { answer: "First Law: robots must not harm humans." });
			expect(score.passed).toBe(false);
		});

		it("fails with invalid rubric config", async () => {
			const task = { ...rubricContainsTask(["x"]), scoring: { method: "rubric" as const, config: {} } };
			const score = await new CompositeTaskGrader().grade(agent, task, { answer: "anything" });
			expect(score.passed).toBe(false);
			expect(score.reason).toContain("rubric requires");
		});
	});

	describe("llm-judge", () => {
		it("returns error when no ModelClient is provided", async () => {
			const task = llmJudgeTask("correctness");
			const score = await new CompositeTaskGrader().grade(agent, task, { answer: "pong" });
			expect(score).toMatchObject({ score: 0, passed: false });
			expect(score.reason).toContain("ModelClient");
		});

		it("parses valid LLM judge JSON response", async () => {
			const grader = new CompositeTaskGrader({ modelClient: fakeModelClient({ score: 8, maxScore: 10, passed: true, reason: "mostly correct" }) });
			const score = await grader.grade(agent, llmJudgeTask("correctness", { maxScore: 10 }), { answer: "pong" });
			expect(score).toMatchObject({ score: 8, maxScore: 10, passed: true, reason: "mostly correct" });
			expect(score.details).toHaveProperty("rawResponse");
		});

		it("strips markdown fences from LLM response", async () => {
			const grader = new CompositeTaskGrader({ modelClient: fakeModelClient("```json\n{\"score\":5,\"maxScore\":5,\"passed\":true,\"reason\":\"ok\"}\n```") });
			const score = await grader.grade(agent, llmJudgeTask("correctness", { maxScore: 5 }), { answer: "pong" });
			expect(score).toMatchObject({ score: 5, passed: true });
		});

		it("handles malformed JSON gracefully", async () => {
			const grader = new CompositeTaskGrader({ modelClient: fakeModelClient("not valid json at all") });
			const score = await grader.grade(agent, llmJudgeTask("correctness"), { answer: "pong" });
			expect(score).toMatchObject({ score: 0, passed: false });
			expect(score.details).toHaveProperty("rawResponse", "not valid json at all");
		});

		it("extracts JSON from surrounding text", async () => {
			const grader = new CompositeTaskGrader({ modelClient: fakeModelClient("Here is my evaluation: {\"score\":3,\"maxScore\":5,\"passed\":true,\"reason\":\"ok\"} end.") });
			const score = await grader.grade(agent, llmJudgeTask("correctness", { maxScore: 5 }), { answer: "pong" });
			expect(score).toMatchObject({ score: 3, maxScore: 5, passed: true });
		});

		it("uses implicit pass/fail from threshold when passed field missing", async () => {
			const grader = new CompositeTaskGrader({ modelClient: fakeModelClient({ score: 3, maxScore: 10, reason: "partial" }) });
			const score = await grader.grade(agent, llmJudgeTask("correctness", { maxScore: 10, passThreshold: 0.5 }), { answer: "pong" });
			expect(score.passed).toBe(false);
		});

		it("respects custom passThreshold from task config", async () => {
			const grader = new CompositeTaskGrader({ modelClient: fakeModelClient({ score: 4, maxScore: 10, reason: "low score" }) });
			const score = await grader.grade(agent, llmJudgeTask("correctness", { maxScore: 10, passThreshold: 0.3 }), { answer: "pong" });
			expect(score.passed).toBe(true);
		});

		it("catches ModelClient errors", async () => {
			const grader = new CompositeTaskGrader({ modelClient: failingModelClient("network error") });
			const score = await grader.grade(agent, llmJudgeTask("correctness"), { answer: "pong" });
			expect(score).toMatchObject({ score: 0, passed: false });
			expect(score.reason).toContain("network error");
		});

		it("passes verification purpose to model request", async () => {
			let seenPurpose: string | undefined;
			const grader = new CompositeTaskGrader({
				modelClient: {
					async complete(request: ModelRequest) {
						seenPurpose = request.purpose;
						return { text: JSON.stringify({ score: 5, maxScore: 5, passed: true, reason: "ok" }) };
					},
				},
			});
			await grader.grade(agent, llmJudgeTask("correctness", { maxScore: 5 }), { answer: "pong" });
			expect(seenPurpose).toBe("verification");
		});
	});

	describe("dispatch", () => {
		it("routes by scoring method correctly", async () => {
			const exact = await new CompositeTaskGrader().grade(agent, exactTask({ expected: "pong" }), { answer: "pong" });
			expect(exact.passed).toBe(true);

			const rubric = await new CompositeTaskGrader().grade(agent, rubricContainsTask(["pong"]), { answer: "pong" });
			expect(rubric.passed).toBe(true);

			const unsupported = await new CompositeTaskGrader().grade(agent, { ...exactTask({ expected: "x" }), scoring: { method: "nonexistent" as never } }, { answer: "x" });
			expect(unsupported.passed).toBe(false);
			expect(unsupported.reason).toContain("not yet supported");
		});

		it("returns error for command grader without command config", async () => {
			const result = await new CompositeTaskGrader().grade(agent, { ...exactTask({ expected: "x" }), scoring: { method: "command" } as never }, { answer: "x" });
			expect(result.passed).toBe(false);
			expect(result.reason).toContain("command grader requires config.command");
		});
	});
});

function fakeModelClient(response: unknown): ModelClient {
	return {
		async complete(_request: ModelRequest): Promise<ModelResponse> {
			const text = typeof response === "string" ? response : JSON.stringify(response);
			return { text };
		},
	};
}

function failingModelClient(message: string): ModelClient {
	return {
		async complete(_request: ModelRequest): Promise<ModelResponse> {
			throw new Error(message);
		},
	};
}

function exactTask(config: Record<string, unknown>): TaskSpec {
	return {
		id: "task", type: "general", title: "Task", prompt: "Say pong",
		scoring: { method: "exact", maxScore: 1, config },
	};
}

function rubricContainsTask(contains: string[]): TaskSpec {
	return {
		id: "task", type: "general", title: "Task", prompt: "Say foo and bar",
		scoring: { method: "rubric", maxScore: 1, config: { contains } },
	};
}

function rubricCriteriaTask(criteria: Array<{ description: string; weight?: number; required?: boolean }>, options: { passThreshold?: number; maxScore?: number }): TaskSpec {
	return {
		id: "task", type: "general", title: "Task", prompt: "Explain the Three Laws",
		scoring: {
			method: "rubric", maxScore: options.maxScore ?? 1,
			config: { criteria, ...(options.passThreshold !== undefined ? { passThreshold: options.passThreshold } : {}) },
		},
	};
}

function llmJudgeTask(criteria: string, options: { maxScore?: number; passThreshold?: number } = {}): TaskSpec {
	return {
		id: "task", type: "general", title: "Task", prompt: "Do something",
		scoring: {
			method: "llm-judge", maxScore: options.maxScore ?? 1,
			config: { criteria, ...(options.passThreshold !== undefined ? { passThreshold: options.passThreshold } : {}) },
		},
	};
}
