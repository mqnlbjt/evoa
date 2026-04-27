import { describe, expect, it } from "vitest";
import type { AgentSpec, TaskSpec } from "../src/specs.js";
import type { EvolvingAgentTool } from "../src/tools/types.js";
import { decideToolUse } from "../src/tools/policy.js";
import { ToolRegistry, type RuntimeHook } from "../src/tools/registry.js";

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

	it("permissionMode ask denies deterministically", () => {
		const decision = decideToolUse({ ...baseAgent, tools: { ...baseAgent.tools, permissionMode: "ask" } }, baseTask, tool);

		expect(decision.decision).toBe("deny");
		expect(decision.reason).toContain("unsupported");
	});

	it("registry returns structured maxToolCalls results", async () => {
		const registry = new ToolRegistry([tool]);
		const session = createSession({ ...baseAgent, tools: { ...baseAgent.tools, maxToolCalls: 0 } });

		const result = await registry.execute(session, { id: "call", name: "read" });

		expect(result.status).toBe("limit_exceeded");
		expect(result.errorMessage).toBe("max tool calls exceeded: 0");
		expect(session.toolCallCount).toBe(0);
	});

	it("counts denied, unknown, and failed tool attempts", async () => {
		const failingTool: EvolvingAgentTool = { ...tool, name: "fail", async execute() { throw new Error("boom"); } };
		const registry = new ToolRegistry([tool, failingTool]);
		const session = createSession({ ...baseAgent, tools: { ...baseAgent.tools, allowedTools: ["read", "fail"], deniedTools: ["read"] } });

		expect((await registry.execute(session, { id: "1", name: "read" })).status).toBe("denied");
		expect((await registry.execute(session, { id: "2", name: "missing" })).status).toBe("unknown");
		expect((await registry.execute(session, { id: "3", name: "fail" })).status).toBe("error");
		expect(session.toolCallCount).toBe(3);
	});

	it("runs afterToolResult for all final outcomes", async () => {
		const registry = new ToolRegistry([tool]);
		const seen: string[] = [];
		const session = createSession({ ...baseAgent, tools: { ...baseAgent.tools, deniedTools: ["read"], maxToolCalls: 2 } });
		const hooks: RuntimeHook[] = [{ afterToolResult: async (_session, result) => { seen.push(result.status); } }];

		await registry.execute(session, { id: "1", name: "read" }, hooks);
		await registry.execute(session, { id: "2", name: "missing" }, hooks);
		await registry.execute(session, { id: "3", name: "read" }, hooks);

		expect(seen).toEqual(["denied", "unknown", "limit_exceeded"]);
	});
});

function createSession(agent: AgentSpec) {
	return {
		id: "session",
		agent,
		task: baseTask,
		messages: [],
		trace: [],
		turnCount: 0,
		toolCallCount: 0,
	};
}
