import type { AgentSpec, TaskSpec } from "../specs.js";

export type ModelContentBlock =
	| { type: "text"; text: string }
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
	tools?: ModelToolDefinition[];
}

export interface ModelResponse {
	text?: string;
	toolCalls?: ModelToolCall[];
	metadata?: Record<string, unknown>;
}

export interface ModelClient {
	complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
