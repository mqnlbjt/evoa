import { describe, expect, it } from "vitest";
import { createLeaderboard } from "../src/benchmark/leaderboard.js";
import { BenchmarkRunner } from "../src/benchmark/runner.js";
import type { AgentRuntimeExecutor, TaskExecutionOutput, TaskGrader } from "../src/benchmark/types.js";
import { MemoryRunStore } from "../src/sessions/run-store.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const baselineAgent: AgentSpec = {
	id: "baseline",
	version: "1.0.0",
	name: "Baseline Agent",
	kind: "baseline",
	model: {
		provider: "fake",
		model: "fake-model",
	},
	prompts: {
		system: "You are a benchmarked agent.",
	},
	tools: {
		allowedTools: [],
		permissionMode: "allow",
	},
	runtime: {
		maxTurns: 3,
	},
};

const candidateAgent: AgentSpec = {
	...baselineAgent,
	id: "candidate",
	version: "1.1.0",
	name: "Candidate Agent",
	kind: "candidate",
};

const tasks: TaskSpec[] = [
	{
		id: "general-pass",
		type: "general",
		title: "Answer exactly",
		prompt: "Return pass",
		scoring: {
			method: "exact",
			maxScore: 1,
		},
	},
	{
		id: "tool-fail",
		type: "tool",
		title: "Use a fake tool",
		prompt: "Return fail",
		scoring: {
			method: "exact",
			maxScore: 1,
		},
	},
];

class FakeRuntime implements AgentRuntimeExecutor {
	constructor(private readonly answers: Record<string, string>) {}

	async runTask(agent: AgentSpec, task: TaskSpec): Promise<TaskExecutionOutput> {
		const answer = this.answers[task.id] ?? "fail";
		return {
			answer,
			trace: [
				{
					id: `trace-${task.id}`,
					type: "model_response",
					timestamp: 10,
					agentId: agent.id,
					taskId: task.id,
					payload: { text: answer },
				},
			],
		};
	}
}

const exactGrader: TaskGrader = {
	async grade(_agent: AgentSpec, _task: TaskSpec, output: TaskExecutionOutput) {
		const passed = output.answer === "pass";
		return {
			score: passed ? 1 : 0,
			maxScore: 1,
			passed,
			reason: passed ? "matched expected answer" : "answer did not match",
		};
	},
};

describe("BenchmarkRunner", () => {
	it("runs a suite, records traces, grades tasks, and stores results", async () => {
		const store = new MemoryRunStore();
		let id = 0;
		let now = 100;
		const runner = new BenchmarkRunner({
			runtime: new FakeRuntime({ "general-pass": "pass", "tool-fail": "fail" }),
			grader: exactGrader,
			store,
			createId: () => `id-${++id}`,
			now: () => now++,
		});

		const result = await runner.runSuite(baselineAgent, {
			id: "mixed",
			name: "Mixed Suite",
			tasks,
		});

		expect(result.summary.totalTasks).toBe(2);
		expect(result.summary.passedTasks).toBe(1);
		expect(result.summary.failedTasks).toBe(1);
		expect(result.summary.passRate).toBe(0.5);
		expect(result.summary.totalScore).toBe(1);
		expect(result.summary.maxScore).toBe(2);
		expect(result.summary.byTaskType.general?.passedTasks).toBe(1);
		expect(result.summary.byTaskType.tool?.passedTasks).toBe(0);
		expect(result.runs[0]?.trace.map((event) => event.type)).toContain("run_start");
		expect(result.runs[0]?.trace.map((event) => event.type)).toContain("model_response");
		expect(result.runs[0]?.trace.map((event) => event.type)).toContain("score");
		expect(result.runs[0]?.trace.map((event) => event.type)).toContain("run_end");
		expect(store.taskRuns).toHaveLength(2);
		expect(store.suiteRuns).toHaveLength(1);
	});

	it("creates a leaderboard ordered by pass rate, score, then duration", async () => {
		const suite = {
			id: "mixed",
			name: "Mixed Suite",
			tasks,
		};
		const baselineRunner = new BenchmarkRunner({
			runtime: new FakeRuntime({ "general-pass": "pass", "tool-fail": "fail" }),
			grader: exactGrader,
			createId: () => "baseline-id",
			now: () => 1,
		});
		const candidateRunner = new BenchmarkRunner({
			runtime: new FakeRuntime({ "general-pass": "pass", "tool-fail": "pass" }),
			grader: exactGrader,
			createId: () => "candidate-id",
			now: () => 1,
		});

		const leaderboard = createLeaderboard([
			await baselineRunner.runSuite(baselineAgent, suite),
			await candidateRunner.runSuite(candidateAgent, suite),
		]);

		expect(leaderboard[0]).toMatchObject({
			rank: 1,
			agentId: "candidate",
			passRate: 1,
			totalScore: 2,
		});
		expect(leaderboard[1]).toMatchObject({
			rank: 2,
			agentId: "baseline",
			passRate: 0.5,
			totalScore: 1,
		});
	});
});
