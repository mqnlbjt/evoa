import { describe, expect, it } from "vitest";
import type { AgentSpec, TaskSpec } from "../src/specs.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { EvolvingAgentTool } from "../src/tools/types.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "system" },
	tools: { allowedTools: ["echo"], permissionMode: "allow" },
	runtime: { maxTurns: 1 },
};

const task: TaskSpec = {
	id: "task",
	type: "tool",
	title: "Tool task",
	prompt: "use tool",
	scoring: { method: "exact" },
};

const echoTool: EvolvingAgentTool = {
	name: "echo",
	description: "Echo input",
	permission: { defaultDecision: "allow", riskLevel: "low" },
	concurrency: "parallel-safe",
	async execute(input) {
		return input;
	},
};

describe("runtime hooks", () => {
	it("allows hooks to deny tool calls", async () => {
		const registry = new ToolRegistry([echoTool]);
		const result = await registry.execute(createSession(), { id: "1", name: "echo", input: "ok" }, [
			{ beforeToolCall: () => ({ decision: "deny", reason: "blocked" }) },
		]);

		expect(result.status).toBe("denied");
		expect(result.errorMessage).toBe("blocked");
	});

	it("allows hooks to mutate tool input", async () => {
		const registry = new ToolRegistry([echoTool]);
		const result = await registry.execute(createSession(), { id: "1", name: "echo", input: "old" }, [
			{ beforeToolCall: () => ({ decision: "mutate", input: "new" }) },
		]);

		expect(result.status).toBe("success");
		expect(result.output).toBe("new");
		expect(result.call.input).toBe("new");
	});

	it("allows hooks to mutate tool results", async () => {
		const registry = new ToolRegistry([echoTool]);
		const result = await registry.execute(createSession(), { id: "1", name: "echo", input: "old" }, [
			{ afterToolResult: (_session, toolResult) => ({ ...toolResult, output: "patched" }) },
		]);

		expect(result.status).toBe("success");
		expect(result.output).toBe("patched");
	});

	it("keeps void hooks compatible", async () => {
		const registry = new ToolRegistry([echoTool]);
		const seen: string[] = [];
		const result = await registry.execute(createSession(), { id: "1", name: "echo", input: "ok" }, [
			{ beforeToolCall: () => { seen.push("before"); }, afterToolResult: () => { seen.push("after"); } },
		]);

		expect(result.status).toBe("success");
		expect(seen).toEqual(["before", "after"]);
	});
});

function createSession() {
	return {
		id: "session",
		agent,
		task,
		messages: [],
		trace: [],
		turnCount: 0,
		toolCallCount: 0,
	};
}
