import type { CacheRetention, ModelRequest } from "./types.js";

export interface AnthropicCacheControl {
	type: "ephemeral";
	ttl?: "1h";
}

export interface OpenAIPromptCacheParams {
	prompt_cache_key?: string;
	prompt_cache_retention?: "24h";
}

export function resolveCacheRetention(request: ModelRequest): CacheRetention {
	return cacheRetentionValue(request.cacheRetention) ?? cacheRetentionValue(request.agent.model.options?.cacheRetention) ?? "short";
}

export function anthropicCacheControl(retention: CacheRetention, baseURL?: string): AnthropicCacheControl | undefined {
	if (retention === "none" || !isOfficialAnthropicBaseURL(baseURL)) return undefined;
	return {
		type: "ephemeral",
		...(retention === "long" ? { ttl: "1h" as const } : {}),
	};
}

export function openAIPromptCacheParams(sessionId: string | undefined, retention: CacheRetention, baseURL?: string): OpenAIPromptCacheParams {
	if (!sessionId || retention === "none" || !isOfficialOpenAIBaseURL(baseURL)) return {};
	return {
		prompt_cache_key: sessionId,
		...(retention === "long" ? { prompt_cache_retention: "24h" as const } : {}),
	};
}

export function isOfficialAnthropicBaseURL(baseURL?: string): boolean {
	return officialHost(baseURL, "api.anthropic.com", "https://api.anthropic.com/v1");
}

export function isOfficialOpenAIBaseURL(baseURL?: string): boolean {
	return officialHost(baseURL, "api.openai.com", "https://api.openai.com/v1");
}

function cacheRetentionValue(value: unknown): CacheRetention | undefined {
	return value === "none" || value === "short" || value === "long" ? value : undefined;
}

function officialHost(baseURL: string | undefined, host: string, fallback: string): boolean {
	try {
		return new URL(baseURL ?? fallback).host === host;
	} catch {
		return false;
	}
}
