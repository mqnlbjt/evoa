import type { AgentTaskRunResult, SuiteRunResult } from "../benchmark/types.js";
import type { RunDiffSummary, SuiteDiffSummary } from "./types.js";

export function diffTaskRuns(left: AgentTaskRunResult, right: AgentTaskRunResult): RunDiffSummary {
	const scoreDelta = right.score.score - left.score.score;
	const summary: RunDiffSummary = {
		leftRunId: left.runId,
		rightRunId: right.runId,
		taskId: left.task.id,
		statusChanged: left.status !== right.status,
		leftStatus: left.status,
		rightStatus: right.status,
		scoreDelta,
		durationDeltaMs: right.durationMs - left.durationMs,
		eventCountDelta: right.trace.length - left.trace.length,
		toolCallCountDelta: countEvents(right, "tool_call") - countEvents(left, "tool_call"),
		errorCountDelta: countEvents(right, "error") - countEvents(left, "error"),
		classification: classify(left.status === "passed", right.status === "passed", scoreDelta),
	};
	return summary;
}

export function diffSuiteRuns(left: SuiteRunResult, right: SuiteRunResult): SuiteDiffSummary {
	const leftRuns = new Map(left.runs.map((run) => [run.task.id, run]));
	const rightRuns = new Map(right.runs.map((run) => [run.task.id, run]));
	const taskIds = [...new Set([...leftRuns.keys(), ...rightRuns.keys()])].sort();
	const taskDiffs: RunDiffSummary[] = [];
	const missingLeft: string[] = [];
	const missingRight: string[] = [];

	for (const taskId of taskIds) {
		const leftRun = leftRuns.get(taskId);
		const rightRun = rightRuns.get(taskId);
		if (!leftRun) {
			missingLeft.push(taskId);
			continue;
		}
		if (!rightRun) {
			missingRight.push(taskId);
			continue;
		}
		taskDiffs.push(diffTaskRuns(leftRun, rightRun));
	}

	return {
		leftSuiteId: left.suite.id,
		rightSuiteId: right.suite.id,
		taskDiffs,
		improvements: taskDiffs.filter((diff) => diff.classification === "improvement" && diff.taskId).map((diff) => diff.taskId as string),
		regressions: taskDiffs.filter((diff) => diff.classification === "regression" && diff.taskId).map((diff) => diff.taskId as string),
		unchanged: taskDiffs.filter((diff) => diff.classification === "unchanged" && diff.taskId).map((diff) => diff.taskId as string),
		missingLeft,
		missingRight,
	};
}

export function diffRunSources(left: unknown, right: unknown): RunDiffSummary | SuiteDiffSummary {
	if (isAgentTaskRunResult(left) && isAgentTaskRunResult(right)) return diffTaskRuns(left, right);
	if (isSuiteRunResult(left) && isSuiteRunResult(right)) return diffSuiteRuns(left, right);
	throw new Error("diff inputs must both be task run results or both be suite run results");
}

function classify(leftPassed: boolean, rightPassed: boolean, scoreDelta: number): RunDiffSummary["classification"] {
	if (!leftPassed && rightPassed) return "improvement";
	if (leftPassed && !rightPassed) return "regression";
	if (scoreDelta > 0) return "improvement";
	if (scoreDelta < 0) return "regression";
	return "unchanged";
}

function countEvents(run: AgentTaskRunResult, type: string): number {
	return run.trace.filter((event) => event.type === type).length;
}

function isAgentTaskRunResult(value: unknown): value is AgentTaskRunResult {
	return isRecord(value) && typeof value.runId === "string" && isRecord(value.agent) && isRecord(value.task) && Array.isArray(value.trace);
}

function isSuiteRunResult(value: unknown): value is SuiteRunResult {
	return isRecord(value) && Array.isArray(value.runs) && isRecord(value.suite) && isRecord(value.agent);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
