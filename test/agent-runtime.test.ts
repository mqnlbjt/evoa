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
		expect(output.trace?.[0]?.payload).toMatchObject({ purpose: "main" });
	});

	it("uses coding purpose when enabled for coding tasks", async () => {
		let seenPurpose: unknown;
		const modelClient: ModelClient = {
			async complete(request) {
				seenPurpose = request.purpose;
				return { text: "hi" };
			},
		};
		const runtime = new AgentRuntime({ modelClient, createId: createIds(), now: () => 1 });

		await runtime.runTask({ ...agent, modelRouting: { purposeRules: { codingTasks: true } } }, { ...task, type: "coding" });

		expect(seenPurpose).toBe("coding");
	});

	it("executes allowed tool calls and continues to the next turn", async () => {
		let turn = 0;
		const seenRequests: unknown[] = [];
		const modelClient: ModelClient = {
			async complete(request) {
				seenRequests.push(request);
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
		expect(seenRequests[0]).toMatchObject({ tools: [{ name: "echo", description: "Echo input" }] });
		expect(seenRequests[1]).toMatchObject({
			messages: expect.arrayContaining([
				{
					role: "assistant",
					content: "checking",
					contentBlocks: [
						{ type: "text", text: "checking" },
						{ type: "tool_call", id: "call-1", name: "echo", input: "ok" },
					],
				},
				{
					role: "tool",
					toolCallId: "call-1",
					toolName: "echo",
					content: "\"ok\"",
					contentBlocks: [{ type: "tool_result", toolCallId: "call-1", toolName: "echo", content: "\"ok\"" }],
				},
			]),
		});
	});

	it("preserves reasoning content in assistant messages", async () => {
		let turn = 0;
		const seenRequests: unknown[] = [];
		const modelClient: ModelClient = {
			async complete(request) {
				seenRequests.push(request);
				turn += 1;
				if (turn === 1) return { reasoning: "hidden chain", toolCalls: [{ id: "call-1", name: "echo", input: { value: "ok" } }] };
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

		await new AgentRuntime({ modelClient, toolRegistry: registry, createId: createIds(), now: () => 1 }).runTask(agent, task);

		expect(seenRequests[1]).toMatchObject({
			messages: expect.arrayContaining([
				{
					role: "assistant",
					content: "",
					contentBlocks: [
						{ type: "reasoning", text: "hidden chain" },
						{ type: "tool_call", id: "call-1", name: "echo", input: { value: "ok" } },
					],
				},
			]),
		});
	});

	it("preserves tool-only assistant turns before tool results", async () => {
		let turn = 0;
		const seenRequests: unknown[] = [];
		const modelClient: ModelClient = {
			async complete(request) {
				seenRequests.push(request);
				turn += 1;
				if (turn === 1) {
					return { toolCalls: [{ id: "call-1", name: "echo", input: { value: "ok" } }] };
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

		await new AgentRuntime({ modelClient, toolRegistry: registry, createId: createIds(), now: () => 1 }).runTask(agent, task);

		expect(seenRequests[1]).toMatchObject({
			messages: expect.arrayContaining([
				{
					role: "assistant",
					content: "",
					contentBlocks: [{ type: "tool_call", id: "call-1", name: "echo", input: { value: "ok" } }],
				},
			]),
		});
	});

	it("normalizes large tool results before adding them to messages", async () => {
		let turn = 0;
		const seenRequests: unknown[] = [];
		const modelClient: ModelClient = {
			async complete(request) {
				seenRequests.push(request);
				turn += 1;
				if (turn === 1) return { toolCalls: [{ id: "call-1", name: "echo", input: "ok" }] };
				return { text: "done" };
			},
		};
		const registry = new ToolRegistry([
			{
				name: "echo",
				description: "Echo input",
				permission: { defaultDecision: "allow", riskLevel: "low" },
				concurrency: "parallel-safe",
				maxResultBytes: 20,
				async execute() {
					return { value: "x".repeat(100) };
				},
			},
		]);

		await new AgentRuntime({ modelClient, toolRegistry: registry, createId: createIds(), now: () => 1 }).runTask(agent, task);

		expect(seenRequests[1]).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({
					role: "tool",
					content: expect.stringContaining("truncated"),
				}),
			]),
		});
	});

	it("runs consecutive parallel-safe tool calls concurrently while preserving result order", async () => {
		let turn = 0;
		const seenRequests: unknown[] = [];
		const completions: string[] = [];
		const modelClient: ModelClient = {
			async complete(request) {
				seenRequests.push(request);
				turn += 1;
				if (turn === 1) {
					return { toolCalls: [{ id: "call-1", name: "slow" }, { id: "call-2", name: "fast" }] };
				}
				return { text: "done" };
			},
		};
		const registry = new ToolRegistry([
			{
				name: "slow",
				description: "Slow",
				permission: { defaultDecision: "allow", riskLevel: "low" },
				concurrency: "parallel-safe",
				async execute() {
					await new Promise((resolve) => setTimeout(resolve, 30));
					completions.push("slow");
					return "slow";
				},
			},
			{
				name: "fast",
				description: "Fast",
				permission: { defaultDecision: "allow", riskLevel: "low" },
				concurrency: "parallel-safe",
				async execute() {
					completions.push("fast");
					return "fast";
				},
			},
		]);

		await new AgentRuntime({ modelClient, toolRegistry: registry, createId: createIds(), now: () => 1 }).runTask({ ...agent, tools: { ...agent.tools, allowedTools: ["slow", "fast"], maxToolCalls: 2 } }, task);

		expect(completions).toEqual(["fast", "slow"]);
		expect(seenRequests[1]).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({ role: "tool", toolCallId: "call-1", content: "\"slow\"" }),
				expect.objectContaining({ role: "tool", toolCallId: "call-2", content: "\"fast\"" }),
			]),
		});
	});

	it("times out long running model requests", async () => {
		const modelClient: ModelClient = {
			async complete() {
				await new Promise(() => undefined);
				return { text: "never" };
			},
		};
		const runtime = new AgentRuntime({ modelClient, createId: createIds(), now: () => 1 });

		await expect(runtime.runTask({ ...agent, runtime: { maxTurns: 1, timeoutMs: 1 } }, task)).rejects.toThrow("timed out");
	});

	it("does not expose denied tools to the model", async () => {
		let captured: unknown;
		const modelClient: ModelClient = {
			async complete(request) {
				captured = request;
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
		const deniedAgent = { ...agent, tools: { ...agent.tools, deniedTools: ["echo"] } };

		await new AgentRuntime({ modelClient, toolRegistry: registry, createId: createIds(), now: () => 1 }).runTask(deniedAgent, task);

		expect(captured).not.toHaveProperty("tools");
	});
});

function createIds(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}
