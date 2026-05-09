import { describe, expect, it } from "vitest";
import { resolveContextBudget } from "../src/runtime/budget.js";
import { microCompact } from "../src/runtime/micro-compact.js";
import { createAgentSession, ensureSessionEntries, type ToolResultSessionEntry } from "../src/runtime/session.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Answer",
	prompt: "test",
	scoring: { method: "exact" },
};

const baseAgent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "system" },
	tools: { allowedTools: [], permissionMode: "allow" },
	runtime: { maxTurns: 1 },
};

const microAgent: AgentSpec = {
	...baseAgent,
	runtime: {
		maxTurns: 1,
		contextBudget: {
			maxInputTokens: 4000,
			reserveTokens: 500,
			keepRecentTokens: 1000,
			triggerRatio: 0.85,
			summaryMaxTokens: 500,
			maxCompactionsPerRun: 1,
			failureMode: "continue",
		},
	},
};

describe("microCompact keepRecentTools", () => {
	it("clears all compactable tool results when keepRecentTools is 0", () => {
		const session = sessionWithToolResults(5);
		const budget = budgetFor(["Read"], 0);

		const result = microCompact(session, budget.microCompact, budget);

		expect(result.compacted).toBe(true);
		expect(result.toolsCleared).toBe(5);
		expect(result.toolsKept).toBe(0);
	});

	it("keeps only the most recent tool result when keepRecentTools is 1", () => {
		const session = sessionWithToolResults(5);
		const budget = budgetFor(["Read"], 1);

		const result = microCompact(session, budget.microCompact, budget);

		expect(result.compacted).toBe(true);
		expect(result.toolsCleared).toBe(4);
		expect(result.toolsKept).toBe(1);
	});

	it("does not compact when there are no compactable tools", () => {
		const session = createAgentSession({ id: "session", agent: microAgent, task });
		const budget = budgetFor(["Read"], 0);

		const result = microCompact(session, budget.microCompact, budget);

		expect(result.compacted).toBe(false);
		expect(result.toolsCleared).toBe(0);
	});

	it("preserves error tool results while clearing successful results", () => {
		const session = createAgentSession({ id: "session", agent: microAgent, task });
		addToolResult(session, { id: "success", toolName: "Read", content: "success result" });
		addToolResult(session, { id: "error", toolName: "Read", content: "error result", isError: true });
		const budget = budgetFor(["Read"], 0);

		const result = microCompact(session, budget.microCompact, budget);

		expect(result.compacted).toBe(true);
		expect(result.toolsCleared).toBe(1);
		expect(result.errorsPreserved).toBe(1);
		expect(toolResultEntry(session, "success").modelVisibleContent).toBe("[Old tool result content cleared]");
		expect(toolResultEntry(session, "error").modelVisibleContent).toBe("error result");
	});

	it("reports preserved errors even when nothing is cleared", () => {
		const session = createAgentSession({ id: "session", agent: microAgent, task });
		addToolResult(session, { id: "error", toolName: "Read", content: "error result", isError: true });
		const budget = budgetFor(["Read"], 0);

		const result = microCompact(session, budget.microCompact, budget);

		expect(result.compacted).toBe(false);
		expect(result.toolsCleared).toBe(0);
		expect(result.errorsPreserved).toBe(1);
		expect(toolResultEntry(session, "error").modelVisibleContent).toBe("error result");
	});

	it("does not clear non-compactable tool results", () => {
		const session = createAgentSession({ id: "session", agent: microAgent, task });
		addToolResult(session, { id: "read", toolName: "Read", content: "read result" });
		addToolResult(session, { id: "bash", toolName: "Bash", content: "bash result" });
		const budget = budgetFor(["Read"], 0);

		const result = microCompact(session, budget.microCompact, budget);

		expect(result.toolsCleared).toBe(1);
		expect(toolResultEntry(session, "read").modelVisibleContent).toBe("[Old tool result content cleared]");
		expect(toolResultEntry(session, "bash").modelVisibleContent).toBe("bash result");
	});

	it("keeps tool_result contentBlocks synchronized when clearing", () => {
		const session = createAgentSession({ id: "session", agent: microAgent, task });
		addToolResult(session, { id: "read", toolName: "Read", content: "read result" });
		const budget = budgetFor(["Read"], 0);

		microCompact(session, budget.microCompact, budget);

		const entry = toolResultEntry(session, "read");
		expect(entry.message.content).toBe("[Old tool result content cleared]");
		expect(entry.modelVisibleContent).toBe("[Old tool result content cleared]");
		expect(entry.message.contentBlocks).toEqual([
			expect.objectContaining({ type: "tool_result", toolCallId: "read", toolName: "Read", content: "[Old tool result content cleared]" }),
		]);
		expect(session.messages.find((message) => message.toolCallId === "read")?.content).toBe("[Old tool result content cleared]");
	});

	it("is idempotent for already cleared tool results", () => {
		const session = createAgentSession({ id: "session", agent: microAgent, task });
		addToolResult(session, { id: "read", toolName: "Read", content: "read result" });
		const budget = budgetFor(["Read"], 0);

		const first = microCompact(session, budget.microCompact, budget);
		const snapshot = JSON.stringify(session.entries);
		const second = microCompact(session, budget.microCompact, budget);

		expect(first.toolsCleared).toBe(1);
		expect(second.compacted).toBe(false);
		expect(second.toolsCleared).toBe(0);
		expect(JSON.stringify(session.entries)).toBe(snapshot);
	});
});

function sessionWithToolResults(count: number) {
	const session = createAgentSession({ id: "session", agent: microAgent, task });
	for (let i = 0; i < count; i++) addToolResult(session, { id: `call-${i}`, toolName: "Read", content: `result-${i}` });
	return session;
}

function addToolResult(session: ReturnType<typeof createAgentSession>, options: { id: string; toolName: string; content: string; isError?: boolean }): void {
	const entries = ensureSessionEntries(session);
	entries.push(
		{ kind: "assistant", message: { role: "assistant", content: "", contentBlocks: [{ type: "tool_call", id: options.id, name: options.toolName, input: {} }] }, id: `entry-a-${options.id}`, createdAt: entries.length },
		{
			kind: "tool_result",
			message: {
				role: "tool",
				toolCallId: options.id,
				toolName: options.toolName,
				content: options.content,
				contentBlocks: [{ type: "tool_result", toolCallId: options.id, toolName: options.toolName, content: options.content, ...(options.isError ? { isError: true } : {}) }],
			},
			id: `entry-r-${options.id}`,
			createdAt: entries.length + 1,
			modelVisibleContent: options.content,
		},
	);
}

function toolResultEntry(session: ReturnType<typeof createAgentSession>, toolCallId: string): ToolResultSessionEntry {
	const entry = ensureSessionEntries(session).find((candidate): candidate is ToolResultSessionEntry => candidate.kind === "tool_result" && candidate.message.toolCallId === toolCallId);
	if (!entry) throw new Error(`missing tool result ${toolCallId}`);
	return entry;
}

function budgetFor(compactableToolNames: string[], keepRecentTools: number) {
	return resolveContextBudget({
		...microAgent,
		runtime: {
			maxTurns: 1,
			contextBudget: { ...microAgent.runtime.contextBudget!, microCompact: { enabled: true, compactableToolNames, keepRecentTools } },
		},
	});
}
