import { AnthropicModelClient } from "./anthropic-client.js";
import { discoverOpenAICompatibleModels } from "./discovery.js";
import { OpenAIChatModelClient } from "./openai-chat-client.js";
import { OpenAIModelClient, type OpenAIResponsesClient } from "./openai-client.js";
import type { ModelClient } from "./types.js";
import type { ModelConfig, ProviderConfig, ProviderFormat } from "./provider-types.js";

export interface OpenAIClientFactoryOptions {
	apiKey?: string;
	baseURL?: string;
	defaultHeaders?: Record<string, string>;
}

export interface ModelRegistryOptions {
	fetchFn?: typeof fetch;
	openAIClientFactory?: (options: OpenAIClientFactoryOptions) => OpenAIResponsesClient;
}

export class ModelRegistry {
	private readonly providers = new Map<string, ProviderConfig>();
	private readonly models = new Map<string, ModelConfig>();

	constructor(private readonly options: ModelRegistryOptions = {}) {}

	registerProvider(provider: ProviderConfig): void {
		assertNonEmpty(provider.id, "provider id");
		assertNonEmpty(provider.baseURL, "provider baseURL");
		assertSupportedFormat(provider.format);
		this.providers.set(provider.id, copyProvider(provider));
	}

	async discover(providerId: string, signal?: AbortSignal): Promise<ModelConfig[]> {
		const provider = this.requireProvider(providerId);
		if (provider.format !== "openai-responses") {
			throw new Error(`Model discovery is not supported for provider format ${provider.format}`);
		}

		const discovered = await discoverOpenAICompatibleModels(
			{
				providerId: provider.id,
				baseURL: provider.baseURL,
				format: provider.format,
				...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
				...(provider.headers ? { headers: provider.headers } : {}),
				...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
			},
			signal,
		);
		for (const model of discovered) {
			this.registerModel(provider.id, model);
		}
		return discovered.map(copyModel);
	}

	registerModel(providerId: string, model: ModelConfig): void {
		this.requireProvider(providerId);
		assertNonEmpty(model.id, "model id");
		assertNonEmpty(model.providerId, "model providerId");
		if (model.providerId !== providerId) {
			throw new Error(`Model providerId ${model.providerId} does not match provider ${providerId}`);
		}
		assertSupportedFormat(model.format);
		this.models.set(modelKey(providerId, model.id), copyModel(model));
	}

	listProviders(): ProviderConfig[] {
		return Array.from(this.providers.values()).map(copyProvider);
	}

	listModels(providerId?: string): ModelConfig[] {
		return Array.from(this.models.values())
			.filter((model) => providerId === undefined || model.providerId === providerId)
			.map(copyModel);
	}

	getModel(providerId: string, modelId: string): ModelConfig | undefined {
		const model = this.models.get(modelKey(providerId, modelId));
		return model ? copyModel(model) : undefined;
	}

	createClient(providerId: string, modelId: string): ModelClient {
		const provider = this.requireProvider(providerId);
		const model = this.models.get(modelKey(providerId, modelId));
		if (!model) {
			throw new Error(`Model ${modelId} is not registered for provider ${providerId}`);
		}
		if (provider.format !== model.format) {
			throw new Error(`Provider format ${provider.format} does not match model format ${model.format}`);
		}

		if (provider.format === "openai-responses") {
			const factoryOptions = buildOpenAIClientFactoryOptions(provider);
			return new OpenAIModelClient({
				...factoryOptions,
				...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
				...(this.options.openAIClientFactory ? { client: this.options.openAIClientFactory(factoryOptions) } : {}),
			});
		}

		if (provider.format === "openai-chat") {
			return new OpenAIChatModelClient({
				...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
				baseURL: provider.baseURL,
				...(provider.headers ? { defaultHeaders: { ...provider.headers } } : {}),
				...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
				...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
			});
		}

		return new AnthropicModelClient({
			...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
			baseURL: provider.baseURL,
			...(provider.headers ? { headers: provider.headers } : {}),
			...(model.maxOutputTokens !== undefined ? { maxTokens: model.maxOutputTokens } : {}),
			...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
		});
	}

	private requireProvider(providerId: string): ProviderConfig {
		const provider = this.providers.get(providerId);
		if (!provider) {
			throw new Error(`Provider ${providerId} is not registered`);
		}
		return provider;
	}
}

function buildOpenAIClientFactoryOptions(provider: ProviderConfig): OpenAIClientFactoryOptions {
	const options: OpenAIClientFactoryOptions = { baseURL: provider.baseURL };
	if (provider.apiKey) {
		options.apiKey = provider.apiKey;
	}
	if (provider.headers) {
		options.defaultHeaders = { ...provider.headers };
	}
	return options;
}

function modelKey(providerId: string, modelId: string): string {
	return `${providerId}:${modelId}`;
}

function assertNonEmpty(value: string, label: string): void {
	if (!value.trim()) {
		throw new Error(`${label} is required`);
	}
}

function assertSupportedFormat(format: ProviderFormat): void {
	if (format !== "openai-responses" && format !== "openai-chat" && format !== "anthropic-messages") {
		throw new Error(`Unsupported provider format ${String(format)}`);
	}
}

function copyProvider(provider: ProviderConfig): ProviderConfig {
	return {
		id: provider.id,
		baseURL: provider.baseURL,
		format: provider.format,
		...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
		...(provider.headers ? { headers: { ...provider.headers } } : {}),
	};
}

function copyModel(model: ModelConfig): ModelConfig {
	return {
		id: model.id,
		providerId: model.providerId,
		format: model.format,
		...(model.baseURL ? { baseURL: model.baseURL } : {}),
		...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
		...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
		...(model.inputTypes ? { inputTypes: [...model.inputTypes] } : {}),
		...(model.metadata ? { metadata: { ...model.metadata } } : {}),
	};
}
