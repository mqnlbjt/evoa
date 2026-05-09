import type { ModelPurpose } from "./models/types.js";

export type AgentSpecKind = "baseline" | "candidate";
export type TaskType = "coding" | "tool" | "general" | "business";

export interface ModelSpec {
	provider: string;
	model: string;
	reasoningLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	options?: Record<string, unknown>;
}

export interface ModelRoutingSpec {
	aliases?: Record<string, ModelSpec>;
	routes?: Partial<Record<ModelPurpose, string>>;
	defaultAlias?: string;
	purposeRules?: {
		codingTasks?: boolean;
		toolHeavy?: boolean;
	};
}

export interface PromptSpec {
	system: string;
	planner?: string;
	critic?: string;
}

export interface ToolPolicySpec {
	allowedTools: string[];
	deniedTools?: string[];
	permissionMode?: "allow" | "ask" | "deny";
	maxToolCalls?: number;
}

export interface TimeBasedMicroCompactSpec {
	enabled?: boolean;
	gapThresholdMinutes?: number;
	keepRecent?: number;
}

export interface MicroCompactSpec {
	enabled?: boolean;
	compactableToolNames?: string[];
	keepRecentTools?: number;
	timeBased?: TimeBasedMicroCompactSpec;
}

export interface ContextCollapseSpec {
	enabled?: boolean;
	preserveRecentTurns?: number;
}

export interface ContextBudgetSpec {
	maxInputTokens?: number;
	reserveTokens?: number;
	keepRecentTokens?: number;
	triggerRatio?: number;
	summaryMaxTokens?: number;
	maxCompactionsPerRun?: number;
	maxConsecutiveCompactionFailures?: number;
	failureMode?: "continue" | "error";
	microCompact?: MicroCompactSpec;
	contextCollapse?: ContextCollapseSpec;
	iterativeSummary?: boolean;
}

export interface ToolOutputBudgetSpec {
	maxBytes?: number;
	strategy?: "head-tail" | "head-only";
	headBytes?: number;
	tailBytes?: number;
	includeMetadata?: boolean;
	perTool?: Record<string, Omit<ToolOutputBudgetSpec, "perTool">>;
}

export interface RuntimePolicySpec {
	maxTurns?: number;
	tokenBudget?: number;
	timeoutMs?: number;
	contextCompression?: "off" | "auto";
	contextBudget?: ContextBudgetSpec;
	toolOutputBudget?: ToolOutputBudgetSpec;
	memoryPolicy?: "none" | "session" | "long-term";
}

export interface AgentSpec {
	id: string;
	version: string;
	name: string;
	kind: AgentSpecKind;
	model: ModelSpec;
	modelRouting?: ModelRoutingSpec;
	prompts: PromptSpec;
	tools: ToolPolicySpec;
	runtime: RuntimePolicySpec;
	metadata?: Record<string, unknown>;
}

export type SubagentRole = "planner" | "critic" | "verifier" | "tool-specialist";

export interface SubagentSpec {
	id: string;
	role: SubagentRole;
	agent: AgentSpec;
	trigger?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export interface TaskFixture {
	path: string;
	content: string;
}

export interface TaskScoringSpec {
	method: "exact" | "rubric" | "command" | "custom" | "llm-judge";
	maxScore?: number;
	config?: Record<string, unknown>;
}

export interface TaskSpec {
	id: string;
	type: TaskType;
	title: string;
	prompt: string;
	allowedTools?: string[];
	fixtures?: TaskFixture[];
	timeoutMs?: number;
	scoring: TaskScoringSpec;
	expectedArtifacts?: string[];
	metadata?: Record<string, unknown>;
}
