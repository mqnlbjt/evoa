import type { AgentSpec, TaskSpec } from "../specs.js";

export type TraceEventType =
	| "run_start"
	| "run_end"
	| "model_request"
	| "model_response"
	| "response_truncated"
	| "assistant_delta"
	| "context_view"
	| "context_compaction"
	| "context_trim"
	| "micro_compact"
	| "time_based_micro_compact"
	| "context_collapse"
	| "context_transform"
	| "post_compact_restore"
	| "session_memory_update"
	| "cache_break"
	| "budget_depleted"
	| "diminishing_returns"
	| "follow_up"
	| "tool_call"
	| "tool_result"
	| "score"
	| "interrupted"
	| "error";

export type TraceEvent =
	| TraceEventBase<"run_start", RunStartPayload>
	| TraceEventBase<"run_end", RunEndPayload>
	| TraceEventBase<"model_request", Record<string, unknown>>
	| TraceEventBase<"model_response", Record<string, unknown>>
	| TraceEventBase<"response_truncated", ResponseTruncatedPayload>
	| TraceEventBase<"assistant_delta", Record<string, unknown>>
	| TraceEventBase<"context_view", ContextViewPayload>
	| TraceEventBase<"context_compaction", ContextCompactionPayload>
	| TraceEventBase<"context_trim", ContextTrimPayload>
	| TraceEventBase<"micro_compact", MicroCompactPayload>
	| TraceEventBase<"time_based_micro_compact", TimeBasedMicroCompactPayload>
	| TraceEventBase<"context_collapse", ContextCollapsePayload>
	| TraceEventBase<"context_transform", ContextTransformPayload>
	| TraceEventBase<"post_compact_restore", PostCompactRestorePayload>
	| TraceEventBase<"session_memory_update", SessionMemoryUpdatePayload>
	| TraceEventBase<"cache_break", CacheBreakPayload>
	| TraceEventBase<"budget_depleted", BudgetDepletedPayload>
	| TraceEventBase<"diminishing_returns", DiminishingReturnsPayload>
	| TraceEventBase<"follow_up", FollowUpPayload>
	| TraceEventBase<"tool_call", Record<string, unknown>>
	| TraceEventBase<"tool_result", ToolResultPayload>
	| TraceEventBase<"score", ScorePayload>
	| TraceEventBase<"interrupted", InterruptedPayload>
	| TraceEventBase<"error", Record<string, unknown>>;

export interface TraceEventBase<TType extends TraceEventType, TPayload = unknown> {
	id: string;
	type: TType;
	timestamp: number;
	agentId: string;
	taskId: string;
	payload: TPayload;
	sessionId?: string;
	parentSessionId?: string;
	parentToolCallId?: string;
	subagentId?: string;
}

export type TraceEventObserver = (event: TraceEvent) => void | Promise<void>;

export interface RunStartPayload {
	agent: AgentSpec;
	task: TaskSpec;
}

export interface RunEndPayload {
	status: "passed" | "failed" | "errored" | "timeout" | "interrupted";
	durationMs: number;
}

export interface InterruptedPayload {
	reason: "cancelled" | "user_interrupt" | "parent_abort";
	message?: string;
}

export interface ScorePayload {
	score: number;
	maxScore: number;
	passed: boolean;
}

export interface ContextViewPayload {
	tokenEstimate: number;
	budgetMaxTokens: number;
	budgetReserveTokens: number;
	effectiveLimit: number;
	usageFraction: number;
}

export interface ContextCompactionPayload {
	compacted: boolean;
	reason: "budget_exceeded" | "skipped" | "failed" | "circuit_breaker";
	tokenEstimateBefore: number;
	tokenEstimateAfter?: number;
	entryId?: string;
	sourceEntryCount?: number;
	keptRecentEntryCount?: number;
	failure?: string;
	overBudgetAfterCompaction?: boolean;
	needsTrim?: boolean;
	durationMs?: number;
	summaryTokens?: number;
	inputTokens?: number;
	ptlRetry?: { attempts: number; entriesDropped: number };
}

export interface ContextTrimPayload {
	reason: "within_budget" | "hard_trim" | "aggressive_trim" | "fallback_minimal" | "system_only" | "system_truncated" | "untrimmable";
	tokenEstimateBefore: number;
	tokenEstimateAfter: number;
	trimmedEntryIds: string[];
	keptEntryIds: string[];
	fallbackChain?: string[];
}

export interface MicroCompactPayload {
	compacted: boolean;
	toolsCleared: number;
	toolsKept: number;
	errorsPreserved: number;
	tokenEstimateBefore: number;
	tokenEstimateAfter: number;
	overBudgetAfter: boolean;
}

export interface TimeBasedMicroCompactPayload {
	cleared: boolean;
	toolsCleared: number;
	gapMinutes: number;
}

export interface ContextCollapsePayload {
	collapsed: boolean;
	collapsedEntries: number;
	tokenEstimateBefore: number;
	tokenEstimateAfter: number;
}

export interface ContextTransformPayload {
	messageCount: number;
}

export interface PostCompactRestorePayload {
	restoredFiles: string[];
	messageCount: number;
}

export interface SessionMemoryUpdatePayload {
	addedCount: number;
	totalCount: number;
	sessionId?: string;
}

export interface CacheBreakPayload {
	broken: boolean;
	reason: "content_changed" | "cache_evicted" | "none";
	previousCacheReadTokens?: number;
	currentCacheReadTokens?: number;
	turn: number;
}

export interface BudgetDepletedPayload {
	consumedTokens: number;
	totalBudget: number;
	turn: number;
}

export interface DiminishingReturnsPayload {
	noToolCallStreak: number;
	turn: number;
}

export interface FollowUpPayload {
	turn: number;
	messageCount: number;
	messagesPreview: string[];
}

export interface ResponseTruncatedPayload {
	reason: string;
	textLength: number;
}

export interface ToolResultPayload {
	call: { id: string; name: string; input?: unknown };
	decision?: { decision?: string; reason?: string };
	status: string;
	output?: unknown;
	errorMessage?: string;
	errorCategory?: string;
	errorSource?: string;
	errorPhase?: string;
	retryable?: boolean;
	rawErrorName?: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	metadata?: {
		entryId?: string;
		toolOutput?: ToolOutputTruncationMeta;
		[rest: string]: unknown;
	};
	visibleContentPreview: string;
}

export interface ToolOutputTruncationMeta {
	truncated: boolean;
	strategy: string;
	originalBytes: number;
	visibleBytes: number;
	maxBytes: number;
	headBytes?: number;
	tailBytes?: number;
	omittedBytes?: number;
}
