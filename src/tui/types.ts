import type { TraceEvent } from "../runtime/events.js";
import type { TuiStatsSnapshot } from "./stats.js";

export type TuiStatus = "idle" | "thinking" | "running_tool" | "done" | "error";
export type TuiView = "chat" | "stats" | "trace";
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

export interface TuiStateOptions {
	agentName: string;
	agentId: string;
	model: string;
	provider: string;
	toolProfile: string;
	mcpServerCount?: number;
	cwd: string;
	sessionId: string;
	maxToolCalls?: number;
	maxLogEntries?: number;
	maxTraceEvents?: number;
	now?: () => number;
	createId?: () => string;
}

export interface ContextUsage {
	tokenEstimate: number;
	budgetMaxTokens: number;
	effectiveLimit: number;
	usageFraction: number;
}

export interface TuiStateSnapshot extends Omit<TuiStateOptions, "now" | "createId" | "mcpServerCount"> {
	mcpServerCount: number;
	status: TuiStatus;
	turnCount: number;
	toolCallCount: number;
	runningToolName?: string;
	runStartedAt?: number;
	runDurationMs?: number;
	toolDurationMs: number;
	mcpDurationMs: number;
	skillDurationMs: number;
	lastError?: string;
	activeView: TuiView;
	stats: TuiStatsSnapshot;
	log: ChatLogEntry[];
	runningTools: RunningToolEntry[];
	trace: TraceEvent[];
	contextUsage?: ContextUsage;
}

export interface RenderContext {
	width: number;
	height: number;
	now: number;
	logScrollOffset?: number;
	viewScrollOffset?: number;
	inputBlocked?: boolean;
}

export interface Component {
	render(context: RenderContext): string[];
}
