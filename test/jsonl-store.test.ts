import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlRunStore } from "../src/sessions/jsonl-store.js";
import type { AgentTaskRunResult, SuiteRunResult } from "../src/benchmark/types.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("JsonlRunStore", () => {
	it("writes and reads task and suite run records", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "evolving-agent-"));
		const store = new JsonlRunStore(join(tempDir, "runs.jsonl"));
		const taskRun = createTaskRun();
		const suiteRun: SuiteRunResult = {
			agent: taskRun.agent,
			suite: { id: "suite", name: "Suite", tasks: [taskRun.task] },
			runs: [taskRun],
			summary: {
				totalTasks: 1,
				passedTasks: 1,
				failedTasks: 0,
				erroredTasks: 0,
				timeoutTasks: 0,
				interruptedTasks: 0,
				passRate: 1,
				totalScore: 1,
				maxScore: 1,
				averageScore: 1,
				totalDurationMs: 1,
				byTaskType: {},
			},
		};

		await store.saveTaskRun(taskRun);
		await store.saveSuiteRun(suiteRun);

		const records = await store.readRecords();
		expect(records).toHaveLength(2);
		expect(records[0]?.type).toBe("task_run");
		expect(records[1]?.type).toBe("suite_run");
	});
});

function createTaskRun(): AgentTaskRunResult {
	const agent: AgentSpec = {
		id: "agent",
		version: "1.0.0",
		name: "Agent",
		kind: "baseline",
		model: { provider: "fake", model: "fake" },
		prompts: { system: "system" },
		tools: { allowedTools: [] },
		runtime: { maxTurns: 1 },
	};
	const task: TaskSpec = {
		id: "task",
		type: "general",
		title: "Task",
		prompt: "prompt",
		scoring: { method: "exact" },
	};
	return {
		runId: "run",
		agent,
		task,
		status: "passed",
		score: { score: 1, maxScore: 1, passed: true, reason: "ok" },
		startedAt: 1,
		endedAt: 2,
		durationMs: 1,
		trace: [],
	};
}
