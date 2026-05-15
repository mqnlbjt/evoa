import type { ModelSpec } from "../specs.js";
import type { ModelContentBlock, ModelToolCall } from "./types.js";

export type ReasoningRetentionPolicy = "never" | "needed" | "always";
export type ReasoningProviderStyle = "openai-responses" | "deepseek" | "anthropic" | "chat-compatible";
export type ReasoningRequestField = "reasoning" | "reasoning_effort" | "extra_body.reasoning_effort" | "extra_body.thinking";

export interface ReasoningPolicy {
	enabled: boolean;
	level?: NonNullable<ModelSpec["reasoningLevel"]>;
	returnContent: ReasoningRetentionPolicy;
	sendHistory: ReasoningRetentionPolicy;
	providerStyle: ReasoningProviderStyle;
	requestField?: ReasoningRequestField;
	effort: string;
	thinkingType: "enabled" | "adaptive";
}

export function resolveReasoningPolicy(model: ModelSpec, defaultStyle: ReasoningProviderStyle): ReasoningPolicy {
	const options = objectRecord(model.options);
	const reasoning = objectRecord(options.reasoning);
	const provider = objectRecord(reasoning.provider);
	const mode = stringField(reasoning, "mode");
	const level = model.reasoningLevel;
	const enabled = mode !== "off" && level !== undefined && level !== "off";
	const providerStyle = reasoningProviderStyle(stringField(provider, "style"), defaultStyle);
	const requestField = reasoningRequestField(stringField(provider, "requestField"), providerStyle);
	return {
		enabled,
		...(level ? { level } : {}),
		returnContent: retentionPolicy(stringField(reasoning, "returnContent"), "needed"),
		sendHistory: retentionPolicy(stringField(reasoning, "sendHistory"), "needed"),
		providerStyle,
		...(requestField ? { requestField } : {}),
		effort: stringField(provider, "effort") ?? mappedEffort(level, providerStyle),
		thinkingType: thinkingType(stringField(provider, "thinkingType"), providerStyle),
	};
}

export function shouldReturnReasoning(policy: ReasoningPolicy, toolCalls: ModelToolCall[]): boolean {
	if (!policy.enabled || policy.returnContent === "never") return false;
	if (policy.returnContent === "always") return true;
	return toolCalls.length > 0 || policy.providerStyle === "deepseek" || policy.providerStyle === "chat-compatible";
}

export function shouldSendReasoningHistory(policy: ReasoningPolicy, toolCalls: Array<Extract<ModelContentBlock, { type: "tool_call" }>>): boolean {
	if (!policy.enabled || policy.sendHistory === "never") return false;
	if (policy.sendHistory === "always") return true;
	return toolCalls.length > 0 && (policy.providerStyle === "deepseek" || policy.providerStyle === "chat-compatible");
}

export function reasoningFormat(policy: ReasoningPolicy): Extract<ModelContentBlock, { type: "reasoning" }>["format"] {
	if (policy.providerStyle === "anthropic") return "anthropic-thinking";
	if (policy.providerStyle === "deepseek" || policy.providerStyle === "chat-compatible") return "openai-reasoning-content";
	return "summary";
}

function mappedEffort(level: ModelSpec["reasoningLevel"], providerStyle: ReasoningProviderStyle): string {
	if (!level || level === "off") return "";
	if (providerStyle === "deepseek") return level === "xhigh" ? "max" : "high";
	return level === "xhigh" ? "high" : level;
}

function retentionPolicy(value: string | undefined, fallback: ReasoningRetentionPolicy): ReasoningRetentionPolicy {
	return value === "never" || value === "needed" || value === "always" ? value : fallback;
}

function reasoningProviderStyle(value: string | undefined, fallback: ReasoningProviderStyle): ReasoningProviderStyle {
	return value === "openai-responses" || value === "deepseek" || value === "anthropic" || value === "chat-compatible" ? value : fallback;
}

function reasoningRequestField(value: string | undefined, providerStyle: ReasoningProviderStyle): ReasoningRequestField | undefined {
	if (value === "reasoning" || value === "reasoning_effort" || value === "extra_body.reasoning_effort" || value === "extra_body.thinking") return value;
	if (providerStyle === "deepseek") return "extra_body.thinking";
	if (providerStyle === "chat-compatible") return "reasoning_effort";
	return providerStyle === "openai-responses" ? "reasoning" : undefined;
}

function thinkingType(value: string | undefined, providerStyle: ReasoningProviderStyle): "enabled" | "adaptive" {
	if (value === "enabled" || value === "adaptive") return value;
	return providerStyle === "anthropic" ? "adaptive" : "enabled";
}

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
	const item = value[key];
	return typeof item === "string" ? item : undefined;
}
