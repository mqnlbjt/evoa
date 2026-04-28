import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ModelClient, ModelRequest } from "../src/models/types.js";
import type { AgentSpec, SubagentSpec, TaskSpec } from "../src/specs.js";

const mainAgent: AgentSpec = {
	id: "main",
	version: "1.0.0",
	name: "Main",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "main" },
	tools: { allowedTools: ["subagent"], permissionMode: "allow", maxToolCalls: 1 },
	runtime: { maxTurns: 3 },
};

const workerAgent: AgentSpec = {
	id: "worker-agent",
	version: "1.0.0",
	name: "Worker",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "worker" },
	tools: { allowedTools: ["echo"], permissionMode: "allow", maxToolCalls: 1 },
	runtime: { maxTurns: 3 },
};

const subagent: SubagentSpec = { id: "worker", role: "tool-specialist", agent: workerAgent };

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Main task",
	prompt: "delegate",
	scoring: { method: "custom" },
};

describe("subagent tool", () => {
	it("runs a bundle-defined subagent with independent tools and trace linkage", async () => {
		const requests: ModelRequest[] = [];
		const modelClient: ModelClient = {
			async complete(request) {
				requests.push(request);
				if (request.agent.id === "main" && request.turn === 1) {
					return { toolCalls: [{ id: "main-call", name: "subagent", input: { subagentId: "worker", task: "use echo" } }] };
				}
				if (request.agent.id === "worker-agent" && request.turn === 1) {
					return { toolCalls: [{ id: "worker-call", name: "echo", input: "sub-answer" }] };
				}
				if (request.agent.id === "worker-agent") return { text: "sub-answer" };
				return { text: "done" };
			},
		};

		const runtime = new AgentRuntime({
			modelClient,
			toolRegistry: new ToolRegistry(),
			createToolRegistryForAgent: () => new ToolRegistry([{ name: "echo", description: "Echo", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", async execute(input) { return input; } }]),
			subagents: [subagent],
			createId: createIds(),
			now: () => 1,
		});

		const output = await runtime.runTask(mainAgent, task);
		const subagentResult = output.trace?.find((event) => event.type === "tool_result")?.payload as { output?: unknown } | undefined;

		expect(output.answer).toBe("done");
		expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["subagent"]);
		expect(requests.find((request) => request.agent.id === "worker-agent")?.tools?.map((tool) => tool.name)).toEqual(["echo"]);
		expect(subagentResult?.output).toMatchObject({ subagentId: "worker", agentId: "worker-agent", status: "completed", answer: "sub-answer" });
		const trace = (subagentResult?.output as { trace?: Array<{ parentSessionId?: string; parentToolCallId?: string; subagentId?: string }> }).trace ?? [];
		expect(trace.length).toBeGreaterThan(0);
		expect(trace.every((event) => event.parentSessionId === "id-1" && event.parentToolCallId === "main-call" && event.subagentId === "worker")).toBe(true);
	});

	it("returns a tool error for unknown subagents", async () => {
		const modelClient: ModelClient = {
			async complete(request) {
				if (request.turn === 1) return { toolCalls: [{ id: "main-call", name: "subagent", input: { subagentId: "missing", task: "work" } }] };
				return { text: "done" };
			},
		};
		const runtime = new AgentRuntime({ modelClient, toolRegistry: new ToolRegistry(), subagents: [subagent], createToolRegistryForAgent: () => new ToolRegistry(), createId: createIds(), now: () => 1 });

		const output = await runtime.runTask(mainAgent, task);
		const result = output.trace?.find((event) => event.type === "tool_result")?.payload as { status?: string; errorMessage?: string } | undefined;

		expect(result).toMatchObject({ status: "error", errorMessage: "Unknown subagent: missing" });
	});
});

function createIds(): () => string {
	let next = 0;
	return () => `id-${++next}`;
}
