import type { AgentSession } from "../runtime/session.js";
import type { ToolCall } from "./registry.js";

export type ToolRiskLevel = "low" | "medium" | "high";
export type ToolPermissionDecision = "allow" | "deny" | "ask";
export type ToolConcurrency = "sequential" | "parallel-safe";

export interface ToolPermissionPolicy {
	defaultDecision: ToolPermissionDecision;
	riskLevel: ToolRiskLevel;
	requiresSandbox?: boolean;
}

export interface ToolExecutionContext {
	session: AgentSession;
	call: ToolCall;
}

export interface EvolvingAgentTool<TInput = unknown, TOutput = unknown> {
	name: string;
	description: string;
	inputSchema?: unknown;
	permission: ToolPermissionPolicy;
	concurrency: ToolConcurrency;
	timeoutMs?: number;
	maxResultBytes?: number;
	metadata?: Record<string, unknown>;
	execute(input: TInput, signal?: AbortSignal, context?: ToolExecutionContext): Promise<TOutput>;
}
