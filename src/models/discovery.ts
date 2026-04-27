import type { ModelConfig, ProviderFormat } from "./provider-types.js";

export interface DiscoverOpenAICompatibleModelsOptions {
	providerId: string;
	baseURL: string;
	apiKey?: string;
	headers?: Record<string, string>;
	format?: ProviderFormat;
	fetchFn?: typeof fetch;
}

interface OpenAIModelsResponse {
	data?: unknown;
	error?: { message?: string };
}

interface OpenAIModelEntry {
	id?: unknown;
	object?: unknown;
	created?: unknown;
	owned_by?: unknown;
}

interface NormalizedOpenAIModelsURL {
	apiRoot: string;
	modelsURL: string;
}

export async function discoverOpenAICompatibleModels(
	options: DiscoverOpenAICompatibleModelsOptions,
	signal?: AbortSignal,
): Promise<ModelConfig[]> {
	if (!options.providerId.trim()) {
		throw new Error("providerId is required for OpenAI-compatible model discovery");
	}
	if (!options.baseURL.trim()) {
		throw new Error("baseURL is required for OpenAI-compatible model discovery");
	}

	const { apiRoot, modelsURL } = normalizeOpenAIModelsURL(options.baseURL);
	const response = await (options.fetchFn ?? fetch)(modelsURL, {
		method: "GET",
		headers: {
			accept: "application/json",
			...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
			...options.headers,
		},
		...(signal ? { signal } : {}),
	});
	const body = (await response.json()) as OpenAIModelsResponse;

	if (!response.ok) {
		throw new Error(body.error?.message ?? `OpenAI-compatible model discovery failed with status ${response.status}`);
	}
	if (!body || typeof body !== "object" || !Array.isArray(body.data)) {
		throw new Error("OpenAI-compatible model discovery response must contain a data array");
	}

	return body.data.map((entry, index) => mapOpenAIModelEntry(entry, index, options.providerId, options.format ?? "openai-responses", apiRoot));
}

function normalizeOpenAIModelsURL(baseURL: string): NormalizedOpenAIModelsURL {
	const normalized = baseURL.replace(/\/+$/, "");
	if (normalized.endsWith("/v1/models")) {
		return { apiRoot: normalized.slice(0, -"/models".length), modelsURL: normalized };
	}
	if (normalized.endsWith("/models")) {
		return { apiRoot: normalized.slice(0, -"/models".length), modelsURL: normalized };
	}
	if (normalized.endsWith("/v1")) {
		return { apiRoot: normalized, modelsURL: `${normalized}/models` };
	}
	return { apiRoot: `${normalized}/v1`, modelsURL: `${normalized}/v1/models` };
}

function mapOpenAIModelEntry(
	entry: unknown,
	index: number,
	providerId: string,
	format: ProviderFormat,
	baseURL: string,
): ModelConfig {
	if (!entry || typeof entry !== "object") {
		throw new Error(`OpenAI-compatible model entry at index ${index} must be an object`);
	}

	const model = entry as OpenAIModelEntry;
	if (typeof model.id !== "string" || !model.id.trim()) {
		throw new Error(`OpenAI-compatible model entry at index ${index} must contain a string id`);
	}

	const config: ModelConfig = {
		id: model.id,
		providerId,
		format,
		baseURL,
		metadata: { raw: entry },
	};
	if (typeof model.created === "number") {
		config.metadata = { ...config.metadata, created: model.created };
	}
	if (typeof model.owned_by === "string") {
		config.metadata = { ...config.metadata, ownedBy: model.owned_by };
	}

	return config;
}
