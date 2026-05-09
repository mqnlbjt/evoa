import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { ModelClient } from "../src/models/types.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";
import { ToolRegistry } from "../src/tools/registry.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "system" },
	tools: { allowedTools: ["mcp__docs__search"], permissionMode: "allow" },
	runtime: { maxTurns: 3 },
};

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Task",
	prompt: "search docs",
	scoring: { method: "exact" },
};

describe("MCP runtime loop integration", () => {
	it("executes MCP wrapper tools through the normal runtime loop", async () => {
		let turn = 0;
		const requests: unknown[] = [];
		const modelClient: ModelClient = {
			async complete(request) {
				requests.push(request);
				turn += 1;
				if (turn === 1) return { toolCalls: [{ id: "call-1", name: "mcp__docs__search", input: { q: "mcp" } }] };
				return { text: "done" };
			},
		};
		const registry = new ToolRegistry([{
			name: "mcp__docs__search",
			description: "Search docs",
			permission: { defaultDecision: "allow", riskLevel: "medium" },
			concurrency: "sequential",
			metadata: { kind: "mcp", serverName: "docs", remoteToolName: "search" },
			async execute(input) {
				return { content: [{ type: "text", text: `found ${(input as { q: string }).q}` }] };
			},
		}]);

		const result = await new AgentRuntime({ modelClient, toolRegistry: registry, createId: createIds(), now: () => 1 }).runTask(agent, task);

		expect(result.answer).toBe("done");
		expect(result.trace?.map((event) => event.type)).toEqual(["context_view", "model_request", "model_response", "tool_call", "tool_result", "context_view", "model_request", "model_response"]);
		expect(requests[0]).toMatchObject({ tools: [{ name: "mcp__docs__search" }] });
		expect((requests[1] as { messages: unknown[] }).messages).toContainEqual(expect.objectContaining({
			role: "tool",
			toolCallId: "call-1",
			toolName: "mcp__docs__search",
			content: JSON.stringify({ content: [{ type: "text", text: "found mcp" }] }),
		}));
	});
});

function createIds(): () => string {
	let index = 0;
	return () => `id-${index += 1}`;
}
