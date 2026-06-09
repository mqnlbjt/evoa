import { describe, expect, it } from "vitest";
import { handleSlashCommand } from "../src/tui/slash-commands.js";
import { TuiState } from "../src/tui/state.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ChatServiceContext } from "../src/cli/chat-service.js";
import type { TraceEvent } from "../src/runtime/events.js";
import type { MemoryContextItems, MemoryItem, MemorySearchRequest } from "../src/memory/types.js";

describe("slash commands", () => {
	it("handles help clear status tools memory trace and exit", async () => {
		const state = new TuiState({ agentName: "Agent", agentId: "agent", model: "model", provider: "provider", toolProfile: "coding", mcpServerCount: 2, cwd: ".", sessionId: "session" });
		state.addUserMessage("hello");
		const context = { state, chat: fakeChat(), stop: () => { stopped = true; }, newSession: async () => "new-session" };
		let stopped = false;
		expect((await handleSlashCommand("/help", context)).message).toContain("/new");
		expect((await handleSlashCommand("/status", context)).message).toContain("mcp servers: 2");
		expect((await handleSlashCommand("/tools", context)).message).toContain("echo");
		expect((await handleSlashCommand("/memory", context)).message).toContain("disabled");
		expect((await handleSlashCommand("/stats", context)).message).toBeUndefined();
		expect(state.snapshot().activeView).toBe("stats");
		expect((await handleSlashCommand("/trace", context)).message).toBe("No trace events");
		expect((await handleSlashCommand("/trace-page", context)).message).toBeUndefined();
		expect(state.snapshot().activeView).toBe("trace");
		expect((await handleSlashCommand("/chat", context)).message).toBeUndefined();
		expect(state.snapshot().activeView).toBe("chat");
		await handleSlashCommand("/clear", context);
		expect(state.snapshot().log.at(-1)?.text).toBe("Cleared");
		await handleSlashCommand("/new", context);
		expect(state.snapshot().log.at(-1)?.text).toBe("Started new session: new-session");
		const exit = await handleSlashCommand("/exit", context);
		expect(exit.exit).toBe(true);
		expect(stopped).toBe(true);
	});

	it("summarizes and searches memory", async () => {
		const state = new TuiState({ agentName: "Agent", agentId: "agent", model: "model", provider: "provider", toolProfile: "coding", cwd: ".", sessionId: "session" });
		const chat = fakeChat({
			messages: [{ role: "user", content: "remember sqlite setup" }],
			memoryManager: fakeMemoryManager({
				stable: [memoryItem("m1", "project", "knowledge", "Use sqlite for durable memory")],
				dynamic: [memoryItem("m2", "session", "episode", "User asked about release readiness")],
			}),
		});
		const context = { state, chat, stop: () => undefined };

		const summary = (await handleSlashCommand("/memory", context)).message ?? "";
		expect(summary).toContain("memory: enabled");
		expect(summary).toContain("stable: 1");
		expect(summary).toContain("dynamic: 1");
		expect(summary).toContain("Use sqlite for durable memory");

		const search = (await handleSlashCommand("/memory sqlite", context)).message ?? "";
		expect(search).toContain("memory search: sqlite");
		expect(search).toContain("matches: 1");
		expect(search).toContain("Use sqlite for durable memory");
	});

	it("shows recent trace events with bounded limits", async () => {
		const state = new TuiState({ agentName: "Agent", agentId: "agent", model: "model", provider: "provider", toolProfile: "coding", cwd: ".", sessionId: "session" });
		const context = { state, chat: fakeChat(), stop: () => undefined };
		for (let index = 1; index <= 60; index += 1) state.applyTraceEvent(traceEvent(index));

		expect((await handleSlashCommand("/trace 2", context)).message).toContain("e59");
		expect((await handleSlashCommand("/trace 2", context)).message).toContain("e60");
		expect((await handleSlashCommand("/trace 2", context)).message).not.toContain("e58");
		expect((await handleSlashCommand("/trace 0", context)).message).toContain("e51");
		expect((await handleSlashCommand("/trace 100", context)).message).not.toContain("e10");
		expect((await handleSlashCommand("/trace 100", context)).message).toContain("e11");
	});
});

function traceEvent(index: number): TraceEvent {
	return { id: `e${index}`, type: "model_request", timestamp: index, agentId: "agent", taskId: "task", payload: { turn: index, text: `payload ${index}` } };
}

type ChatServiceContextOverrides = Omit<Partial<ChatServiceContext>, "memoryManager"> & { memoryManager?: NonNullable<ChatServiceContext["memoryManager"]> };

function fakeChat(overrides: ChatServiceContextOverrides = {}): ChatServiceContext {
	return {
		command: { kind: "chat", format: "human", agentPath: "agent.json", provider: "provider", model: "model", baseURL: "url", providerFormat: "openai-responses", toolProfile: "coding", providedFlags: {} },
		agent: { id: "agent", version: "1.0.0", name: "Agent", kind: "baseline", model: { provider: "provider", model: "model" }, prompts: { system: "system" }, tools: { allowedTools: [] }, runtime: { maxTurns: 1 } },
		runtime: {} as ChatServiceContext["runtime"],
		sessionStore: {} as ChatServiceContext["sessionStore"],
		stored: undefined,
		sessionId: "session",
		messages: [],
		entries: [],
		now: () => 1,
		createId: () => "id",
		memoryProjectId: "/workspace",
		toolRegistry: new ToolRegistry([{ name: "echo", description: "Echo", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", execute: async () => "ok" }]),
		...overrides,
	};
}

function fakeMemoryManager(items: MemoryContextItems): NonNullable<ChatServiceContext["memoryManager"]> {
	return {
		loadContextItems: async () => items,
		search: async (request: MemorySearchRequest) => [...items.stable, ...items.dynamic].filter((item) => item.content.toLowerCase().includes(request.query.toLowerCase())),
	} as unknown as NonNullable<ChatServiceContext["memoryManager"]>;
}

function memoryItem(id: string, scope: MemoryItem["scope"], layer: MemoryItem["layer"], content: string): MemoryItem {
	return {
		id,
		agentId: "agent",
		layer,
		content,
		sourceRefs: [{ kind: "message", id: "msg", sessionId: "session", excerptHash: id }],
		confidence: 1,
		status: "verified",
		createdAt: 1,
		updatedAt: 1,
		...(scope ? { scope } : {}),
	};
}
