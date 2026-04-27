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
			input: "user: Say hi",
			store: false,
			temperature: 0.2,
			max_output_tokens: 128,
			reasoning: { effort: "low" },
		});
	});
});
