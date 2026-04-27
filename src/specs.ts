export type AgentSpecKind = "baseline" | "candidate";
export type TaskType = "coding" | "tool" | "general" | "business";

export interface ModelSpec {
	provider: string;
	model: string;
	reasoningLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	options?: Record<string, unknown>;
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

export interface RuntimePolicySpec {
	maxTurns: number;
	timeoutMs?: number;
	contextCompression?: "off" | "auto";
	memoryPolicy?: "none" | "session" | "long-term";
}

export interface AgentSpec {
	id: string;
	version: string;
	name: string;
	kind: AgentSpecKind;
	model: ModelSpec;
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
