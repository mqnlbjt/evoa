import { renderMarkdown } from "./markdown.js";
import type { RenderContext, TuiStateSnapshot } from "./types.js";
import type { InputEditor } from "./input-editor.js";
import { truncateDisplayWidth, wrapDisplayWidth } from "./text-width.js";

export function renderTui(
	snapshot: TuiStateSnapshot,
	input: InputEditor,
	context: RenderContext,
): string {
	const lines = [
		...renderHeader(snapshot, context.width),
		...renderBody(snapshot, context),
		...renderRunning(snapshot, context.width),
		...renderFooter(snapshot, context),
		input.renderPrompt(context.width),
	];
	return lines.map((line) => truncate(line, context.width)).join("\n");
}

function renderHeader(snapshot: TuiStateSnapshot, width: number): string[] {
	const mcpLabel =
		snapshot.mcpServerCount > 0 ? ` | mcp: ${snapshot.mcpServerCount}` : "";
	return [
		truncate(
			`evoa | ${snapshot.agentName} (${snapshot.agentId}) | model: ${snapshot.provider}/${snapshot.model} | profile: ${snapshot.toolProfile}${mcpLabel}`,
			width,
		),
		truncate(`session: ${snapshot.sessionId} | cwd: ${snapshot.cwd}`, width),
		separator(width),
	];
}

function renderBody(
	snapshot: TuiStateSnapshot,
	context: RenderContext,
): string[] {
	if (snapshot.activeView === "stats")
		return renderScrollable(
			renderStatsView(snapshot),
			context,
			context.viewScrollOffset ?? 0,
		);
	if (snapshot.activeView === "trace")
		return renderScrollable(
			renderTraceView(snapshot),
			context,
			context.viewScrollOffset ?? 0,
		);
	if (snapshot.activeView === "evolve")
		return renderScrollable(
			renderEvolveView(snapshot),
			context,
			context.viewScrollOffset ?? 0,
		);
	return renderLog(snapshot, context);
}

function renderLog(
	snapshot: TuiStateSnapshot,
	context: RenderContext,
): string[] {
	const maxLines = bodyMaxLines(snapshot, context);
	const blocks = renderLogBlocks(
		renderLogPages(snapshot, context.width),
		maxLines,
	);
	const offset = clamp(
		context.logScrollOffset ?? 0,
		0,
		Math.max(0, blocks.length - 1),
	);
	return blocks[blocks.length - 1 - offset] ?? [];
}

function renderScrollable(
	lines: string[],
	context: RenderContext,
	offset: number,
): string[] {
	const maxLines = bodyMaxLines(undefined, context);
	const maxOffset = Math.max(0, lines.length - maxLines);
	const normalizedOffset = clamp(offset, 0, maxOffset);
	return lines.slice(normalizedOffset, normalizedOffset + maxLines);
}

function bodyMaxLines(
	snapshot: TuiStateSnapshot | undefined,
	context: RenderContext,
): number {
	const reserved = 7 + (snapshot?.runningTools.length ?? 0);
	return Math.max(3, context.height - reserved);
}

function renderLogPages(snapshot: TuiStateSnapshot, width: number): string[][] {
	const pages: string[][] = [];
	for (const entry of snapshot.log) {
		if (entry.kind === "user" || pages.length === 0) pages.push([]);
		pages[pages.length - 1]?.push(
			...renderEntry(entry.kind, entry.text, width),
		);
	}
	return pages.length === 0 ? [[]] : pages;
}

function renderLogBlocks(pages: string[][], maxLines: number): string[][] {
	const blocks: string[][] = [];
	for (const page of pages) {
		const pageBlocks: string[][] = [];
		for (let end = page.length; end > 0; end -= maxLines)
			pageBlocks.unshift(page.slice(Math.max(0, end - maxLines), end));
		blocks.push(...(pageBlocks.length === 0 ? [[]] : pageBlocks));
	}
	return blocks.length === 0 ? [[]] : blocks;
}

