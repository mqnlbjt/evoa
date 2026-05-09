import type { ModelRoutingSpec, ModelSpec } from "../specs.js";
import type { ProviderConfig, ProviderFormat } from "../models/provider-types.js";
import type { ModelClient } from "../models/types.js";
import { ModelRegistry, type ModelRegistryOptions } from "../models/registry.js";
import { DeterministicModelRouter, RegistryModelClientFactory, RoutingModelClient } from "../models/router.js";
import { memoryToolNames } from "../memory/tools.js";
import type { AgentSpec } from "../specs.js";
import type { BenchmarkCommand, ChatCommand, EvolveCommand, RunCommand } from "./args.js";

export interface ModelRoutingDeps {
	fetchFn?: typeof fetch;
	openAIClientFactory?: ModelRegistryOptions["openAIClientFactory"];
}

export type ModelRoutedCommand = (ChatCommand | RunCommand | BenchmarkCommand | EvolveCommand) & {
	provider: string;
	model: string;
	baseURL: string;
};

export function effectiveAgentForCommand(agent: AgentSpec, command: ModelRoutedCommand): AgentSpec {
	const baseModel = commandModel(agent.model, command);
	const modelRouting = effectiveModelRouting(agent.modelRouting, command.modelRouting, baseModel);
	return {
		...agent,
		model: baseModel,
		...(modelRouting ? { modelRouting } : {}),
		tools: effectiveTools(agent),
	};
}

export function createRoutedModelClient(command: ModelRoutedCommand, deps: ModelRoutingDeps, agent: AgentSpec): ModelClient {
	const registry = createRoutedModelRegistry(command, deps, agent);
	return new RoutingModelClient(new DeterministicModelRouter(), new RegistryModelClientFactory(registry));
}

export function createRoutedModelRegistry(command: ModelRoutedCommand, deps: ModelRoutingDeps, agent: AgentSpec): ModelRegistry {
	const registry = new ModelRegistry({
		...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
		...(deps.openAIClientFactory ? { openAIClientFactory: deps.openAIClientFactory } : {}),
	});
	for (const provider of providerConfigs(command)) registry.registerProvider(provider);
	for (const model of routedModels(agent)) registerModel(registry, command, model);
	return registry;
}

function effectiveModelRouting(agentRouting: ModelRoutingSpec | undefined, commandRouting: ModelRoutingSpec | undefined, baseModel: ModelSpec): ModelRoutingSpec | undefined {
	const aliases = { ...agentRouting?.aliases, ...commandRouting?.aliases, default: baseModel };
	return {
		aliases,
		...(agentRouting?.routes || commandRouting?.routes ? { routes: { ...agentRouting?.routes, ...commandRouting?.routes } } : {}),
		...(agentRouting?.defaultAlias !== undefined ? { defaultAlias: agentRouting.defaultAlias } : {}),
		...(commandRouting?.defaultAlias !== undefined ? { defaultAlias: commandRouting.defaultAlias } : {}),
		...(agentRouting?.purposeRules || commandRouting?.purposeRules ? { purposeRules: { ...agentRouting?.purposeRules, ...commandRouting?.purposeRules } } : {}),
	};
}

function providerConfigs(command: ModelRoutedCommand): ProviderConfig[] {
	const providers = command.providers ? Object.values(command.providers) : [];
	const hasPrimary = providers.some((provider) => provider.id === command.provider);
	return hasPrimary ? providers.map((provider) => provider.id === command.provider ? mergePrimaryProvider(provider, command) : provider) : [primaryProvider(command), ...providers];
}

function primaryProvider(command: ModelRoutedCommand): ProviderConfig {
	return {
		id: command.provider,
		baseURL: command.baseURL,
		format: command.providerFormat,
		...(command.apiKey ? { apiKey: command.apiKey } : {}),
	};
}

function mergePrimaryProvider(provider: ProviderConfig, command: ModelRoutedCommand): ProviderConfig {
	return {
		...provider,
		id: command.provider,
		baseURL: command.baseURL,
		format: command.providerFormat,
		...(command.apiKey ? { apiKey: command.apiKey } : provider.apiKey ? { apiKey: provider.apiKey } : {}),
	};
}

function routedModels(agent: AgentSpec): ModelSpec[] {
	return [agent.model, ...Object.values(agent.modelRouting?.aliases ?? {})];
}

function registerModel(registry: ModelRegistry, command: ModelRoutedCommand, model: ModelSpec): void {
	const maxOutputTokens = typeof model.options?.maxTokens === "number" ? model.options.maxTokens : undefined;
	registry.registerModel(model.provider, {
		id: model.model,
		providerId: model.provider,
		format: providerFormat(command, model.provider),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	});
}

function providerFormat(command: ModelRoutedCommand, providerId: string): ProviderFormat {
	if (providerId === command.provider) return command.providerFormat;
	return command.providers?.[providerId]?.format ?? command.providerFormat;
}

function commandModel(baseModel: ModelSpec, command: ModelRoutedCommand): ModelSpec {
	return {
		...baseModel,
		provider: command.provider,
		model: command.model,
	};
}

function effectiveTools(agent: AgentSpec): AgentSpec["tools"] {
	if (agent.runtime.memoryPolicy !== "long-term") return agent.tools;
	return { ...agent.tools, allowedTools: [...new Set([...agent.tools.allowedTools, ...memoryToolNames])] };
}
