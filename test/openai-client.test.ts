import { describe, expect, it } from "vitest";
import { OpenAIModelClient, type OpenAIResponsesClient } from "../src/models/openai-client.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "openai", model: "gpt-4.1-mini", reasoningLevel: "low" },
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

describe("OpenAIModelClient", () => {
	it("uses the Responses API and maps output_text to ModelResponse text", async () => {
		let captured: unknown;
		const client: OpenAIResponsesClient = {
			responses: {
				async create(params) {
					captured = params;
					return { output_text: "hi", _request_id: "req_123", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, output_tokens_details: { reasoning_tokens: 2 }, input_tokens_details: { cached_tokens: 4 } } };
				},
			},
		};
		const modelClient = new OpenAIModelClient({ client, temperature: 0.2, maxOutputTokens: 128 });

		const response = await modelClient.complete({
			agent,
			task,
			turn: 1,
			messages: [
				{ role: "system", content: agent.prompts.system },
				{ role: "user", content: task.prompt },
			],
		});

		expect(response).toEqual({ text: "hi", requestId: "req_123", usage: { inputTokens: 6, outputTokens: 3, totalTokens: 13, reasoningTokens: 2, cacheReadTokens: 4 }, metadata: { requestId: "req_123", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, output_tokens_details: { reasoning_tokens: 2 }, input_tokens_details: { cached_tokens: 4 } } } });
		expect(captured).toMatchObject({
			model: "gpt-4.1-mini",
			instructions: "You are concise.",
			input: [{ role: "user", content: "Say hi" }],
			store: false,
			temperature: 0.2,
			max_output_tokens: 128,
			reasoning: { effort: "low" },
		});
	});

	it("sends tools and formats tool results for the Responses API", async () => {
		let captured: unknown;
		const client: OpenAIResponsesClient = {
			responses: {
				async create(params) {
					captured = params;
					return { output_text: "done" };
				},
			},
		};
		const modelClient = new OpenAIModelClient({ client });

		await modelClient.complete({
			agent,
			task,
			turn: 2,
			messages: [
				{ role: "system", content: agent.prompts.system },
				{ role: "user", content: task.prompt },
				{ role: "tool", toolCallId: "call_1", toolName: "read_file", content: "{\"content\":\"ok\"}" },
			],
			tools: [{ name: "read_file", description: "Read file", inputSchema: { type: "object" } }],
		});

		expect(captured).toMatchObject({
			tools: [{ type: "function", name: "read_file", description: "Read file", parameters: { type: "object" } }],
			input: [
				{ role: "user", content: "Say hi" },
				{ type: "function_call_output", call_id: "call_1", output: "{\"content\":\"ok\"}", name: "read_file" },
			],
		});
	});

	it("formats assistant tool-call history for the Responses API", async () => {
		let captured: unknown;
		const client: OpenAIResponsesClient = {
			responses: {
				async create(params) {
					captured = params;
					return { output_text: "done" };
				},
			},
		};

		await new OpenAIModelClient({ client }).complete({
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
						{ type: "tool_call", id: "call_1", name: "read_file", input: { path: "README.md" } },
					],
				},
				{ role: "tool", toolCallId: "call_1", toolName: "read_file", content: "{\"content\":\"ok\"}" },
			],
		});

		expect(captured).toMatchObject({
			input: [
				{ role: "user", content: "Say hi" },
				{ role: "assistant", content: "checking" },
				{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
				{ type: "function_call_output", call_id: "call_1", output: "{\"content\":\"ok\"}", name: "read_file" },
			],
		});
	});

	it("preserves reasoning content for reasoning model follow-up requests", async () => {
		let captured: unknown;
		const client: OpenAIResponsesClient = {
			responses: {
				async create(params) {
					captured = params;
					return {
						output_text: "",
						output: [{ type: "reasoning", reasoning_content: "hidden chain" }],
					};
				},
			},
		};

		const response = await new OpenAIModelClient({ client }).complete({
			agent,
			task,
			turn: 2,
			messages: [
				{ role: "user", content: task.prompt },
				{ role: "assistant", content: "", contentBlocks: [{ type: "reasoning", text: "previous hidden chain" }] },
				{ role: "user", content: "continue" },
			],
		});

		expect(response.reasoning).toBe("hidden chain");
		expect(captured).toMatchObject({
			input: [
				{ role: "user", content: "Say hi" },
				{ role: "assistant", content: "", reasoning_content: "previous hidden chain" },
				{ role: "user", content: "continue" },
			],
		});
	});

	it("parses nested Responses reasoning content", async () => {
		const client: OpenAIResponsesClient = {
			responses: {
				async create() {
					return {
						output: [{ type: "message", content: [{ type: "reasoning", reasoning_content: "nested hidden chain" }, { type: "output_text", text: "visible" }] }],
					};
				},
			},
		};

		const response = await new OpenAIModelClient({ client }).complete({
			agent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});

		expect(response).toMatchObject({ text: "visible", reasoning: "nested hidden chain" });
	});

	it("parses DeepSeek chat-style reasoning content", async () => {
		let captured: unknown;
		let calls = 0;
		const client: OpenAIResponsesClient = {
			responses: {
				async create(params) {
					captured = params;
					calls += 1;
					if (calls === 1) {
						return {
							choices: [{ message: { content: "", reasoning_content: "deepseek hidden chain", tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] } }],
						};
					}
					return { choices: [{ message: { content: "done" } }] };
				},
			},
		};

		const first = await new OpenAIModelClient({ client }).complete({
			agent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});
		expect(first).toMatchObject({ text: "", reasoning: "deepseek hidden chain", toolCalls: [{ id: "call_1", name: "read_file", input: { path: "README.md" } }] });

		await new OpenAIModelClient({ client }).complete({
			agent,
			task,
			turn: 2,
			messages: [
				{ role: "user", content: task.prompt },
				{ role: "assistant", content: "", contentBlocks: [{ type: "reasoning", text: first.reasoning! }, { type: "tool_call", id: "call_1", name: "read_file", input: { path: "README.md" } }] },
				{ role: "tool", toolCallId: "call_1", toolName: "read_file", content: "ok" },
			],
		});
		expect(captured).toMatchObject({
			input: expect.arrayContaining([
				{ role: "assistant", content: "", reasoning_content: "deepseek hidden chain" },
				{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
			]),
		});
	});

	it("parses Responses function_call output into tool calls", async () => {
		const client: OpenAIResponsesClient = {
			responses: {
				async create() {
					return {
						output_text: "",
						output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }],
					};
				},
			},
		};

		const response = await new OpenAIModelClient({ client }).complete({
			agent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});

		expect(response.toolCalls).toEqual([{ id: "call_1", name: "read_file", input: { path: "README.md" } }]);
	});


	it("handles OpenAI-compatible non-array output payloads", async () => {
		const client: OpenAIResponsesClient = {
			responses: {
				async create() {
					return {
						output: { type: "message", content: [{ type: "output_text", text: "hi" }] },
					};
				},
			},
		};

		const response = await new OpenAIModelClient({ client }).complete({
			agent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});

		expect(response.text).toBe("hi");
	});


	it("uses direct fetch for default OpenAI client to avoid SDK response parsing", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const modelClient = new OpenAIModelClient({
			apiKey: "key",
			baseURL: "http://localhost:1234/v1",
			fetchFn: async (input, init) => {
				capturedUrl = String(input);
				capturedInit = init;
				return new Response(JSON.stringify({ output: { type: "message", content: [{ type: "output_text", text: "hi" }] } }), { status: 200, headers: { "content-type": "application/json" } });
			},
		});

		const response = await modelClient.complete({
			agent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});

		expect(response.text).toBe("hi");
		expect(capturedUrl).toBe("http://localhost:1234/v1/responses");
		expect(capturedInit?.headers).toMatchObject({ authorization: "Bearer key" });
	});


	it("falls back to output content when output_text is empty", async () => {
		const client: OpenAIResponsesClient = {
			responses: {
				async create() {
					return { output_text: "", output: [{ type: "message", content: [{ type: "output_text", text: "hi from output" }] }] };
				},
			},
		};

		const response = await new OpenAIModelClient({ client }).complete({ agent, task, turn: 1, messages: [{ role: "user", content: task.prompt }] });

		expect(response.text).toBe("hi from output");
	});

	it("parses array chat choice content", async () => {
		const client: OpenAIResponsesClient = {
			responses: {
				async create() {
					return { choices: [{ message: { content: [{ type: "text", text: "hi from choice" }] } }] };
				},
			},
		};

		const response = await new OpenAIModelClient({ client }).complete({ agent, task, turn: 1, messages: [{ role: "user", content: task.prompt }] });

		expect(response.text).toBe("hi from choice");
	});

	it("sends prompt cache key when session id is available", async () => {
		let captured: unknown;
		const client: OpenAIResponsesClient = {
			responses: {
				async create(params) {
					captured = params;
					return { output_text: "hi" };
				},
			},
		};

		await new OpenAIModelClient({ client }).complete({
			agent,
			task,
			turn: 1,
			sessionId: "session-123",
			messages: [{ role: "user", content: task.prompt }],
		});

		expect(captured).toMatchObject({ prompt_cache_key: "session-123" });
		expect(captured).not.toMatchObject({ prompt_cache_retention: expect.anything() });
	});

	it("omits prompt cache params when cache retention is none or session id is absent", async () => {
		const captured: unknown[] = [];
		const client: OpenAIResponsesClient = {
			responses: {
				async create(params) {
					captured.push(params);
					return { output_text: "hi" };
				},
			},
		};
		const noneAgent = { ...agent, model: { ...agent.model, options: { cacheRetention: "none" } } };

		await new OpenAIModelClient({ client }).complete({ agent: noneAgent, task, turn: 1, sessionId: "session-123", messages: [{ role: "user", content: task.prompt }] });
		await new OpenAIModelClient({ client }).complete({ agent, task, turn: 1, messages: [{ role: "user", content: task.prompt }] });

		expect(captured[0]).not.toMatchObject({ prompt_cache_key: expect.anything() });
		expect(captured[1]).not.toMatchObject({ prompt_cache_key: expect.anything() });
	});

	it("uses long prompt cache retention only for official OpenAI base URLs", async () => {
		const captured: unknown[] = [];
		const client: OpenAIResponsesClient = {
			responses: {
				async create(params) {
					captured.push(params);
					return { output_text: "hi" };
				},
			},
		};
		const longAgent = { ...agent, model: { ...agent.model, options: { cacheRetention: "long" } } };

		await new OpenAIModelClient({ client, baseURL: "https://api.openai.com/v1" }).complete({ agent: longAgent, task, turn: 1, sessionId: "session-123", messages: [{ role: "user", content: task.prompt }] });
		await new OpenAIModelClient({ client, baseURL: "http://localhost:1234/v1" }).complete({ agent: longAgent, task, turn: 1, sessionId: "session-123", messages: [{ role: "user", content: task.prompt }] });

		expect(captured[0]).toMatchObject({ prompt_cache_key: "session-123", prompt_cache_retention: "24h" });
		expect(captured[1]).toMatchObject({ prompt_cache_key: "session-123" });
		expect(captured[1]).not.toMatchObject({ prompt_cache_retention: expect.anything() });
	});

});
