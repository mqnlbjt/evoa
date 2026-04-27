import { describe, expect, it } from "vitest";
import type { AgentSpec, TaskSpec } from "../src/specs.js";
import type { EvolvingAgentTool } from "../src/tools/types.js";
import { decideToolUse } from "../src/tools/policy.js";
import { ToolRegistry } from "../src/tools/registry.js";

const tool: EvolvingAgentTool = {
	name: "read",
	description: "Read",
	permission: { defaultDecision: "allow", riskLevel: "low" },
	concurrency: "parallel-safe",
	async execute() {
		return "ok";
	},
};

const baseAgent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "system" },
	tools: { allowedTools: ["read"], permissionMode: "allow" },
	runtime: { maxTurns: 1 },
};

const baseTask: TaskSpec = {
	id: "task",
	type: "tool",
	title: "Tool task",
	prompt: "use tool",
	scoring: { method: "exact" },
};

describe("tool policy", () => {
	it("denied tools override allowed tools", () => {
		const decision = decideToolUse({ ...baseAgent, tools: { ...baseAgent.tools, deniedTools: ["read"] } }, baseTask, tool);

		expect(decision.decision).toBe("deny");
		expect(decision.reason).toContain("denied");
	});

	it("task allowedTools narrows agent allowed tools", () => {
		const decision = decideToolUse(baseAgent, { ...baseTask, allowedTools: ["write"] }, tool);

		expect(decision.decision).toBe("deny");
		expect(decision.reason).toContain("task");
	});

	it("permissionMode deny rejects all tools", () => {
		const decision = decideToolUse({ ...baseAgent, tools: { ...baseAgent.tools, permissionMode: "deny" } }, baseTask, tool);

		expect(decision.decision).toBe("deny");
		expect(decision.reason).toContain("denies all");
	});

	it("registry enforces maxToolCalls", async () => {
		const registry = new ToolRegistry([tool]);
		const session = {
			id: "session",
			agent: { ...baseAgent, tools: { ...baseAgent.tools, maxToolCalls: 0 } },
			task: baseTask,
			messages: [],
			trace: [],
			turnCount: 0,
			toolCallCount: 0,
		};

		await expect(registry.execute(session, { id: "call", name: "read" })).rejects.toThrow("max tool calls exceeded");
	});
});
