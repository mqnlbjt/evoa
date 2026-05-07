import { describe, expect, it } from "vitest";
import type { AgentSpec, TaskSpec } from "../src/specs.js";
import { ToolRegistry, type RuntimeHook } from "../src/tools/registry.js";
import type { EvolvingAgentTool } from "../src/tools/types.js";

const mcpTool: EvolvingAgentTool = {
	name: "mcp__docs__search",
	description: "Search docs",
	permission: { defaultDecision: "allow", riskLevel: "medium" },
	concurrency: "sequential",
	async execute(input) {
		return input;
	},
};

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "system" },
	tools: { allowedTools: ["mcp__docs__search"], permissionMode: "allow" },
	runtime: { maxTurns: 1 },
};

const task: TaskSpec = {
	id: "task",
	type: "tool",
	title: "Tool task",
	prompt: "use tool",
	scoring: { method: "exact" },
};

describe("MCP tool policy", () => {
	it("uses normal allow and deny policy for MCP tools", async () => {
		const registry = new ToolRegistry([mcpTool]);
		const session = createSession({ ...agent, tools: { ...agent.tools, deniedTools: ["mcp__docs__search"] } });

		const result = await registry.execute(session, { id: "call", name: "mcp__docs__search" });

		expect(result.status).toBe("denied");
		expect(result.errorMessage).toContain("denied");
	});

	it("honors task-level allowedTools narrowing", async () => {
		const registry = new ToolRegistry([mcpTool]);
		const session = { ...createSession(agent), task: { ...task, allowedTools: ["other"] } };

		const result = await registry.execute(session, { id: "call", name: "mcp__docs__search" });

		expect(result.status).toBe("denied");
		expect(result.errorMessage).toContain("task");
	});

	it("runs hooks and maxToolCalls for MCP tools", async () => {
		const registry = new ToolRegistry([mcpTool]);
		const session = createSession({ ...agent, tools: { ...agent.tools, maxToolCalls: 1 } });
		const hooks: RuntimeHook[] = [{ beforeToolCall: () => ({ decision: "mutate", input: { q: "mutated" } }) }];

		const first = await registry.execute(session, { id: "1", name: "mcp__docs__search", input: { q: "original" } }, hooks);
		const second = await registry.execute(session, { id: "2", name: "mcp__docs__search" }, hooks);

		expect(first).toMatchObject({ status: "success", output: { q: "mutated" } });
		expect(second.status).toBe("limit_exceeded");
	});
});

function createSession(sessionAgent: AgentSpec) {
	return {
		id: "session",
		agent: sessionAgent,
		task,
		messages: [],
		trace: [],
		turnCount: 0,
		toolCallCount: 0,
	};
}
