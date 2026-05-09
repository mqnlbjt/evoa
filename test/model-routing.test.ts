import { describe, expect, it } from "vitest";
import { createRoutedModelRegistry, effectiveAgentForCommand, type ModelRoutedCommand } from "../src/cli/model-routing.js";
import type { AgentSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "openai", model: "default-model" },
	prompts: { system: "system" },
	tools: { allowedTools: [] },
	runtime: { maxTurns: 1 },
};

describe("CLI model routing", () => {
	it("merges primary provider command overrides into configured providers", () => {
		const command: ModelRoutedCommand = {
			kind: "run",
			format: "json",
			agentPath: "agent.json",
			taskPath: "task.json",
			provider: "openai",
			model: "cli-model",
			baseURL: "https://cli.example/v1",
			apiKey: "cli-key",
			providerFormat: "openai-responses",
			toolProfile: "read-only",
			providers: {
				openai: { id: "openai", baseURL: "https://configured.example/v1", apiKey: "configured-key", format: "anthropic-messages", headers: { "x-configured": "yes" } },
			},
		};

		const effectiveAgent = effectiveAgentForCommand(agent, command);
		const registry = createRoutedModelRegistry(command, {}, effectiveAgent);

		expect(registry.listProviders()).toEqual([{
			id: "openai",
			baseURL: "https://cli.example/v1",
			apiKey: "cli-key",
			format: "openai-responses",
			headers: { "x-configured": "yes" },
		}]);
		expect(registry.listModels()).toEqual([expect.objectContaining({ id: "cli-model", providerId: "openai", format: "openai-responses" })]);
	});
});
