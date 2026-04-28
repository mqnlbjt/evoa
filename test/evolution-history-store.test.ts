import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlEvolutionHistoryStore } from "../src/evolution/history-store.js";
import type { EvolutionCandidate, EvolutionComparison } from "../src/evolution/types.js";
import type { AgentSpec } from "../src/specs.js";
import type { SuiteRunResult } from "../src/benchmark/types.js";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("JsonlEvolutionHistoryStore", () => {
	it("writes and reads evolution comparison records", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "evolving-agent-"));
		const store = new JsonlEvolutionHistoryStore(join(tempDir, "evolution.jsonl"), { now: () => new Date("2026-01-01T00:00:00.000Z") });
		const comparison = createComparison();
		const candidate: EvolutionCandidate = {
			id: "candidate-change",
			kind: "prompt",
			parentAgentId: "baseline",
			agent: comparison.candidate.agent,
			description: "Prompt change",
		};

		const saved = await store.saveComparison(comparison, candidate);
		const records = await store.readRecords();

		expect(saved).toMatchObject({ type: "evolution_comparison", timestamp: "2026-01-01T00:00:00.000Z", suiteId: "suite", recommendation: "accept" });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ candidate: { id: "candidate-change" }, baselineRunIds: ["baseline-run"], candidateRunIds: ["candidate-run"] });
	});
});

function createComparison(): EvolutionComparison {
	const baselineAgent = agent("baseline", "baseline");
	const candidateAgent = agent("candidate", "candidate");
	return {
		baseline: suiteRun(baselineAgent, "baseline-run", 0),
		candidate: suiteRun(candidateAgent, "candidate-run", 1),
		deltaScore: 1,
		deltaPassRate: 1,
		regressions: [],
		improvements: ["task"],
		recommendation: "accept",
	};
}

function agent(id: string, kind: AgentSpec["kind"]): AgentSpec {
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

function suiteRun(agentSpec: AgentSpec, runId: string, score: number): SuiteRunResult {
	const task = { id: "task", type: "general" as const, title: "Task", prompt: "prompt", scoring: { method: "exact" as const } };
	return {
		agent: agentSpec,
		suite: { id: "suite", name: "Suite", tasks: [task] },
		runs: [{ runId, agent: agentSpec, task, status: score === 1 ? "passed" : "failed", score: { score, maxScore: 1, passed: score === 1, reason: "ok" }, startedAt: 1, endedAt: 2, durationMs: 1, trace: [] }],
		summary: { totalTasks: 1, passedTasks: score, failedTasks: score === 1 ? 0 : 1, erroredTasks: 0, timeoutTasks: 0, passRate: score, totalScore: score, maxScore: 1, averageScore: score, totalDurationMs: 1, byTaskType: {} },
	};
}
