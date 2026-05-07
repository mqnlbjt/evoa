import { describe, expect, it } from "vitest";
import { handleSlashCommand } from "../src/tui/slash-commands.js";
import { TuiState } from "../src/tui/state.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ChatServiceContext } from "../src/cli/chat-service.js";
import type { TraceEvent } from "../src/runtime/events.js";

describe("slash commands", () => {
	it("handles help clear status tools memory trace and exit", async () => {
		const state = new TuiState({ agentName: "Agent", agentId: "agent", model: "model", provider: "provider", toolProfile: "coding", cwd: ".", sessionId: "session" });
		state.addUserMessage("hello");
		const context = { state, chat: fakeChat(), stop: () => { stopped = true; }, newSession: async () => "new-session" };
		let stopped = false;
		expect((await handleSlashCommand("/help", context)).message).toContain("/new");
		expect((await handleSlashCommand("/status", context)).message).toContain("session");
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

function fakeChat(): ChatServiceContext {
	return {
		command: { kind: "chat", format: "human", agentPath: "agent.json", provider: "provider", model: "model", baseURL: "url", providerFormat: "openai-responses", toolProfile: "coding", providedFlags: {} },
		agent: { id: "agent", version: "1.0.0", name: "Agent", kind: "baseline", model: { provider: "provider", model: "model" }, prompts: { system: "system" }, tools: { allowedTools: [] }, runtime: { maxTurns: 1 } },
		runtime: {} as ChatServiceContext["runtime"],
		sessionStore: {} as ChatServiceContext["sessionStore"],
		stored: undefined,
		sessionId: "session",
		messages: [],
		now: () => 1,
		createId: () => "id",
		toolRegistry: new ToolRegistry([{ name: "echo", description: "Echo", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", execute: async () => "ok" }]),
	};
}
