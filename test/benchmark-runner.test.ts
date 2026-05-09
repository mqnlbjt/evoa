import { describe, expect, it } from "vitest";
import { createLeaderboard } from "../src/benchmark/leaderboard.js";
import { BenchmarkRunner } from "../src/benchmark/runner.js";
import type { AgentRuntimeExecutor, TaskExecutionOutput, TaskGrader } from "../src/benchmark/types.js";
import { RuntimeTimeoutError } from "../src/runtime/timeout.js";
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

	async runTask(agent: AgentSpec, task: TaskSpec, signal?: AbortSignal): Promise<TaskExecutionOutput> {
		if (signal?.aborted) throw new Error("aborted");
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

function createIds(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}

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

	it("records runtime errors as errored runs", async () => {
		const store = new MemoryRunStore();
		const runner = new BenchmarkRunner({
			runtime: {
				async runTask() {
					throw new Error("boom");
				},
			},
			grader: exactGrader,
			store,
			createId: createIds(),
			now: () => 1,
		});

		const run = await runner.runTask(baselineAgent, tasks[0]!);

		expect(run.status).toBe("errored");
		expect(run.errorMessage).toBe("boom");
		expect(run.score).toMatchObject({ score: 0, passed: false, reason: "boom" });
		expect(run.trace.map((event) => event.type)).toEqual(["run_start", "error", "score", "run_end"]);
		expect(run.trace.at(-1)?.payload).toMatchObject({ status: "errored" });
		expect(store.taskRuns).toHaveLength(1);
	});

	it("records runtime timeouts as timeout runs", async () => {
		const runner = new BenchmarkRunner({
			runtime: {
				async runTask() {
					throw new RuntimeTimeoutError(50);
				},
			},
			grader: exactGrader,
			createId: createIds(),
			now: () => 1,
		});

		const result = await runner.runSuite(baselineAgent, {
			id: "timeout-suite",
			name: "Timeout Suite",
			tasks: [tasks[0]!],
		});

		expect(result.runs[0]?.status).toBe("timeout");
		expect(result.summary).toMatchObject({ totalTasks: 1, passedTasks: 0, timeoutTasks: 1 });
		expect(result.runs[0]?.errorMessage).toBe("runtime timed out after 50ms");
	});

	it("records aborted runs as interrupted runs", async () => {
		const controller = new AbortController();
		controller.abort(new Error("User interrupted"));
		const runner = new BenchmarkRunner({
			runtime: new FakeRuntime({ "general-pass": "pass" }),
			grader: exactGrader,
			createId: createIds(),
			now: () => 1,
		});

		const run = await runner.runTask(baselineAgent, tasks[0]!, controller.signal);

		expect(run.status).toBe("interrupted");
		expect(run.errorMessage).toBe("aborted");
		expect(run.score).toMatchObject({ score: 0, passed: false, reason: "aborted" });
		expect(run.trace.map((event) => event.type)).toEqual(["run_start", "interrupted", "score", "run_end"]);
		expect(run.trace.at(-1)?.payload).toMatchObject({ status: "interrupted" });
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
