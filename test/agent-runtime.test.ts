import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ModelClient } from "../src/models/types.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "You are concise." },
	tools: { allowedTools: ["echo"], permissionMode: "allow", maxToolCalls: 1 },
	runtime: { maxTurns: 3 },
};

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Answer",
	prompt: "Say hi",
	scoring: { method: "exact" },
};

describe("AgentRuntime", () => {
	it("runs a model request and returns the model text", async () => {
		const modelClient: ModelClient = {
			async complete() {
				return { text: "hi" };
			},
		};
		const runtime = new AgentRuntime({ modelClient, createId: createIds(), now: () => 1 });

		const output = await runtime.runTask(agent, task);

		expect(output.answer).toBe("hi");
		expect(output.trace?.map((event) => event.type)).toEqual(["model_request", "model_response"]);
	});

	it("executes allowed tool calls and continues to the next turn", async () => {
		let turn = 0;
		const modelClient: ModelClient = {
			async complete() {
				turn += 1;
				if (turn === 1) {
					return { text: "checking", toolCalls: [{ id: "call-1", name: "echo", input: "ok" }] };
				}
				return { text: "done" };
			},
		};
		const registry = new ToolRegistry([
			{
				name: "echo",
				description: "Echo input",
				permission: { defaultDecision: "allow", riskLevel: "low" },
				concurrency: "parallel-safe",
				async execute(input) {
					return input;
				},
			},
		]);
		const runtime = new AgentRuntime({ modelClient, toolRegistry: registry, createId: createIds(), now: () => 1 });

		const output = await runtime.runTask(agent, task);

		expect(output.answer).toBe("done");
		expect(output.trace?.map((event) => event.type)).toContain("tool_call");
		expect(output.trace?.map((event) => event.type)).toContain("tool_result");
	});
});

function createIds(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}
