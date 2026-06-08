export type ProviderFormat = "openai-responses" | "openai-chat" | "anthropic-messages";

export interface ProviderConfig {
	id: string;
	baseURL: string;
	format: ProviderFormat;
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface ModelConfig {
	id: string;
	providerId: string;
	format: ProviderFormat;
	baseURL?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	inputTypes?: string[];
	metadata?: Record<string, unknown>;
}
