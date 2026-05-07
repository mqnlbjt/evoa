import type { AgentSpec, TaskSpec } from "../specs.js";

export type ModelPurpose = "main" | "memory-extraction" | "summary" | "compaction" | "verification" | "evolution" | "coding" | "tool-heavy";
export type CacheRetention = "none" | "short" | "long";

export interface ModelRoutingHints {
	inputTokenEstimate?: number;
	toolRiskLevel?: "low" | "medium" | "high";
	toolCount?: number;
	preferCache?: boolean;
	allowUpgrade?: boolean;
}

export type ModelContentBlock =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "tool_call"; id: string; name: string; input?: unknown }
	| { type: "tool_result"; toolCallId: string; toolName?: string; content: string; isError?: boolean };

export interface ModelMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	contentBlocks?: ModelContentBlock[];
	toolCallId?: string;
	toolName?: string;
}

export interface ModelToolDefinition {
	name: string;
	description: string;
	inputSchema?: unknown;
}

export interface ModelToolCall {
	id: string;
	name: string;
	input?: unknown;
}

export interface ModelRequest {
	agent: AgentSpec;
	task: TaskSpec;
	messages: ModelMessage[];
	turn: number;
	purpose?: ModelPurpose;
	routing?: ModelRoutingHints;
	sessionId?: string;
	cacheRetention?: CacheRetention;
	tools?: ModelToolDefinition[];
}

export interface ModelUsage {
	inputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	costUsd?: number;
}

export interface ModelTiming {
	startedAt: number;
	endedAt: number;
	durationMs: number;
	ttftMs?: number;
}

export interface ModelResponse {
	text?: string;
	reasoning?: string;
	toolCalls?: ModelToolCall[];
	usage?: ModelUsage;
	timing?: ModelTiming;
	requestId?: string;
	metadata?: Record<string, unknown>;
}

export interface ModelClient {
	complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
