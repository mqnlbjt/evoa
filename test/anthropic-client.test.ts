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
});
