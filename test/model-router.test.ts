import { describe, expect, it } from "vitest";
import { DeterministicModelRouter, RoutingModelClient, type ModelClientFactory } from "../src/models/router.js";
import type { ModelClient, ModelRequest } from "../src/models/types.js";
import type { AgentSpec, ModelRoutingSpec, ModelSpec, TaskSpec } from "../src/specs.js";

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Task",
	prompt: "Say hi",
	scoring: { method: "exact" },
};

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "openai", model: "default-model" },
	prompts: { system: "sys" },
	tools: { allowedTools: [] },
	runtime: { maxTurns: 1 },
};

describe("DeterministicModelRouter", () => {
	it("falls back to the agent model without routing config", () => {
		const route = new DeterministicModelRouter().resolve(request(agent));

		expect(route).toEqual({ purpose: "main", alias: "default", model: { provider: "openai", model: "default-model" } });
	});

	it("routes purposes to configured aliases", () => {
		const routedAgent = withRouting({
			aliases: {
				small: { provider: "openai", model: "small-model" },
				strong: { provider: "anthropic", model: "strong-model" },
			},
			routes: { main: "strong", "memory-extraction": "small" },
		});

		expect(new DeterministicModelRouter().resolve(request(routedAgent)).model).toEqual({ provider: "anthropic", model: "strong-model" });
		expect(new DeterministicModelRouter().resolve(request(routedAgent, "memory-extraction")).model).toEqual({ provider: "openai", model: "small-model" });
	});

	it("falls back through defaultAlias and agent model", () => {
		const router = new DeterministicModelRouter();

		expect(router.resolve(request(withRouting({ aliases: { medium: { provider: "openai", model: "medium-model" } }, defaultAlias: "medium" }), "summary")).model).toEqual({ provider: "openai", model: "medium-model" });
		expect(router.resolve(request(withRouting({ routes: { summary: "default" } }), "summary")).model).toEqual({ provider: "openai", model: "default-model" });
	});

	it("rejects a route that references a missing alias", () => {
		expect(() => new DeterministicModelRouter().resolve(request(withRouting({ routes: { summary: "missing" } }), "summary"))).toThrow("Model route for purpose summary references missing alias missing");
	});
});

describe("RoutingModelClient", () => {
	it("delegates to resolved model clients and records routing metadata", async () => {
		const seenRequests: ModelRequest[] = [];
		let createCount = 0;
		const factory: ModelClientFactory = {
			createClient(model) {
				createCount += 1;
				return fakeClient(model.model, seenRequests);
			},
		};
		const modelClient = new RoutingModelClient(new DeterministicModelRouter(), factory);
		const routedAgent = withRouting({ aliases: { small: { provider: "openai", model: "small-model" } }, routes: { "memory-extraction": "small" } });
		const originalRequest = request(routedAgent, "memory-extraction");

		const first = await modelClient.complete(originalRequest);
		const second = await modelClient.complete(originalRequest);

		expect(first.text).toBe("small-model");
		expect(second.metadata?.routing).toEqual({ purpose: "memory-extraction", alias: "small", provider: "openai", model: "small-model" });
		expect(seenRequests).toHaveLength(2);
		expect(seenRequests[0]?.agent.model).toEqual({ provider: "openai", model: "small-model" });
		expect(originalRequest.agent.model).toEqual({ provider: "openai", model: "default-model" });
		expect(createCount).toBe(1);
	});
});

function request(baseAgent: AgentSpec, purpose?: ModelRequest["purpose"]): ModelRequest {
	return {
		agent: baseAgent,
		task,
		messages: [{ role: "user", content: "hi" }],
		turn: 1,
		...(purpose ? { purpose } : {}),
	};
}

function withRouting(modelRouting: ModelRoutingSpec): AgentSpec {
	return { ...agent, modelRouting };
}

function fakeClient(text: string, seenRequests: ModelRequest[]): ModelClient {
	return {
		async complete(request) {
			seenRequests.push(request);
			return { text, metadata: { providerText: text } };
		},
	};
}