function renderStatsView(snapshot: TuiStateSnapshot): string[] {
	const stats = snapshot.stats;
	return [
		"STATS OVERVIEW",
		[
			`runs: ${stats.runs.count}`,
			`turns: ${stats.overview.turnCount}`,
			`events: ${stats.overview.eventCount}`,
			`errors: ${stats.errors.count}`,
			`duration: ${formatMs(stats.runs.totalDurationMs)}`,
		].join(" | "),
		"",
		"TOKENS",
		[
			`input: ${stats.model.tokens.inputTokens}`,
			`output: ${stats.model.tokens.outputTokens}`,
			`reasoning: ${stats.model.tokens.reasoningTokens}`,
			`cache read: ${stats.model.tokens.cacheReadTokens}`,
			`cache write: ${stats.model.tokens.cacheWriteTokens}`,
			`total: ${stats.model.tokens.totalTokens}`,
			`cost: ${formatCost(stats.model.tokens.costUsd)}`,
		].join(" | "),
		...(stats.model.latestTurnUsage
			? [
					`latest turn #${stats.model.latestTurnUsage.turn} (${stats.model.latestTurnUsage.purpose}/${stats.model.latestTurnUsage.source}): in=${stats.model.latestTurnUsage.inputTokens} out=${stats.model.latestTurnUsage.outputTokens} total=${stats.model.latestTurnUsage.totalTokens}`,
				]
			: []),
		...(stats.model.contextView
			? [
					`context usage: ${formatTokenCount(stats.model.contextView.tokenEstimate)}/${formatTokenCount(stats.model.contextView.budgetMaxTokens)} (${(stats.model.contextView.usageFraction * 100).toFixed(1)}%)`,
				]
			: []),
		"",
		"MODEL LATENCY",
		[
			`calls: ${stats.model.responseCount}`,
			`avg: ${formatOptionalMs(stats.model.latency.avgMs)}`,
			`min: ${formatOptionalMs(stats.model.latency.minMs)}`,
			`max: ${formatOptionalMs(stats.model.latency.maxMs)}`,
			`p50: ${formatOptionalMs(stats.model.latency.p50Ms)}`,
			`p95: ${formatOptionalMs(stats.model.latency.p95Ms)}`,
			`p99: ${formatOptionalMs(stats.model.latency.p99Ms)}`,
			`tok/s: ${formatRate(stats.model.outputTokensPerSecond)}`,
			`ttft: ${formatOptionalMs(stats.model.ttftMs)}`,
		].join(" | "),
		"",
		"TOOLS",
		...Object.entries(stats.tools.statuses).map(
			([status, count]) => `${status}: ${count}`,
		),
		[
			`total: ${formatMs(stats.tools.totalDurationMs)}`,
			`avg: ${formatOptionalMs(stats.tools.avgDurationMs)}`,
			`max: ${formatOptionalMs(stats.tools.maxDurationMs)}`,
			`mcp: ${stats.tools.mcpCount}/${formatMs(stats.tools.mcpDurationMs)}`,
			`skill: ${stats.tools.skillCount}/${formatMs(stats.tools.skillDurationMs)}`,
		].join(" | "),
		"",
		"TOP TOOLS BY DURATION",
		...toolRows(stats.topToolsByDuration),
		"",
		"SCORES",
		[
			`count: ${stats.scores.count}`,
			`passed: ${stats.scores.passed}`,
			`avg: ${formatPercent(stats.scores.avgRatio)}`,
			`latest: ${formatPercent(stats.scores.latestRatio)}`,
		].join(" | "),
		...(stats.errors.latest ? ["", `LAST ERROR: ${stats.errors.latest}`] : []),
	];
}

function renderTraceView(snapshot: TuiStateSnapshot): string[] {
	return [
		"TRACE EVENTS",
		"TYPE | ID | SUMMARY",
		...snapshot.trace
			.slice(-50)
			.map((event) =>
				[event.type, event.id, summarizeTracePayload(event.payload)].join(
					" | ",
				),
			),
	];
}

