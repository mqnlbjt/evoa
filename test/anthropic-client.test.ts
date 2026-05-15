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

	it("does not send thinking params when reasoning is off", async () => {
		let capturedInit: RequestInit | undefined;
		const client = new AnthropicModelClient({
			apiKey: "key",
			fetchFn: async (_input, init) => {
				capturedInit = init;
				return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), { status: 200 });
			},
		});

		await client.complete({ agent, task, turn: 1, messages: [{ role: "user", content: task.prompt }] });

		const body = JSON.parse(String(capturedInit?.body));
		expect(body).not.toMatchObject({ thinking: expect.anything() });
		expect(body).not.toMatchObject({ output_config: expect.anything() });
	});

	it("sends thinking params when reasoning is enabled", async () => {
		let capturedInit: RequestInit | undefined;
		const client = new AnthropicModelClient({
			apiKey: "key",
			fetchFn: async (_input, init) => {
				capturedInit = init;
				return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), { status: 200 });
			},
		});
		const thinkingAgent: AgentSpec = { ...agent, model: { ...agent.model, reasoningLevel: "high" } };

		await client.complete({ agent: thinkingAgent, task, turn: 1, messages: [{ role: "user", content: task.prompt }] });

		expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
		});
	});

	it("parses thinking blocks when reasoning return content is enabled", async () => {
		const client = new AnthropicModelClient({
			apiKey: "key",
			fetchFn: async () => new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "hidden chain" }, { type: "text", text: "visible" }] }), { status: 200 }),
		});
		const thinkingAgent: AgentSpec = { ...agent, model: { ...agent.model, reasoningLevel: "high", options: { reasoning: { returnContent: "always" } } } };

		const response = await client.complete({ agent: thinkingAgent, task, turn: 1, messages: [{ role: "user", content: task.prompt }] });

		expect(response).toMatchObject({ text: "visible", reasoning: "hidden chain" });
	});

	it("does not replay stored reasoning as Anthropic thinking history", async () => {
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
				{ role: "assistant", content: "visible", contentBlocks: [{ type: "reasoning", text: "hidden chain" }, { type: "text", text: "visible" }] },
				{ role: "user", content: "continue" },
			],
		});

		const body = JSON.parse(String(capturedInit?.body));
		expect(body.messages[1]).toEqual({ role: "assistant", content: "visible" });
	});

	it("applies long TTL to system prompt even with default retention", async () => {
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
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});

		const body = JSON.parse(String(capturedInit?.body));
		expect(body).toMatchObject({
			system: [{ text: "You are concise.", cache_control: { type: "ephemeral", ttl: "1h" } }],
			messages: [{ role: "user", content: [{ type: "text", text: "Say hi", cache_control: { type: "ephemeral" } }] }],
		});
	});

	it("adds cache_control to messages with cache:true flag", async () => {
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
				{ role: "user", content: "[Compacted conversation summary]\nDone so far.", cache: true },
				{ role: "assistant", content: "working" },
				{ role: "user", content: "Continue please." },
			],
		});

		const body = JSON.parse(String(capturedInit?.body));
		expect(body.messages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "[Compacted conversation summary]\nDone so far.", cache_control: { type: "ephemeral" } }] },
			{ role: "assistant", content: "working" },
			{ role: "user", content: [{ type: "text", text: "Continue please.", cache_control: { type: "ephemeral" } }] },
		]);
	});

	it("skips cache:true when cacheControl is disabled via none retention", async () => {
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
			messages: [
				{ role: "user", content: "[Compacted conversation summary]\nDone so far.", cache: true },
				{ role: "user", content: "Continue please." },
			],
		});

		const body = JSON.parse(String(capturedInit?.body));
		expect(body.system).toBe("You are concise.");
		expect(body.messages).toMatchObject([
			{ role: "user", content: "[Compacted conversation summary]\nDone so far." },
			{ role: "user", content: "Continue please." },
		]);
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
	
		describe("streaming", () => {
			it("parses SSE text deltas and calls onTextDelta", async () => {
				const deltas: string[] = [];
				const fullTexts: string[] = [];
				const client = new AnthropicModelClient({
					apiKey: "key",
					fetchFn: async () => sseResponse(streamingSSEEvents()),
				});

				const response = await client.complete({
					agent,
					task,
					turn: 1,
					messages: [{ role: "user", content: task.prompt }],
					stream: true,
					streamCallbacks: {
						onTextDelta: (delta, fullText) => {
							deltas.push(delta);
							fullTexts.push(fullText);
						},
					},
				});

				expect(response.text).toBe("hello world");
				expect(deltas).toEqual(["hello", " world"]);
				expect(fullTexts).toEqual(["hello", "hello world"]);
				expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
				expect(response.metadata).toMatchObject({ id: "msg_1", stopReason: "end_turn" });
			});

			it("parses tool_use blocks in streaming", async () => {
				const client = new AnthropicModelClient({
					apiKey: "key",
					fetchFn: async () => sseResponse(streamingToolUseEvents()),
				});

				const response = await client.complete({
					agent,
					task,
					turn: 1,
					messages: [{ role: "user", content: task.prompt }],
					stream: true,
				});

				expect(response.text).toBe("checking");
				expect(response.toolCalls).toEqual([{ id: "toolu_1", name: "read_file", input: { path: "README.md" } }]);
			});

			it("parses thinking deltas in streaming", async () => {
				const deltas: string[] = [];
				const client = new AnthropicModelClient({
					apiKey: "key",
					fetchFn: async () => sseResponse(streamingThinkingEvents()),
				});
				const thinkingAgent: AgentSpec = { ...agent, model: { ...agent.model, reasoningLevel: "high", options: { reasoning: { returnContent: "always" } } } };

				const response = await client.complete({
					agent: thinkingAgent,
					task,
					turn: 1,
					messages: [{ role: "user", content: task.prompt }],
					stream: true,
					streamCallbacks: { onReasoningDelta: (delta) => deltas.push(delta) },
				});

				expect(response.reasoning).toBe("hidden chain");
				expect(response.text).toBe("visible");
				expect(deltas).toEqual(["hidden ", "chain"]);
			});
		});
});

function sseResponse(events: string[]): Response {
	const body = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			for (const event of events) {
				controller.enqueue(encoder.encode(event));
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function streamingSSEEvents(): string[] {
	return [
		"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-3\",\"usage\":{\"input_tokens\":10}}}\n\n",
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}\n\n",
		"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
		"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n",
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
	];
}

function streamingToolUseEvents(): string[] {
	return [
		"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-3\",\"usage\":{\"input_tokens\":10}}}\n\n",
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"checking\"}}\n\n",
		"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"read_file\"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"README.md\\\"}\"}}\n\n",
		"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
		"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":8}}\n\n",
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
	];
}

function streamingThinkingEvents(): string[] {
	return [
		"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-3\",\"usage\":{\"input_tokens\":10}}}\n\n",
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hidden \"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"chain\"}}\n\n",
		"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"visible\"}}\n\n",
		"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
		"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":8}}\n\n",
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
	];
}
