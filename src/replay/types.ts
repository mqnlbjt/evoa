import type { AgentTaskRunResult, ScoreResult, SuiteRunResult } from "../benchmark/types.js";
import type { EvolutionComparison } from "../evolution/types.js";
import type { TraceEvent } from "../runtime/events.js";

export type TraceReplaySource = AgentTaskRunResult | SuiteRunResult | EvolutionComparison | TraceEvent[];

export interface TraceReplayInput {
	runId?: string;
	agentId?: string;
	taskId?: string;
	status?: AgentTaskRunResult["status"];
	score?: ScoreResult;
	trace: TraceEvent[];
	kind?: "main" | "subagent";
	parentRunId?: string;
	parentSessionId?: string;
	parentToolCallId?: string;
	subagentId?: string;
}

export interface TraceReplaySummary {
	runId?: string;
	agentId?: string;
	taskId?: string;
	status?: AgentTaskRunResult["status"];
	score?: ScoreResult;
	kind?: "main" | "subagent";
	parentRunId?: string;
	parentSessionId?: string;
	parentToolCallId?: string;
	subagentId?: string;
	eventCount: number;
	modelRequestCount: number;
	modelResponseCount: number;
	toolCallCount: number;
	toolResultCount: number;
	errorCount: number;
	memoryContextCount: number;
	memoryWarningCount: number;
	warnings: string[];
}

export interface RunDiffSummary {
	leftRunId?: string;
	rightRunId?: string;
	taskId?: string;
	statusChanged: boolean;
	leftStatus?: AgentTaskRunResult["status"];
	rightStatus?: AgentTaskRunResult["status"];
	scoreDelta?: number;
	durationDeltaMs?: number;
	eventCountDelta: number;
	toolCallCountDelta: number;
	errorCountDelta: number;
	classification: "improvement" | "regression" | "unchanged";
}

export interface SuiteDiffSummary {
	leftSuiteId?: string;
	rightSuiteId?: string;
	taskDiffs: RunDiffSummary[];
	improvements: string[];
	regressions: string[];
	unchanged: string[];
	missingLeft: string[];
	missingRight: string[];
}