function renderEvolveView(snapshot: TuiStateSnapshot): string[] {
	const records = snapshot.evolutionHistory;
	if (records.length === 0)
		return [
			"EVOLUTION HISTORY",
			"No records loaded. Use /evolve-history <path> to load.",
		];
	const prefix = [
		"#",
		"TIMESTAMP",
		"BASELINE",
		"CANDIDATE",
		"REC",
		"Δ SCORE",
		"Δ PASS",
		"IMPROVEMENTS",
		"REGRESSIONS",
	];
	const rows = records.map((r, i) => [
		String(i + 1),
		new Date(r.timestamp).toISOString().slice(0, 19).replace("T", " "),
		r.baselineAgent.id,
		r.candidateAgent.id,
		r.recommendation.slice(0, 4),
		String(r.deltaScore ?? "-"),
		formatPercent(r.deltaPassRate),
		r.improvements.length === 0
			? "-"
			: r.improvements.slice(0, 3).join(", ") +
				(r.improvements.length > 3 ? "..." : ""),
		r.regressions.length === 0
			? "-"
			: r.regressions.slice(0, 3).join(", ") +
				(r.regressions.length > 3 ? "..." : ""),
	]);
	const colWidths = calcColWidths([prefix, ...rows]);
	const formatRow = (row: string[]) =>
		row.map((cell, ci) => cell.padEnd(colWidths[ci] ?? 0)).join(" | ");
	return [
		"EVOLUTION HISTORY",
		formatRow(prefix),
		"-".repeat(formatRow(prefix).length),
		...rows.map(formatRow),
	];
}

function calcColWidths(rows: string[][]): number[] {
	const widths: number[] = [];
	for (const row of rows) {
		for (let ci = 0; ci < row.length; ci++) {
			widths[ci] = Math.max(widths[ci] ?? 0, (row[ci] ?? "").length);
		}
	}
	return widths;
}

function toolRows(
	tools: TuiStateSnapshot["stats"]["topToolsByDuration"],
): string[] {
	if (tools.length === 0) return ["No tool results recorded yet"];
	return tools.map(
		(tool) =>
			`${tool.name} | count: ${tool.count} | total: ${formatMs(tool.totalDurationMs)} | avg: ${formatOptionalMs(tool.avgDurationMs)} | max: ${formatOptionalMs(tool.maxDurationMs)} | errors: ${tool.errors}`,
	);
}

function renderEntry(kind: string, text: string, width: number): string[] {
	const style = entryStyle(kind);
	const lines =
		kind === "assistant" ? renderMarkdown(text) : text.split(/\r?\n/);
	return lines.flatMap((line, index) =>
		wrapPrefixedLine(
			index === 0 ? style.firstPrefix : style.restPrefix,
			style.restPrefix,
			style.color,
			line,
			width,
		),
	);
}

interface EntryStyle {
	firstPrefix: string;
	restPrefix: string;
	color: (value: string) => string;
}

function entryStyle(kind: string): EntryStyle {
	if (kind === "user")
		return { firstPrefix: "┃ You  ", restPrefix: "┃      ", color: cyan };
	if (kind === "assistant")
		return { firstPrefix: "┃ LLM  ", restPrefix: "┃      ", color: green };
	if (kind === "tool_call")
		return { firstPrefix: "┆ Tool ", restPrefix: "┆      ", color: yellow };
	if (kind === "tool_result")
		return { firstPrefix: "┆ Result ", restPrefix: "┆        ", color: dim };
	if (kind === "error")
		return { firstPrefix: "! Error ", restPrefix: "!       ", color: red };
	if (kind === "score")
		return { firstPrefix: "◇ Score ", restPrefix: "◇       ", color: magenta };
	if (kind === "evolution")
		return { firstPrefix: "◆ Evo  ", restPrefix: "◆      ", color: cyan };
	return { firstPrefix: "· Info ", restPrefix: "·      ", color: dim };
}

function wrapPrefixedLine(
	firstPrefix: string,
	restPrefix: string,
	color: (value: string) => string,
	line: string,
	width: number,
): string[] {
	const available = Math.max(1, width - firstPrefix.length);
	const wrapped = wrapDisplayWidth(line, available);
	const [first = "", ...rest] = wrapped;
	return [
		`${color(firstPrefix)}${first}`,
		...rest.map((part) => `${color(restPrefix)}${part}`),
	];
}

