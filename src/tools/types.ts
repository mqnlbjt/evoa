export type ToolRiskLevel = "low" | "medium" | "high";
export type ToolPermissionDecision = "allow" | "deny" | "ask";
export type ToolConcurrency = "sequential" | "parallel-safe";

export interface ToolPermissionPolicy {
	defaultDecision: ToolPermissionDecision;
	riskLevel: ToolRiskLevel;
	requiresSandbox?: boolean;
}

export interface EvolvingAgentTool<TInput = unknown, TOutput = unknown> {
	name: string;
	description: string;
	inputSchema?: unknown;
	permission: ToolPermissionPolicy;
	concurrency: ToolConcurrency;
	metadata?: Record<string, unknown>;
	execute(input: TInput, signal?: AbortSignal): Promise<TOutput>;
}
