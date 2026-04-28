import type { AgentSpec, TaskSpec } from "../specs.js";

export type TraceEventType =
	| "run_start"
	| "run_end"
	| "model_request"
	| "model_response"
	| "assistant_delta"
	| "tool_call"
	| "tool_result"
	| "score"
	| "error";

export interface TraceEvent<TPayload = unknown> {
	id: string;
	type: TraceEventType;
	timestamp: number;
	agentId: string;
	taskId: string;
	payload: TPayload;
	sessionId?: string;
	parentSessionId?: string;
	parentToolCallId?: string;
	subagentId?: string;
}

export interface RunStartPayload {
	agent: AgentSpec;
	task: TaskSpec;
}

export interface RunEndPayload {
	status: "passed" | "failed" | "errored" | "timeout";
	durationMs: number;
}

export interface ScorePayload {
	score: number;
	maxScore: number;
	passed: boolean;
}
