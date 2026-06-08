import { describe, expect, it } from "vitest";
import { OpenAIChatModelClient } from "../src/models/openai-chat-client.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "local", model: "deepseek-v4-flash", reasoningLevel: "xhigh", options: { reasoning: { provider: { style: "chat-compatible" } } } },
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

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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
	return new Response(body, { status: 200 });
}

describe("OpenAIChatModelClient", () => {
	it("sends messages and maps Chat Completions response to ModelResponse", async () => {
		let captured: { url: string; body: unknown };
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			baseURL: "http://localhost:1234/v1",
			temperature: 0.2,
			maxOutputTokens: 128,
			fetchFn: async (input, init) => {
				captured = { url: String(input), body: JSON.parse((init as RequestInit).body as string) };
				return jsonResponse({
					id: "chatcmpl-123",
					choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
				});
			},
		});

		const response = await client.complete({
			agent,
			task,
			turn: 1,
			messages: [{ role: "system", content: agent.prompts.system }, { role: "user", content: task.prompt }],
		});

		expect(response.text).toBe("hi");
		expect(response.requestId).toBe("chatcmpl-123");
		expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
		expect(captured!.url).toBe("http://localhost:1234/v1/chat/completions");
		expect(captured!.body).toMatchObject({
			model: "deepseek-v4-flash",
			messages: [{ role: "system", content: "You are concise." }, { role: "user", content: "Say hi" }],
			temperature: 0.2,
			max_tokens: 128,
			stream: false,
		});
	});

	it("parses tool calls from Chat Completions response", async () => {
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			fetchFn: async () => jsonResponse({
				choices: [{
					message: {
						content: "",
						tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
					},
				}],
			}),
		});

		const response = await client.complete({
			agent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
			tools: [{ name: "read_file", description: "Read file", inputSchema: { type: "object" } }],
		});

		expect(response.toolCalls).toEqual([{ id: "call_1", name: "read_file", input: { path: "README.md" } }]);
	});

	it("formats tools as Chat Completions function tools", async () => {
		let captured: unknown;
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			fetchFn: async (_, init) => {
				captured = JSON.parse((init as RequestInit).body as string);
				return jsonResponse({ choices: [{ message: { content: "done" } }] });
			},
		});

		await client.complete({
			agent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
			tools: [{ name: "read_file", description: "Read file", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
		});

		expect(captured).toMatchObject({
			tools: [{ type: "function", function: { name: "read_file", description: "Read file", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
		});
	});

	it("formats tool result messages for Chat Completions", async () => {
		let captured: unknown;
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			fetchFn: async (_, init) => {
				captured = JSON.parse((init as RequestInit).body as string);
				return jsonResponse({ choices: [{ message: { content: "done" } }] });
			},
		});

		await client.complete({
			agent,
			task,
			turn: 2,
			messages: [
				{ role: "user", content: task.prompt },
				{ role: "assistant", content: "checking", contentBlocks: [{ type: "tool_call", id: "call_1", name: "read_file", input: { path: "README.md" } }] },
				{ role: "tool", toolCallId: "call_1", toolName: "read_file", content: "{\"content\":\"ok\"}" },
			],
		});

		expect(captured).toMatchObject({
			messages: [
				{ role: "user", content: "Say hi" },
				{ role: "assistant", content: "checking", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] },
				{ role: "tool", tool_call_id: "call_1", content: "{\"content\":\"ok\"}" },
			],
		});
	});

	it("formats tool result from contentBlocks when available", async () => {
		let captured: unknown;
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			fetchFn: async (_, init) => {
				captured = JSON.parse((init as RequestInit).body as string);
				return jsonResponse({ choices: [{ message: { content: "done" } }] });
			},
		});

		await client.complete({
			agent,
			task,
			turn: 2,
			messages: [
				{ role: "user", content: task.prompt },
				{ role: "tool", content: "raw", contentBlocks: [{ type: "tool_result", toolCallId: "call_1", content: "{\"ok\":true}" }] },
			],
		});

		expect(captured).toMatchObject({
			messages: [
				{ role: "user", content: "Say hi" },
				{ role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" },
			],
		});
	});

	it("relays reasoning_content in assistant history for multi-turn", async () => {
		let captured: unknown;
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			fetchFn: async (_, init) => {
				captured = JSON.parse((init as RequestInit).body as string);
				return jsonResponse({ choices: [{ message: { content: "done" } }] });
			},
		});

		const deepseekAgent: AgentSpec = {
			...agent,
			model: { ...agent.model, options: { reasoning: { sendHistory: "always", provider: { style: "chat-compatible" } } } },
		};

		await client.complete({
			agent: deepseekAgent,
			task,
			turn: 2,
			messages: [
				{ role: "user", content: task.prompt },
				{ role: "assistant", content: "", contentBlocks: [{ type: "reasoning", text: "hidden chain" }] },
				{ role: "user", content: "continue" },
			],
		});

		expect(captured).toMatchObject({
			messages: [
				{ role: "user", content: "Say hi" },
				{ role: "assistant", content: null, reasoning_content: "hidden chain" },
				{ role: "user", content: "continue" },
			],
		});
	});

	it("extracts reasoning_content from Chat Completions response", async () => {
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			fetchFn: async () => jsonResponse({
				choices: [{ message: { content: "visible", reasoning_content: "hidden chain" } }],
			}),
		});

		const response = await client.complete({
			agent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});

		expect(response.text).toBe("visible");
		expect(response.reasoning).toBe("hidden chain");
	});

	it("skips reasoning return when policy returnContent is never", async () => {
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			fetchFn: async () => jsonResponse({
				choices: [{ message: { content: "visible", reasoning_content: "hidden chain" } }],
			}),
		});

		const noReasoningAgent: AgentSpec = {
			...agent,
			model: { ...agent.model, options: { reasoning: { mode: "off", returnContent: "never" } } },
		};

		const response = await client.complete({
			agent: noReasoningAgent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});

		expect(response.text).toBe("visible");
		expect(response.reasoning).toBeUndefined();
	});

	it("uses extra_body.thinking for DeepSeek chat-compatible style", async () => {
		let captured: unknown;
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			fetchFn: async (_, init) => {
				captured = JSON.parse((init as RequestInit).body as string);
				return jsonResponse({ choices: [{ message: { content: "hi" } }] });
			},
		});

		const deepseekAgent: AgentSpec = {
			...agent,
			model: {
				...agent.model,
				reasoningLevel: "xhigh",
				options: { reasoning: { provider: { style: "deepseek", requestField: "extra_body.thinking", thinkingType: "enabled", effort: "max" } } },
			},
		};

		await client.complete({
			agent: deepseekAgent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});

		expect(captured).toMatchObject({
			extra_body: { thinking: { type: "enabled" }, reasoning_effort: "max" },
		});
	});

	it("uses reasoning_effort for standard chat-compatible models", async () => {
		let captured: unknown;
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			fetchFn: async (_, init) => {
				captured = JSON.parse((init as RequestInit).body as string);
				return jsonResponse({ choices: [{ message: { content: "hi" } }] });
			},
		});

		const standardAgent: AgentSpec = {
			...agent,
			model: { ...agent.model, reasoningLevel: "high", options: { reasoning: { provider: { style: "chat-compatible", requestField: "reasoning_effort", effort: "high" } } } },
		};

		await client.complete({
			agent: standardAgent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});

		expect(captured).toMatchObject({ reasoning_effort: "high" });
	});

	it("handles array-format content in chat choice", async () => {
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			fetchFn: async () => jsonResponse({
				choices: [{ message: { content: [{ type: "text", text: "hi from array" }] } }],
			}),
		});

		const response = await client.complete({
			agent,
			task,
			turn: 1,
			messages: [{ role: "user", content: task.prompt }],
		});

		expect(response.text).toBe("");
	});

	it("throws on non-OK HTTP status", async () => {
		const client = new OpenAIChatModelClient({
			apiKey: "key",
			fetchFn: async () => jsonResponse({ error: { message: "bad request" } }, 400),
		});

		await expect(client.complete({ agent, task, turn: 1, messages: [{ role: "user", content: task.prompt }] }))
			.rejects.toThrow("bad request");
	});

	describe("streaming", () => {
		it("streams text deltas via SSE and calls onTextDelta", async () => {
			const deltas: string[] = [];
			const client = new OpenAIChatModelClient({
				apiKey: "key",
				fetchFn: async () => sseResponse([
					"data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n",
					"data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
					"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n",
					"data: [DONE]\n\n",
				]),
			});

			const response = await client.complete({
				agent,
				task,
				turn: 1,
				messages: [{ role: "user", content: task.prompt }],
				stream: true,
				streamCallbacks: { onTextDelta: (d) => deltas.push(d) },
			});

			expect(response.text).toBe("hello world");
			expect(deltas).toEqual(["hello", " world"]);
			expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
		});

		it("accumulates reasoning_content deltas in streaming", async () => {
			const reasoningDeltas: string[] = [];
			const client = new OpenAIChatModelClient({
				apiKey: "key",
				fetchFn: async () => sseResponse([
					"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hidden \"}}]}\n\n",
					"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"chain\"}}]}\n\n",
					"data: [DONE]\n\n",
				]),
			});

			const response = await client.complete({
				agent,
				task,
				turn: 1,
				messages: [{ role: "user", content: task.prompt }],
				stream: true,
				streamCallbacks: { onReasoningDelta: (_delta, full) => reasoningDeltas.push(full) },
			});

			expect(response.reasoning).toBe("hidden chain");
			expect(reasoningDeltas).toEqual(["hidden ", "hidden chain"]);
		});

		it("accumulates streaming tool calls by index", async () => {
			const client = new OpenAIChatModelClient({
				apiKey: "key",
				fetchFn: async () => sseResponse([
					"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\"}}]}}]}\n\n",
					"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}}]}}]}\n\n",
					"data: [DONE]\n\n",
				]),
			});

			const response = await client.complete({
				agent,
				task,
				turn: 1,
				messages: [{ role: "user", content: task.prompt }],
				stream: true,
			});

			expect(response.toolCalls).toEqual([{ id: "call_1", name: "read_file", input: { path: "README.md" } }]);
		});

		it("throws on non-OK streaming response", async () => {
			const client = new OpenAIChatModelClient({
				apiKey: "key",
				fetchFn: async () => new Response("{\"error\":{\"message\":\"stream failed\"}}", { status: 500 }),
			});

			await expect(client.complete({ agent, task, turn: 1, messages: [{ role: "user", content: task.prompt }], stream: true }))
				.rejects.toThrow("stream failed");
		});
	});
});
