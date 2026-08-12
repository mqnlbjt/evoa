// 与后端 src/web/types.ts、src/web/server.ts 对齐的前端类型（手工同步）。

export type ChatStatus = "idle" | "thinking" | "running_tool" | "done" | "error";
export type ChatView = "chat" | "stats" | "trace" | "evolve";
export type ChatLogKind = "user" | "assistant" | "tool_call" | "tool_result" | "system" | "error" | "score";
export type ChatLogSeverity = "info" | "success" | "warning" | "error";

export interface ChatLogEntry {
	id: string;
	kind: ChatLogKind;
	timestamp: number;
	text: string;
	collapsed?: boolean;
	severity?: ChatLogSeverity;
	toolCallId?: string;
	toolName?: string;
	raw?: unknown;
}

export interface RunningToolEntry {
	id: string;
	name: string;
	input?: unknown;
	startedAt: number;
	status: "queued" | "running";
}

export interface ContextUsage {
	tokenEstimate: number;
	budgetMaxTokens: number;
	effectiveLimit: number;
	usageFraction: number;
}

export interface TokenStats {
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd?: number;
}

export interface LatencySummary {
	count: number;
	totalMs: number;
	avgMs?: number;
	minMs?: number;
	maxMs?: number;
	p50Ms?: number;
	p95Ms?: number;
	p99Ms?: number;
}

export interface ToolStatusStats {
	success: number;
	error: number;
	denied: number;
	unknown: number;
	limit_exceeded: number;
	timeout: number;
}

export interface ToolNameStats {
	name: string;
	count: number;
	totalDurationMs: number;
	avgDurationMs?: number;
	maxDurationMs?: number;
	errors: number;
	inputBytes: number;
	outputBytes: number;
}

export interface ModelTurnUsageSnapshot {
	turn: number;
	purpose: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	source: string;
	messageCount: number;
}

export interface StatsSnapshot {
	overview: {
		eventCount: number;
		turnCount: number;
		lastError?: string;
	};
	runs: {
		count: number;
		passed: number;
		failed: number;
		errored: number;
		timeout: number;
		currentStartedAt?: number;
		currentDurationMs?: number;
		totalDurationMs: number;
		avgDurationMs?: number;
	};
	model: {
		requestCount: number;
		responseCount: number;
		assistantDeltaCount: number;
		tokens: TokenStats;
		latency: LatencySummary;
		ttftMs?: number;
		outputTokensPerSecond?: number;
		recentRequestId?: string;
		recentStopReason?: string;
		turnUsageHistory: ModelTurnUsageSnapshot[];
		latestTurnUsage?: ModelTurnUsageSnapshot;
		compactionCount: number;
		contextTokens?: number;
		contextView?: { tokenEstimate: number; budgetMaxTokens: number; effectiveLimit: number; usageFraction: number };
	};
	tools: {
		callCount: number;
		resultCount: number;
		statuses: ToolStatusStats;
		totalDurationMs: number;
		avgDurationMs?: number;
		maxDurationMs?: number;
		mcpCount: number;
		mcpDurationMs: number;
		skillCount: number;
		skillDurationMs: number;
		memory: Record<string, number>;
	};
	scores: {
		count: number;
		passed: number;
		avgRatio?: number;
		latestRatio?: number;
	};
	errors: {
		count: number;
		latest?: string;
	};
	topToolsByCount: ToolNameStats[];
	topToolsByDuration: ToolNameStats[];
}

export interface TraceEvent {
	id: string;
	type: string;
	timestamp: number;
	agentId: string;
	taskId: string;
	payload: unknown;
	sessionId?: string;
	parentSessionId?: string;
	parentToolCallId?: string;
	subagentId?: string;
}

export interface EvolutionHistoryRecord {
	type: "evolution_comparison";
	version: 1;
	timestamp: string;
	suiteId: string;
	baselineAgent: { id: string; name?: string };
	candidateAgent: { id: string; name?: string };
	candidate?: {
		id: string;
		kind: string;
		parentAgentId: string;
		description: string;
		patch?: string;
		metadata?: Record<string, unknown>;
	};
	baselineRunIds: string[];
	candidateRunIds: string[];
	deltaScore: number;
	deltaPassRate: number;
	regressions: string[];
	improvements: string[];
	recommendation: string;
	metadata?: Record<string, unknown>;
}

export interface SessionSummary {
	id: string;
	agentId: string;
	createdAt: number;
	updatedAt: number;
	preview: string;
}

export interface ChatStateSnapshot {
	agentName: string;
	agentId: string;
	model: string;
	provider: string;
	toolProfile: string;
	mcpServerCount: number;
	cwd: string;
	sessionId: string;
	maxToolCalls?: number;
	status: ChatStatus;
	turnCount: number;
	toolCallCount: number;
	runningToolName?: string;
	runStartedAt?: number;
	runDurationMs?: number;
	toolDurationMs: number;
	mcpDurationMs: number;
	skillDurationMs: number;
	lastError?: string;
	activeView: ChatView;
	stats: StatsSnapshot;
	log: ChatLogEntry[];
	runningTools: RunningToolEntry[];
	trace: TraceEvent[];
	contextUsage?: ContextUsage;
	evolutionHistory: EvolutionHistoryRecord[];
}

export type ServerToClientMessage =
	| { type: "snapshot"; snapshot: ChatStateSnapshot }
	| { type: "system"; message: string }
	| { type: "sessions"; sessions: SessionSummary[] };

export type ClientToServerMessage =
	| { type: "submit"; input: string }
	| { type: "slash"; input: string }
	| { type: "interrupt" }
	| { type: "new_session" }
	| { type: "resume"; sessionId: string }
	| { type: "list_sessions" };
