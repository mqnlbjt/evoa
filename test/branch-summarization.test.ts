import { describe, expect, it } from "vitest";
import { summarizeBranch, buildBranchSummaryMessage } from "../src/runtime/branch-summarization.js";
import { createAgentSession, ensureSessionEntries } from "../src/runtime/session.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const baseAgent: AgentSpec = {
	id: "test", version: "1", name: "test", kind: "baseline",
	model: { provider: "test", model: "test" },
	prompts: { system: "test" },
	tools: { allowedTools: [] },
	runtime: { maxTurns: 1 },
};

const baseTask: TaskSpec = {
	id: "task", type: "general", title: "test", prompt: "test",
	scoring: { method: "custom" },
};

function ids(): () => string {
	let n = 0;
	return () => `id-${n++}`;
}

describe("branch summarization", () => {
	it("generates a branch summary and appends it to the session", () => {
		const session = createAgentSession({ id: "s1", agent: baseAgent, task: baseTask });
		const createId = ids();
		const result = summarizeBranch(session, {
			subagentId: "planner",
			task: "Plan the implementation",
			answer: "We should use a queue-based approach.",
			status: "completed",
			turnCount: 3,
			durationMs: 1500,
		}, createId, () => 1);

		expect(result.summary).toContain("planner");
		expect(result.summary).toContain("Plan the implementation");
		expect(result.summary).toContain("queue-based");
		expect(result.tokens).toBeGreaterThan(0);
		expect(result.entryId).toBeTruthy();

		const entries = ensureSessionEntries(session);
		const branchEntry = entries.find((e) => e.kind === "branch_summary");
		expect(branchEntry).toBeTruthy();
		expect(branchEntry?.kind).toBe("branch_summary");
	});

	it("builds a standalone summary message", () => {
		const msg = buildBranchSummaryMessage({
			subagentId: "critic",
			task: "Review the code",
			answer: "Looks good.",
			status: "completed",
			turnCount: 1,
			durationMs: 500,
		});
		expect(msg.role).toBe("user");
		expect(msg.content).toContain("critic");
		expect(msg.content).toContain("Review the code");
	});

	it("includes error info for errored branches", () => {
		const session = createAgentSession({ id: "s2", agent: baseAgent, task: baseTask });
		const result = summarizeBranch(session, {
			subagentId: "verifier",
			task: "Verify output",
			answer: "",
			status: "errored",
			errorMessage: "tool timeout",
			turnCount: 2,
			durationMs: 800,
		}, ids(), () => 1);

		expect(result.summary).toContain("errored");
		expect(result.summary).toContain("tool timeout");
	});
});
