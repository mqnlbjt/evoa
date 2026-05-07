import { describe, expect, it } from "vitest";
import { handleSlashCommand } from "../src/tui/slash-commands.js";
import { TuiState } from "../src/tui/state.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ChatServiceContext } from "../src/cli/chat-service.js";

describe("slash commands", () => {
	it("handles help clear status tools memory trace and exit", async () => {
		const state = new TuiState({ agentName: "Agent", agentId: "agent", model: "model", provider: "provider", toolProfile: "coding", cwd: ".", sessionId: "session" });
		state.addUserMessage("hello");
		const context = { state, chat: fakeChat(), stop: () => { stopped = true; } };
		let stopped = false;
		expect((await handleSlashCommand("/help", context)).message).toContain("/status");
		expect((await handleSlashCommand("/status", context)).message).toContain("session");
		expect((await handleSlashCommand("/tools", context)).message).toContain("echo");
		expect((await handleSlashCommand("/memory", context)).message).toContain("disabled");
		expect((await handleSlashCommand("/stats", context)).message).toBeUndefined();
		expect(state.snapshot().activeView).toBe("stats");
		expect((await handleSlashCommand("/trace", context)).message).toBeUndefined();
		expect(state.snapshot().activeView).toBe("trace");
		expect((await handleSlashCommand("/chat", context)).message).toBeUndefined();
		expect(state.snapshot().activeView).toBe("chat");
		await handleSlashCommand("/clear", context);
		expect(state.snapshot().log.at(-1)?.text).toBe("Cleared");
		const exit = await handleSlashCommand("/exit", context);
		expect(exit.exit).toBe(true);
		expect(stopped).toBe(true);
	});
});

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
