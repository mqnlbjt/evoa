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
						usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
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
		expect(response.requestId).toBe("msg_1");
		expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 16 });
		expect(response.metadata).toMatchObject({ id: "msg_1", model: "gpt-5.4-mini", stopReason: "end_turn", usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } });
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
			tools: [{ name: "read_file", description: "Read file", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "Say hi", cache_control: { type: "ephemeral" } }] },
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
				{ role: "user", content: [{ type: "text", text: "Say hi", cache_control: { type: "ephemeral" } }] },
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

	it("omits cache markers when cache retention is none", async () => {
		let capturedInit: RequestInit | undefined;
		const client = new AnthropicModelClient({
			apiKey: "key",
			fetchFn: async (_input, init) => {
				capturedInit = init;
				return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), { status: 200 });
			},
		});

		await client.complete({
			agent: { ...agent, model: { ...agent.model, options: { cacheRetention: "none" } } },
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
			tools: [{ name: "read_file", description: "Read file", inputSchema: { type: "object" } }],
		});

		expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
			system: "You are concise.",
			tools: [{ name: "read_file", description: "Read file", input_schema: { type: "object" } }],
			messages: [{ role: "user", content: "Say hi" }],
		});
	});

	it("uses cache control only for official Anthropic base URLs", async () => {
		const bodies: unknown[] = [];
		const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), { status: 200 });
		};
		const longAgent = { ...agent, model: { ...agent.model, options: { cacheRetention: "long" } } };

		await new AnthropicModelClient({ apiKey: "key", baseURL: "https://api.anthropic.com/v1", fetchFn }).complete({ agent: longAgent, task, turn: 1, messages: [{ role: "user", content: task.prompt }] });
		await new AnthropicModelClient({ apiKey: "key", baseURL: "http://localhost:8317/v1", fetchFn }).complete({ agent: longAgent, task, turn: 1, messages: [{ role: "user", content: task.prompt }] });

		expect(bodies[0]).toMatchObject({ system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }] });
		expect(bodies[1]).toMatchObject({ system: "You are concise." });
	});

	it("parses reasoning usage tokens", async () => {
		const client = new AnthropicModelClient({
			apiKey: "key",
			fetchFn: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 4, output_tokens_details: { reasoning_tokens: 3 } } }), { status: 200 }),
		});

		const response = await client.complete({ agent, task, turn: 1, messages: [{ role: "user", content: task.prompt }] });

		expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 4, reasoningTokens: 3, totalTokens: 14 });
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
