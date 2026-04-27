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
					return { output_text: "hi", _request_id: "req_123" };
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

		expect(response).toEqual({ text: "hi", metadata: { requestId: "req_123" } });
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
				{ type: "function_call_output", call_id: "call_1", output: "{\"content\":\"ok\"}" },
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
				{ type: "function_call_output", call_id: "call_1", output: "{\"content\":\"ok\"}" },
			],
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
});
