import type { BenchmarkSummary, ScoreResult, SuiteRunResult } from "./types.js";
import type { TraceEvent } from "../runtime/events.js";

export type BenchmarkReportFormat = "json" | "markdown";

export interface BenchmarkReportOptions {
	includeTrace?: boolean;
	generatedAt?: string;
}

export interface BenchmarkReport {
	version: 1;
	generatedAt: string;
	suite: {
		id: string;
		name: string;
		description?: string;
		taskCount: number;
	};
	agent: {
		id: string;
		version: string;
		name: string;
		kind: string;
	};
	summary: BenchmarkSummary;
	tasks: BenchmarkTaskReport[];
}

export interface BenchmarkTaskReport {
	runId: string;
	taskId: string;
	title: string;
	type: string;
	status: string;
	score: ScoreResult;
	durationMs: number;
	startedAt: string;
	endedAt: string;
	errorMessage?: string;
	trace?: TraceEvent[];
	subagentTraces?: BenchmarkSubagentTraceReport[];
}

export interface BenchmarkSubagentTraceReport {
	subagentId: string;
	agentId?: string;
	taskId?: string;
	parentToolCallId?: string;
	eventCount: number;
	toolCallCount: number;
	errorCount: number;
	trace?: TraceEvent[];
}

export function createBenchmarkReport(result: SuiteRunResult, options: BenchmarkReportOptions = {}): BenchmarkReport {
	return {
		version: 1,
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		suite: {
			id: result.suite.id,
			name: result.suite.name,
			...(result.suite.description ? { description: result.suite.description } : {}),
			taskCount: result.suite.tasks.length,
		},
		agent: {
			id: result.agent.id,
			version: result.agent.version,
			name: result.agent.name,
			kind: result.agent.kind,
		},
		summary: result.summary,
		tasks: result.runs.map((run) => {
			const subagentTraces = extractSubagentTraceReports(run.trace, options);
			return {
			runId: run.runId,
			taskId: run.task.id,
			title: run.task.title,
			type: run.task.type,
			status: run.status,
			score: run.score,
			durationMs: run.durationMs,
			startedAt: new Date(run.startedAt).toISOString(),
			endedAt: new Date(run.endedAt).toISOString(),
			...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
			...(options.includeTrace ? { trace: run.trace } : {}),
			...(subagentTraces.length > 0 ? { subagentTraces } : {}),
		};
		}),
	};
}

export function formatBenchmarkReportMarkdown(report: BenchmarkReport): string {
	const lines = [
		`# Benchmark Report: ${escapeMarkdown(report.suite.name)}`,
		"",
		`Generated: ${report.generatedAt}`,
		"",
		"## Suite",
		"",
		`- ID: \`${report.suite.id}\``,
		`- Tasks: ${report.suite.taskCount}`,
		...(report.suite.description ? [`- Description: ${escapeMarkdown(report.suite.description)}`] : []),
		"",
		"## Agent",
		"",
		`- ID: \`${report.agent.id}\``,
		`- Name: ${escapeMarkdown(report.agent.name)}`,
		`- Version: \`${report.agent.version}\``,
		`- Kind: \`${report.agent.kind}\``,
		"",
		"## Summary",
		"",
		`- Tasks: ${report.summary.passedTasks} passed, ${report.summary.failedTasks} failed, ${report.summary.erroredTasks} errored, ${report.summary.timeoutTasks} timeout`,
		`- Pass rate: ${formatPercent(report.summary.passRate)}`,
		`- Score: ${report.summary.totalScore}/${report.summary.maxScore}`,
		`- Average score: ${formatNumber(report.summary.averageScore)}`,
		`- Duration: ${report.summary.totalDurationMs}ms`,
		"",
		"## Tasks",
		"",
		"| Task | Type | Status | Score | Duration | Reason |",
		"| --- | --- | --- | ---: | ---: | --- |",
		...report.tasks.map((task) => `| ${escapeTable(task.taskId)} | ${escapeTable(task.type)} | ${escapeTable(task.status)} | ${task.score.score}/${task.score.maxScore} | ${task.durationMs}ms | ${escapeTable(task.score.reason)} |`),
	];
	const subagentRows = report.tasks.flatMap((task) => (task.subagentTraces ?? []).map((trace) => [task.taskId, trace.subagentId, String(trace.eventCount), String(trace.toolCallCount), String(trace.errorCount)]));
	if (subagentRows.length > 0) {
		lines.push("", "## Subagent Traces", "", "| Task | Subagent | Events | Tool Calls | Errors |", "| --- | --- | ---: | ---: | ---: |",
			...subagentRows.map((row) => `| ${escapeTable(row[0]!)} | ${escapeTable(row[1]!)} | ${row[2]} | ${row[3]} | ${row[4]} |`));
	}
	const failures = report.tasks.filter((task) => task.errorMessage || task.status === "errored" || task.status === "timeout");
	if (failures.length > 0) {
		lines.push("", "## Errors", "");
		for (const task of failures) {
			lines.push(`- \`${task.taskId}\`: ${escapeMarkdown(task.errorMessage ?? task.score.reason)}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function extractSubagentTraceReports(trace: TraceEvent[], options: BenchmarkReportOptions): BenchmarkSubagentTraceReport[] {
	return trace.flatMap((event) => {
		if (event.type !== "tool_result") return [];
		const output = toolResultOutput(event);
		if (!isSubagentOutput(output)) return [];
		return [{
			subagentId: output.subagentId,
			agentId: output.agentId,
			taskId: output.taskId,
			...(output.parentToolCallId ? { parentToolCallId: output.parentToolCallId } : event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
			eventCount: output.trace.length,
			toolCallCount: output.trace.filter((traceEvent) => traceEvent.type === "tool_call").length,
			errorCount: output.trace.filter((traceEvent) => traceEvent.type === "error").length,
			...(options.includeTrace ? { trace: output.trace } : {}),
		}];
	});
}

function toolResultOutput(event: TraceEvent): unknown {
	const payload = isRecord(event.payload) ? event.payload : {};
	return payload.output;
}

function isSubagentOutput(value: unknown): value is { subagentId: string; agentId: string; taskId: string; trace: TraceEvent[]; parentToolCallId?: string } {
	return isRecord(value)
		&& typeof value.subagentId === "string"
		&& typeof value.agentId === "string"
		&& typeof value.taskId === "string"
		&& isTraceEvents(value.trace);
}

function isTraceEvents(value: unknown): value is TraceEvent[] {
	return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.type === "string" && typeof item.timestamp === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatPercent(value: number): string {
	return `${formatNumber(value * 100)}%`;
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function escapeMarkdown(value: string): string {
	return value.replace(/[\\`*_{}[\]()#+\-.!|]/g, "\\$&");
}

function escapeTable(value: string): string {
	return escapeMarkdown(value).replace(/\r?\n/g, "<br>");
}
