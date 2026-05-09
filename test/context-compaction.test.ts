import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest } from "../src/models/types.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createAgentSession, type SessionEntry } from "../src/runtime/session.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Answer",
	prompt: "current prompt",
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

describe("context compaction", () => {
	it("does not compact when contextCompression is off", async () => {
		const requests: ModelRequest[] = [];
		const runtime = new AgentRuntime({ modelClient: recordingClient(requests), createId: ids(), now: () => 1 });
		const session = createAgentSession({ id: "session", agent: baseAgent, task, messages: longMessages() });

		await runtime.runSession(session);

		expect(requests.map((request) => request.purpose)).toEqual(["main"]);
	});

	it("compacts over-budget context before the main request", async () => {
		const requests: ModelRequest[] = [];
		const agent: AgentSpec = {
			...baseAgent,
			runtime: {
				maxTurns: 1,
				contextCompression: "auto",
				contextBudget: { maxInputTokens: 120, reserveTokens: 1, triggerRatio: 0.5, keepRecentTokens: 1, summaryMaxTokens: 300 },
			},
		};
		const runtime = new AgentRuntime({ modelClient: recordingClient(requests), createId: ids(), now: () => 1 });
		const session = createAgentSession({ id: "session", agent, task, messages: longMessages() });

		await runtime.runSession(session);

		expect(requests.map((request) => request.purpose).at(0)).toBe("compaction");
		expect(requests.map((request) => request.purpose).at(-1)).toBe("main");
		expect(session.trace).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "context_compaction", payload: expect.objectContaining({ compacted: true }) }),
		]));
	});

	it("includes structured file operations in compaction requests", async () => {
		const requests: ModelRequest[] = [];
		const modelClient: ModelClient = {
			async complete(request) {
				requests.push(request);
				if (request.purpose === "compaction") return { text: compactionSummaryWithPath("src/runtime/loop.ts") };
				return { text: "done" };
			},
		};
		const agent: AgentSpec = {
			...baseAgent,
			runtime: {
				maxTurns: 1,
				contextCompression: "auto",
				contextBudget: { maxInputTokens: 120, reserveTokens: 1, triggerRatio: 0.5, keepRecentTokens: 1, summaryMaxTokens: 300 },
			},
		};
		const runtime = new AgentRuntime({ modelClient, createId: ids(), now: () => 1 });
		const session = createAgentSession({ id: "session", agent, task, messages: fileOpMessages() });

		await runtime.runSession(session);

		const compactionRequest = requests.find((request) => request.purpose === "compaction");
		expect(compactionRequest?.messages.at(-1)?.content).toContain("<structured_file_ops>");
		expect(compactionRequest?.messages.at(-1)?.content).toContain("- read src/runtime/loop.ts via read_file");
	});

	it("compacts and retries once after a provider context overflow", async () => {
		const requests: ModelRequest[] = [];
		let mainAttempts = 0;
		const modelClient: ModelClient = {
			async complete(request) {
				requests.push(request);
				if (request.purpose === "compaction") return { text: compactionSummary() };
				mainAttempts += 1;
				if (mainAttempts === 1) throw new Error("maximum context length exceeded");
				return { text: "done" };
			},
		};
		const agent: AgentSpec = {
			...baseAgent,
			runtime: {
				maxTurns: 1,
				contextCompression: "auto",
				contextBudget: { maxInputTokens: 1000, reserveTokens: 1, triggerRatio: 0.99, keepRecentTokens: 10, summaryMaxTokens: 300 },
			},
		};
		const runtime = new AgentRuntime({ modelClient, createId: ids(), now: () => 1 });
		const session = createAgentSession({ id: "session", agent, task, messages: longMessages() });

		await runtime.runSession(session);

		expect(requests.map((request) => request.purpose)).toEqual(["main", "compaction", "main"]);
		expect(session.trace).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "context_compaction", payload: expect.objectContaining({ compacted: true }) }),
		]));
	});

	it("does not compact again when existing entries reached maxCompactionsPerRun", async () => {
		const requests: ModelRequest[] = [];
		const agent: AgentSpec = {
			...baseAgent,
			runtime: {
				maxTurns: 1,
				contextCompression: "auto",
				contextBudget: { maxInputTokens: 120, reserveTokens: 1, triggerRatio: 0.5, keepRecentTokens: 10, summaryMaxTokens: 300, maxCompactionsPerRun: 1 },
			},
		};
		const runtime = new AgentRuntime({ modelClient: recordingClient(requests), createId: ids(), now: () => 1 });
		const session = createAgentSession({ id: "session", agent, task, entries: compactedEntries() });

		expect(session.compactionCount).toBe(1);

		await runtime.runSession(session);

		expect(requests.map((request) => request.purpose)).toEqual(["main"]);
		expect(session.entries?.filter((entry) => entry.kind === "compaction")).toHaveLength(1);
	});

	it("routes tool-heavy turns when configured and tools are available", async () => {
		const requests: ModelRequest[] = [];
		const agent: AgentSpec = {
			...baseAgent,
			modelRouting: { aliases: { heavy: { provider: "fake", model: "heavy" } }, routes: { "tool-heavy": "heavy" }, purposeRules: { toolHeavy: true } },
			tools: { allowedTools: ["echo"], permissionMode: "allow" },
		};
		const runtime = new AgentRuntime({
			modelClient: recordingClient(requests),
			toolRegistry: new ToolRegistry([{ name: "echo", description: "Echo", concurrency: "sequential", permission: { defaultDecision: "allow", riskLevel: "low" }, async execute(input) { return input; } }]),
			createId: ids(),
			now: () => 1,
		});

		await runtime.runTask(agent, task);

		expect(requests[0]?.purpose).toBe("tool-heavy");
	});
});

