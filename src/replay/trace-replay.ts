import type { AgentTaskRunResult, SuiteRunResult } from "../benchmark/types.js";
import type { EvolutionComparison } from "../evolution/types.js";
import type { TraceEvent } from "../runtime/events.js";
import type { TraceReplayInput, TraceReplaySource, TraceReplaySummary } from "./types.js";

export function replayTrace(input: TraceReplayInput): TraceReplaySummary {
	const warnings: string[] = [];
	const trace = [...input.trace].sort((left, right) => left.timestamp - right.timestamp);
	const toolCalls = new Set<string>();
	const toolResults = new Set<string>();
	let modelRequestCount = 0;
	let modelResponseCount = 0;
	let toolCallCount = 0;
	let toolResultCount = 0;
	let errorCount = 0;
	let hasRunStart = false;
	let hasTerminalEvent = false;
	let previousTimestamp: number | undefined;

	for (const event of input.trace) {
		if (previousTimestamp !== undefined && event.timestamp < previousTimestamp) warnings.push(`event ${event.id} timestamp is out of order`);
		previousTimestamp = event.timestamp;
	}

	for (const event of trace) {
		if (input.agentId && event.agentId !== input.agentId) warnings.push(`event ${event.id} has unexpected agentId ${event.agentId}`);
		if (input.taskId && event.taskId !== input.taskId) warnings.push(`event ${event.id} has unexpected taskId ${event.taskId}`);
		if (event.type === "run_start") hasRunStart = true;
		if (event.type === "run_end" || event.type === "error") hasTerminalEvent = true;
		if (event.type === "model_request") modelRequestCount += 1;
		if (event.type === "model_response") modelResponseCount += 1;
		if (event.type === "tool_call") {
			toolCallCount += 1;
			toolCalls.add(callId(event));
		}
		if (event.type === "tool_result") {
			toolResultCount += 1;
			toolResults.add(callId(event));
		}
		if (event.type === "error") errorCount += 1;
	}

	for (const id of toolCalls) {
		if (!toolResults.has(id)) warnings.push(`tool_call ${id} has no matching tool_result`);
	}
	if (!hasRunStart && trace.length > 0) warnings.push("trace has no run_start event");
	if (!hasTerminalEvent && trace.length > 0) warnings.push("trace has no run_end or error event");

	return {
		...(input.runId ? { runId: input.runId } : {}),
		...(input.agentId ? { agentId: input.agentId } : {}),
		...(input.taskId ? { taskId: input.taskId } : {}),
		...(input.status ? { status: input.status } : {}),
		...(input.score ? { score: input.score } : {}),
		...(input.kind ? { kind: input.kind } : {}),
		...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
		...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
		...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
		...(input.subagentId ? { subagentId: input.subagentId } : {}),
		eventCount: input.trace.length,
		modelRequestCount,
		modelResponseCount,
		toolCallCount,
		toolResultCount,
		errorCount,
		warnings,
	};
}

export function extractReplayInputs(value: TraceReplaySource | unknown): TraceReplayInput[] {
	if (isTraceEvents(value)) return [{ trace: value, kind: "main" }, ...subagentInputs(value)];
	if (isAgentTaskRunResult(value)) return expandRun(value);
	if (isSuiteRunResult(value)) return value.runs.flatMap(expandRun);
	if (isEvolutionComparison(value)) return [...value.baseline.runs.flatMap(expandRun), ...value.candidate.runs.flatMap(expandRun)];
	return [];
}

export function replayTraceSource(value: TraceReplaySource | unknown, options: { runId?: string } = {}): TraceReplaySummary[] {
	const inputs = extractReplayInputs(value).filter((input) => !options.runId || input.runId === options.runId);
	return inputs.map(replayTrace);
}

function expandRun(run: AgentTaskRunResult): TraceReplayInput[] {
	const main = fromRun(run);
	return [main, ...subagentInputs(run.trace, run.runId)];
}

function fromRun(run: AgentTaskRunResult): TraceReplayInput {
	return {
		runId: run.runId,
		agentId: run.agent.id,
		taskId: run.task.id,
		status: run.status,
		score: run.score,
		trace: run.trace,
		kind: "main",
	};
}

function subagentInputs(trace: TraceEvent[], parentRunId?: string): TraceReplayInput[] {
	return trace.flatMap((event) => {
		if (event.type !== "tool_result") return [];
		const output = toolResultOutput(event);
		if (!isSubagentOutput(output)) return [];
		return [{
			runId: `${parentRunId ?? "trace"}::subagent::${output.subagentId}::${output.parentToolCallId ?? event.parentToolCallId ?? callId(event)}`,
			agentId: output.agentId,
			taskId: output.taskId,
			...(output.status === "errored" ? { status: "errored" as const } : {}),
			trace: output.trace,
			kind: "subagent" as const,
			...(parentRunId ? { parentRunId } : {}),
			...(output.parentSessionId ? { parentSessionId: output.parentSessionId } : event.parentSessionId ? { parentSessionId: event.parentSessionId } : {}),
			...(output.parentToolCallId ? { parentToolCallId: output.parentToolCallId } : event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
			subagentId: output.subagentId,
		}];
	});
}

function isAgentTaskRunResult(value: unknown): value is AgentTaskRunResult {
	return isRecord(value) && typeof value.runId === "string" && isRecord(value.agent) && isRecord(value.task) && Array.isArray(value.trace);
}

function isSuiteRunResult(value: unknown): value is SuiteRunResult {
	return isRecord(value) && Array.isArray(value.runs) && isRecord(value.suite) && isRecord(value.agent);
}

function isEvolutionComparison(value: unknown): value is EvolutionComparison {
	return isRecord(value) && isSuiteRunResult(value.baseline) && isSuiteRunResult(value.candidate);
}

function isTraceEvents(value: unknown): value is TraceEvent[] {
	return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.type === "string" && typeof item.timestamp === "number");
}

function callId(event: TraceEvent): string {
	const payload = isRecord(event.payload) ? event.payload : {};
	const id = payload.callId ?? payload.call_id ?? payload.id ?? event.id;
	if (typeof id === "string") return id;
	const call = isRecord(payload.call) ? payload.call : undefined;
	return typeof call?.id === "string" ? call.id : event.id;
}

function toolResultOutput(event: TraceEvent): unknown {
	const payload = isRecord(event.payload) ? event.payload : {};
	return payload.output;
}

function isSubagentOutput(value: unknown): value is {
	subagentId: string;
	agentId: string;
	taskId: string;
	status: "completed" | "errored";
	trace: TraceEvent[];
	parentSessionId?: string;
	parentToolCallId?: string;
} {
	return isRecord(value)
		&& typeof value.subagentId === "string"
		&& typeof value.agentId === "string"
		&& typeof value.taskId === "string"
		&& (value.status === "completed" || value.status === "errored")
		&& isTraceEvents(value.trace);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