function cyan(value: string): string {
	return `\x1b[36m${value}\x1b[0m`;
}
function green(value: string): string {
	return `\x1b[32m${value}\x1b[0m`;
}
function yellow(value: string): string {
	return `\x1b[33m${value}\x1b[0m`;
}
function red(value: string): string {
	return `\x1b[31m${value}\x1b[0m`;
}
function magenta(value: string): string {
	return `\x1b[35m${value}\x1b[0m`;
}
function dim(value: string): string {
	return `\x1b[2m${value}\x1b[0m`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function renderRunning(snapshot: TuiStateSnapshot, width: number): string[] {
	if (snapshot.runningTools.length === 0) return [];
	return [
		separator(width),
		...snapshot.runningTools.map((tool) => `running: ${tool.name}`),
	];
}

function renderFooter(
	snapshot: TuiStateSnapshot,
	context: RenderContext,
): string[] {
	const maxTools =
		snapshot.maxToolCalls === undefined ? "-" : String(snapshot.maxToolCalls);
	return [
		separator(context.width),
		[
			`status: ${context.inputBlocked ? "busy" : snapshot.status}`,
			`view: ${snapshot.activeView}`,
			`runs: ${snapshot.stats.runs.count}`,
			`turns: ${snapshot.turnCount}`,
			`tools: ${snapshot.toolCallCount}/${maxTools}`,
			...renderTiming(snapshot, context),
			`in: ${snapshot.stats.model.tokens.inputTokens}`,
			`out: ${snapshot.stats.model.tokens.outputTokens}`,
			...renderContextUsage(snapshot),
			`model: ${formatOptionalMs(snapshot.stats.model.latency.avgMs)} avg`,
			...(snapshot.runningToolName
				? [`running: ${snapshot.runningToolName}`]
				: []),
		].join(" | "),
		...(snapshot.lastError ? [`error: ${snapshot.lastError}`] : []),
	];
}

function renderTiming(
	snapshot: TuiStateSnapshot,
	context: RenderContext,
): string[] {
	const taskDurationMs =
		snapshot.runDurationMs ??
		(snapshot.runStartedAt === undefined
			? undefined
			: Math.max(0, context.now - snapshot.runStartedAt));
	return [
		...(taskDurationMs === undefined ? [] : [`task: ${taskDurationMs}ms`]),
		...(snapshot.toolDurationMs > 0
			? [`tool: ${snapshot.toolDurationMs}ms`]
			: []),
		...(snapshot.mcpDurationMs > 0 ? [`mcp: ${snapshot.mcpDurationMs}ms`] : []),
		...(snapshot.skillDurationMs > 0
			? [`skill: ${snapshot.skillDurationMs}ms`]
			: []),
	];
}

function formatMs(value: number): string {
	return `${Math.round(value)}ms`;
}

function formatOptionalMs(value: number | undefined): string {
	return value === undefined ? "-" : formatMs(value);
}

function formatTokenCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function renderContextUsage(snapshot: TuiStateSnapshot): string[] {
	const usage = snapshot.contextUsage ?? snapshot.stats.model.contextView;
	if (!usage) {
		if (snapshot.stats.model.contextTokens === undefined) return [];
		return [`ctx: ${snapshot.stats.model.contextTokens}`];
	}
	const fraction = (usage.usageFraction * 100).toFixed(1);
	return [
		`ctx: ${formatTokenCount(usage.tokenEstimate)}/${formatTokenCount(usage.budgetMaxTokens)} (${fraction}%)`,
	];
}

function formatCost(value: number | undefined): string {
	return value === undefined ? "-" : `$${value.toFixed(4)}`;
}

function formatRate(value: number | undefined): string {
	return value === undefined ? "-" : value.toFixed(1);
}

function formatPercent(value: number | undefined): string {
	return value === undefined ? "-" : `${Math.round(value * 100)}%`;
}

function summarizeTracePayload(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return text.length > 100 ? `${text.slice(0, 97)}...` : text;
	} catch {
		return String(value);
	}
}

function separator(width: number): string {
	return "─".repeat(Math.max(0, Math.min(width, 120)));
}

function truncate(value: string, width: number): string {
	return truncateDisplayWidth(value, width);
}