function recordingClient(requests: ModelRequest[]): ModelClient {
	return {
		async complete(request) {
			requests.push(request);
			if (request.purpose === "compaction") return { text: compactionSummary() };
			return { text: "done" };
		},
	};
}

function compactionSummary(): string {
	return compactionSummaryWithPath("No files were read or modified during this synthetic test run.");
}

function compactionSummaryWithPath(path: string): string {
	return `<summary>
<primary_request>current prompt</primary_request>
<key_technical_concepts>TypeScript runtime context compaction validation and trace events.</key_technical_concepts>
<files_and_code_sections>${path}</files_and_code_sections>
<errors_and_fixes>No errors occurred while summarizing this synthetic conversation.</errors_and_fixes>
<problem_solving>The runtime summarized older entries before sending the final main model request.</problem_solving>
<all_user_messages>The user asked the agent to answer the current prompt.</all_user_messages>
<pending_tasks>No pending tasks remain in this synthetic test.</pending_tasks>
<current_work>The agent is preparing a compact context for the next model request.</current_work>
<optional_next_step>Send the compacted context to the main model request.</optional_next_step>
</summary>`;
}

function longMessages() {
	return [
		{ role: "system" as const, content: "system" },
		{ role: "user" as const, content: "first " + "x".repeat(200) },
		{ role: "assistant" as const, content: "answer " + "y".repeat(200) },
		{ role: "user" as const, content: "second " + "z".repeat(200) },
		{ role: "assistant" as const, content: "answer two" },
		{ role: "user" as const, content: "current" },
	];
}

function fileOpMessages() {
	return [
		{ role: "system" as const, content: "system" },
		{ role: "user" as const, content: "inspect file " + "x".repeat(200) },
		{ role: "assistant" as const, content: "", contentBlocks: [{ type: "tool_call" as const, id: "call-1", name: "read_file", input: { path: "src/runtime/loop.ts" } }] },
		{ role: "tool" as const, toolCallId: "call-1", toolName: "read_file", content: "file content " + "y".repeat(200), contentBlocks: [{ type: "tool_result" as const, toolCallId: "call-1", toolName: "read_file", content: "file content" }] },
		{ role: "user" as const, content: "current" },
	];
}

function compactedEntries(): SessionEntry[] {
	return [
		{ id: "system-1", kind: "system", createdAt: 0, message: { role: "system", content: "system" } },
		{ id: "old-1", kind: "user", createdAt: 1, message: { role: "user", content: "old " + "x".repeat(200) } },
		{
			id: "compaction-1",
			kind: "compaction",
			createdAt: 2,
			summary: "previous compacted summary",
			message: { role: "user", content: "[Compacted conversation summary]\nprevious compacted summary" },
			sourceEntryIds: ["old-1"],
			keptRecentEntryIds: [],
			tokenEstimateBefore: 100,
			tokenEstimateAfter: 20,
			turn: 0,
		},
		{ id: "recent-1", kind: "user", createdAt: 3, message: { role: "user", content: "recent " + "y".repeat(400) } },
		{ id: "recent-2", kind: "assistant", createdAt: 4, message: { role: "assistant", content: "answer " + "z".repeat(400) } },
		{ id: "recent-3", kind: "user", createdAt: 5, message: { role: "user", content: "current" } },
	];
}

function ids(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}
