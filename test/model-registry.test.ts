import { describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/models/registry.js";
import type { OpenAIResponsesClient } from "../src/models/openai-client.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "local", model: "gpt-5.4-mini" },
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

describe("ModelRegistry", () => {
	it("registers and lists providers", () => {
		const registry = new ModelRegistry();
		registry.registerProvider({
			id: "local",
			baseURL: "http://localhost:8317/v1",
			apiKey: "key",
			format: "openai-responses",
		});

		expect(registry.listProviders()).toEqual([
			expect.objectContaining({ id: "local", baseURL: "http://localhost:8317/v1", format: "openai-responses" }),
		]);
	});

	it("discovers OpenAI-compatible provider models", async () => {
		const registry = new ModelRegistry({ fetchFn: async () => modelsResponse([{ id: "gpt-5.4-mini" }]) });
		registry.registerProvider({
			id: "local",
			baseURL: "http://localhost:8317/v1",
			apiKey: "key",
			format: "openai-responses",
		});

		const models = await registry.discover("local");

		expect(models).toHaveLength(1);
		expect(registry.getModel("local", "gpt-5.4-mini")).toMatchObject({
			id: "gpt-5.4-mini",
			providerId: "local",
			format: "openai-responses",
			baseURL: "http://localhost:8317/v1",
		});
	});

	it("allows manual models to override discovered models", async () => {
		const registry = new ModelRegistry({ fetchFn: async () => modelsResponse([{ id: "gpt-5.4-mini" }]) });
		registry.registerProvider({ id: "local", baseURL: "http://localhost:8317/v1", format: "openai-responses" });
		await registry.discover("local");

		registry.registerModel("local", {
			id: "gpt-5.4-mini",
			providerId: "local",
			format: "openai-responses",
			maxOutputTokens: 2048,
		});

		expect(registry.getModel("local", "gpt-5.4-mini")?.maxOutputTokens).toBe(2048);
	});

	it("filters models by provider", () => {
		const registry = new ModelRegistry();
		registry.registerProvider({ id: "local", baseURL: "http://localhost:8317/v1", format: "openai-responses" });
		registry.registerProvider({ id: "anthropic-local", baseURL: "http://localhost:8317/v1", format: "anthropic-messages" });
		registry.registerModel("local", { id: "gpt-5.4-mini", providerId: "local", format: "openai-responses" });
		registry.registerModel("anthropic-local", {
			id: "claude-local",
			providerId: "anthropic-local",
			format: "anthropic-messages",
		});

		expect(registry.listModels("local")).toEqual([
			expect.objectContaining({ id: "gpt-5.4-mini", providerId: "local" }),
		]);
		expect(registry.getModel("local", "missing")).toBeUndefined();
	});

	it("creates OpenAI clients with injected client factory", async () => {
		let capturedFactoryOptions: unknown;
		let capturedParams: unknown;
		const fakeClient: OpenAIResponsesClient = {
			responses: {
				async create(params) {
					capturedParams = params;
					return { output_text: "hi" };
				},
			},
		};
		const registry = new ModelRegistry({
			openAIClientFactory: (options) => {
				capturedFactoryOptions = options;
				return fakeClient;
			},
		});
		registry.registerProvider({
			id: "local",
			baseURL: "http://localhost:8317/v1",
			apiKey: "key",
			format: "openai-responses",
			headers: { "x-provider": "local" },
		});
		registry.registerModel("local", {
			id: "gpt-5.4-mini",
			providerId: "local",
			format: "openai-responses",
			maxOutputTokens: 64,
		});

		const client = registry.createClient("local", "gpt-5.4-mini");
		const response = await client.complete({ agent, task, turn: 1, messages: [{ role: "user", content: "Say hi" }] });

		expect(response.text).toBe("hi");
		expect(capturedFactoryOptions).toEqual({
			apiKey: "key",
			baseURL: "http://localhost:8317/v1",
			defaultHeaders: { "x-provider": "local" },
		});
		expect(capturedParams).toMatchObject({ model: "gpt-5.4-mini", max_output_tokens: 64 });
	});

	it("creates Anthropic clients and forwards provider/model options", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const registry = new ModelRegistry({
			fetchFn: async (input, init) => {
				capturedUrl = String(input);
				capturedInit = init;
				return new Response(
					JSON.stringify({ id: "msg_1", model: "gpt-5.4-mini", content: [{ type: "text", text: "hi" }] }),
					{ status: 200 },
				);
			},
		});
		registry.registerProvider({
			id: "anthropic-local",
			baseURL: "http://localhost:8317/v1",
			apiKey: "key",
			format: "anthropic-messages",
			headers: { "x-provider": "anthropic-local" },
		});
		registry.registerModel("anthropic-local", {
			id: "gpt-5.4-mini",
			providerId: "anthropic-local",
			format: "anthropic-messages",
			maxOutputTokens: 64,
		});

		const client = registry.createClient("anthropic-local", "gpt-5.4-mini");
		const response = await client.complete({ agent, task, turn: 1, messages: [{ role: "user", content: "Say hi" }] });

		expect(response.text).toBe("hi");
		expect(capturedUrl).toBe("http://localhost:8317/v1/messages");
		expect(capturedInit?.headers).toMatchObject({
			"x-api-key": "key",
			"x-provider": "anthropic-local",
		});
		expect(JSON.parse(String(capturedInit?.body))).toMatchObject({ max_tokens: 64 });
	});

	it("rejects unsupported discovery and invalid client lookups", async () => {
		const registry = new ModelRegistry();
		registry.registerProvider({ id: "anthropic-local", baseURL: "http://localhost:8317/v1", format: "anthropic-messages" });
		registry.registerProvider({ id: "local", baseURL: "http://localhost:8317/v1", format: "openai-responses" });
		registry.registerModel("local", { id: "bad", providerId: "local", format: "anthropic-messages" });

		await expect(registry.discover("anthropic-local")).rejects.toThrow("anthropic-messages");
		expect(() => registry.createClient("missing", "model")).toThrow("Provider missing");
		expect(() => registry.createClient("local", "missing")).toThrow("Model missing");
		expect(() => registry.createClient("local", "bad")).toThrow("does not match model format");
	});
});

function modelsResponse(data: unknown[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}
