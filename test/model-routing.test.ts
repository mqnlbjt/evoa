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
	it("keeps configured provider format when CLI did not pass --provider-format", () => {
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
			format: "anthropic-messages",
			headers: { "x-configured": "yes" },
		}]);
		expect(registry.listModels()).toEqual([expect.objectContaining({ id: "cli-model", providerId: "openai", format: "anthropic-messages" })]);
	});

	it("prefers CLI --provider-format when explicitly passed for chat commands", () => {
		const command: ModelRoutedCommand = {
			kind: "chat",
			format: "json",
			provider: "openai",
			model: "cli-model",
			baseURL: "https://cli.example/v1",
			apiKey: "cli-key",
			providerFormat: "openai-chat",
			toolProfile: "read-only",
			providedFlags: { providerFormat: true },
			providers: {
				openai: { id: "openai", baseURL: "https://configured.example/v1", apiKey: "configured-key", format: "anthropic-messages" },
			},
		};

		const effectiveAgent = effectiveAgentForCommand(agent, command);
		const registry = createRoutedModelRegistry(command, {}, effectiveAgent);

		expect(registry.listProviders()).toEqual([expect.objectContaining({ format: "openai-chat" })]);
		expect(registry.listModels()).toEqual([expect.objectContaining({ id: "cli-model", providerId: "openai", format: "openai-chat" })]);
	});
});
