import type { AgentSpec, TaskSpec } from "../specs.js";

export interface ModelMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
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
}

export interface ModelResponse {
	text?: string;
	toolCalls?: ModelToolCall[];
	metadata?: Record<string, unknown>;
}

export interface ModelClient {
	complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
