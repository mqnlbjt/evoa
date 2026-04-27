import { describe, expect, it } from "vitest";
import { AnthropicModelClient } from "../src/models/anthropic-client.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "anthropic", model: "gpt-5.4-mini" },
	prompts: { system: "You are concise." },
	tools: { allowedTools: [] },
	runtime: { maxTurns: 1 },
};

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Answer",
	prompt: "Say hi",
	scoring: { method: "exact" },
};

describe("AnthropicModelClient", () => {
	it("uses the Messages API and maps text blocks to ModelResponse text", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const client = new AnthropicModelClient({
			apiKey: "key",
			baseURL: "http://localhost:8317/v1",
			maxTokens: 64,
			fetchFn: async (input, init) => {
				capturedUrl = String(input);
				capturedInit = init;
				return new Response(
					JSON.stringify({
						id: "msg_1",
						model: "gpt-5.4-mini",
						stop_reason: "end_turn",
						content: [{ type: "text", text: "hi" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		});

		const response = await client.complete({
			agent,
			task,
			turn: 1,
			messages: [
				{ role: "system", content: agent.prompts.system },
				{ role: "user", content: task.prompt },
			],
		});

		expect(response.text).toBe("hi");
		expect(response.metadata).toMatchObject({ id: "msg_1", model: "gpt-5.4-mini", stopReason: "end_turn" });
		expect(capturedUrl).toBe("http://localhost:8317/v1/messages");
		expect(capturedInit?.headers).toMatchObject({ "x-api-key": "key", "anthropic-version": "2023-06-01" });
		expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
			model: "gpt-5.4-mini",
			max_tokens: 64,
			system: "You are concise.",
			messages: [{ role: "user", content: "Say hi" }],
		});
	});

	it("sends tools and formats tool results for the Messages API", async () => {
		let capturedInit: RequestInit | undefined;
		const client = new AnthropicModelClient({
			apiKey: "key",
			fetchFn: async (_input, init) => {
				capturedInit = init;
				return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), { status: 200 });
			},
		});

		await client.complete({
			agent,
			task,
			turn: 2,
			messages: [
				{ role: "system", content: agent.prompts.system },
				{ role: "user", content: task.prompt },
				{ role: "tool", toolCallId: "toolu_1", toolName: "read_file", content: "{\"content\":\"ok\"}" },
			],
			tools: [{ name: "read_file", description: "Read file", inputSchema: { type: "object" } }],
		});

		expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
			tools: [{ name: "read_file", description: "Read file", input_schema: { type: "object" } }],
			messages: [
				{ role: "user", content: "Say hi" },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"content\":\"ok\"}" }] },
			],
		});
	});

	it("formats assistant tool-call history for the Messages API", async () => {
		let capturedInit: RequestInit | undefined;
		const client = new AnthropicModelClient({
			apiKey: "key",
			fetchFn: async (_input, init) => {
				capturedInit = init;
				return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), { status: 200 });
			},
		});

		await client.complete({
			agent,
			task,
			turn: 2,
			messages: [
				{ role: "user", content: task.prompt },
				{
					role: "assistant",
					content: "checking",
					contentBlocks: [
						{ type: "text", text: "checking" },
						{ type: "tool_call", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
					],
				},
				{ role: "tool", toolCallId: "toolu_1", toolName: "read_file", content: "{\"content\":\"ok\"}" },
			],
		});

		expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
			messages: [
				{ role: "user", content: "Say hi" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "checking" },
						{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"content\":\"ok\"}" }] },
			],
		});
	});

	it("parses tool_use blocks into tool calls", async () => {
		const client = new AnthropicModelClient({
			apiKey: "key",
			fetchFn: async () => new Response(
				JSON.stringify({
					content: [
						{ type: "text", text: "checking" },
						{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
					],
					stop_reason: "tool_use",
				}),
				{ status: 200 },
			),
		});

		const response = await client.complete({
			agent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});

		expect(response.text).toBe("checking");
		expect(response.toolCalls).toEqual([{ id: "toolu_1", name: "read_file", input: { path: "README.md" } }]);
	});
});
