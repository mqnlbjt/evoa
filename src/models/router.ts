import type { AgentSpec, ModelRoutingSpec, ModelSpec } from "../specs.js";
import type { ModelClient, ModelPurpose, ModelRequest, ModelResponse } from "./types.js";
import type { ModelRegistry } from "./registry.js";

export interface ResolvedModelRoute {
	purpose: ModelPurpose;
	alias: string;
	model: ModelSpec;
}

export interface ModelRouter {
	resolve(request: ModelRequest): ResolvedModelRoute;
}

export interface ModelClientFactory {
	createClient(model: ModelSpec): ModelClient;
}

export interface DeterministicModelRouterOptions {
	routing?: ModelRoutingSpec;
}

export class DeterministicModelRouter implements ModelRouter {
	constructor(private readonly options: DeterministicModelRouterOptions = {}) {}

	resolve(request: ModelRequest): ResolvedModelRoute {
		const purpose = request.purpose ?? "main";
		const routing = mergeRouting(request.agent.modelRouting, this.options.routing);
		const aliases = routing.aliases ?? {};
		const routeAlias = routing.routes?.[purpose] ?? routing.defaultAlias ?? "default";
		const aliasModel = aliases[routeAlias];
		if (aliasModel) return { purpose, alias: routeAlias, model: copyModel(aliasModel) };
		if (routeAlias === "default") return { purpose, alias: routeAlias, model: copyModel(request.agent.model) };
		throw new Error(`Model route for purpose ${purpose} references missing alias ${routeAlias}`);
	}
}

export class RegistryModelClientFactory implements ModelClientFactory {
	constructor(private readonly registry: ModelRegistry) {}

	createClient(model: ModelSpec): ModelClient {
		return this.registry.createClient(model.provider, model.model);
	}
}

export class RoutingModelClient implements ModelClient {
	private readonly clients = new Map<string, ModelClient>();

	constructor(private readonly router: ModelRouter, private readonly factory: ModelClientFactory) {}

	async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
		const route = this.router.resolve(request);
		const client = this.clientFor(route.model);
		const response = await client.complete(routedRequest(request, route.model), signal);
		return {
			...response,
			metadata: {
				...response.metadata,
				routing: {
					purpose: route.purpose,
					alias: route.alias,
					provider: route.model.provider,
					model: route.model.model,
				},
			},
		};
	}

	private clientFor(model: ModelSpec): ModelClient {
		const key = `${model.provider}:${model.model}`;
		const existing = this.clients.get(key);
		if (existing) return existing;
		const client = this.factory.createClient(model);
		this.clients.set(key, client);
		return client;
	}
}

function routedRequest(request: ModelRequest, model: ModelSpec): ModelRequest {
	return {
		...request,
		agent: routedAgent(request.agent, model),
	};
}

function routedAgent(agent: AgentSpec, model: ModelSpec): AgentSpec {
	return {
		...agent,
		model: copyModel(model),
	};
}

function mergeRouting(agentRouting: ModelRoutingSpec | undefined, overrideRouting: ModelRoutingSpec | undefined): ModelRoutingSpec {
	return {
		...(agentRouting?.aliases || overrideRouting?.aliases ? { aliases: { ...agentRouting?.aliases, ...overrideRouting?.aliases } } : {}),
		...(agentRouting?.routes || overrideRouting?.routes ? { routes: { ...agentRouting?.routes, ...overrideRouting?.routes } } : {}),
		...(agentRouting?.defaultAlias !== undefined ? { defaultAlias: agentRouting.defaultAlias } : {}),
		...(overrideRouting?.defaultAlias !== undefined ? { defaultAlias: overrideRouting.defaultAlias } : {}),
		...(agentRouting?.purposeRules || overrideRouting?.purposeRules ? { purposeRules: { ...agentRouting?.purposeRules, ...overrideRouting?.purposeRules } } : {}),
	};
}

function copyModel(model: ModelSpec): ModelSpec {
	return {
		provider: model.provider,
		model: model.model,
		...(model.reasoningLevel !== undefined ? { reasoningLevel: model.reasoningLevel } : {}),
		...(model.options ? { options: { ...model.options } } : {}),
	};
}
