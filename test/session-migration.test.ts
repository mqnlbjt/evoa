import { describe, expect, it } from "vitest";
import { appendCompactionEntry, createAgentSession, entriesFromMessages, type SessionEntry } from "../src/runtime/session.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

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

describe("session message migration", () => {
	it("creates canonical entries from legacy messages", () => {
		const messages = [{ role: "system" as const, content: "system" }, { role: "user" as const, content: "hello" }];
		const session = createAgentSession({ id: "session", agent, task, messages });

		expect(session.entries?.map((entry) => entry.kind)).toEqual(["system", "user"]);
		expect(session.messages).toEqual(messages);
	});

	it("preserves tool messages in migrated entries", () => {
		const entries = entriesFromMessages([
			{ role: "assistant", content: "", contentBlocks: [{ type: "tool_call", id: "call-1", name: "read_file" }] },
			{ role: "tool", toolCallId: "call-1", toolName: "read_file", content: "result", contentBlocks: [{ type: "tool_result", toolCallId: "call-1", toolName: "read_file", content: "result" }] },
		]);

		expect(entries).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "assistant" }),
			expect.objectContaining({ kind: "tool_result", modelVisibleContent: "result" }),
		]));
	});

	it("infers compaction count from existing entries", () => {
		const session = createAgentSession({ id: "session", agent, task, entries: entriesWithCompaction() });

		expect(session.compactionCount).toBe(1);
	});

	it("prefers explicit compaction count over inferred entries", () => {
		const session = createAgentSession({ id: "session", agent, task, entries: entriesWithCompaction(), compactionCount: 5 });

		expect(session.compactionCount).toBe(5);
	});

	it("increments compaction count after inferring existing entries", () => {
		const session = createAgentSession({ id: "session", agent, task, entries: entriesWithCompaction() });

		appendCompactionEntry(session, {
			id: "compaction-2",
			createdAt: 3,
			summary: "second summary",
			sourceEntryIds: ["user-1"],
			keptRecentEntryIds: [],
			tokenEstimateBefore: 20,
			tokenEstimateAfter: 10,
		});

		expect(session.compactionCount).toBe(2);
	});
});

function entriesWithCompaction(): SessionEntry[] {
	return [
		{ id: "system-1", kind: "system", createdAt: 0, message: { role: "system", content: "system" } },
		{ id: "user-1", kind: "user", createdAt: 1, message: { role: "user", content: "old prompt" } },
		{
			id: "compaction-1",
			kind: "compaction",
			createdAt: 2,
			summary: "first summary",
			message: { role: "user", content: "[Compacted conversation summary]\nfirst summary" },
			sourceEntryIds: ["user-1"],
			keptRecentEntryIds: [],
			tokenEstimateBefore: 10,
			tokenEstimateAfter: 5,
			turn: 0,
		},
	];
}
