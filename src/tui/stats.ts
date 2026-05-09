import type { TraceEvent } from "../runtime/events.js";
import type { ToolResultStatus } from "../tools/registry.js";

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

export interface TuiStatsSnapshot {
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

interface ToolNameAccumulator {
	name: string;
	count: number;
	totalDurationMs: number;
	maxDurationMs: number;
	errors: number;
	inputBytes: number;
	outputBytes: number;
}

const emptyToolStatuses = (): ToolStatusStats => ({ success: 0, error: 0, denied: 0, unknown: 0, limit_exceeded: 0, timeout: 0 });
const emptyTokens = (): TokenStats => ({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });

export class TuiStatsAccumulator {
	private eventCount = 0;
	private turnCount = 0;
	private runCount = 0;
	private runPassed = 0;
	private runFailed = 0;
	private runErrored = 0;
	private runTimeout = 0;
	private currentRunStartedAt: number | undefined;
	private runDurationsMs: number[] = [];
	private modelRequestCount = 0;
	private modelResponseCount = 0;
	private assistantDeltaCount = 0;
	private readonly modelDurationsMs: number[] = [];
	private readonly tokens = emptyTokens();
	private ttftMs: number | undefined;
	private recentRequestId: string | undefined;
	private recentStopReason: string | undefined;
	private readonly turnUsageHistory: ModelTurnUsageSnapshot[] = [];
	private compactionCount = 0;
	private latestContextTokens: number | undefined;
	private pendingModelStartedAt: number | undefined;
	private toolCallCount = 0;
	private toolResultCount = 0;
	private readonly toolStatuses = emptyToolStatuses();
	private readonly toolDurationsMs: number[] = [];
	private mcpCount = 0;
	private mcpDurationMs = 0;
	private skillCount = 0;
	private skillDurationMs = 0;
	private readonly memoryCounts: Record<string, number> = {};
	private readonly toolsByName = new Map<string, ToolNameAccumulator>();
	private readonly pendingToolInputBytes = new Map<string, number>();
	private scoreCount = 0;
	private scorePassed = 0;
	private scoreRatioTotal = 0;
	private latestScoreRatio: number | undefined;
	private errorCount = 0;
	private latestError: string | undefined;

	apply(event: TraceEvent): void {
		this.eventCount += 1;
		if (event.type === "run_start") this.applyRunStart(event);
		else if (event.type === "run_end") this.applyRunEnd(event);
		else if (event.type === "model_request") this.applyModelRequest(event);
		else if (event.type === "model_response") this.applyModelResponse(event);
		else if (event.type === "assistant_delta") this.applyAssistantDelta(event);
		else if (event.type === "tool_call") this.applyToolCall(event);
		else if (event.type === "tool_result") this.applyToolResult(event);
		else if (event.type === "score") this.applyScore(event);
		else if (event.type === "context_compaction") this.applyContextCompaction(event);
		else if (event.type === "micro_compact") this.applyMicroCompact(event);
		else if (event.type === "error") this.applyError(event.payload);
	}

	snapshot(now?: number): TuiStatsSnapshot {
		const runLatency = latencySummary(this.runDurationsMs);
		const toolLatency = latencySummary(this.toolDurationsMs);
		return {
			overview: { eventCount: this.eventCount, turnCount: this.turnCount, ...(this.latestError ? { lastError: this.latestError } : {}) },
			runs: this.runSnapshot(now, runLatency),
			model: this.modelSnapshot(),
			tools: this.toolSnapshot(toolLatency),
			scores: this.scoreSnapshot(),
			errors: { count: this.errorCount, ...(this.latestError ? { latest: this.latestError } : {}) },
			topToolsByCount: this.topTools((tool) => tool.count),
			topToolsByDuration: this.topTools((tool) => tool.totalDurationMs),
		};
	}

	private applyRunStart(event: TraceEvent): void {
		this.currentRunStartedAt = event.timestamp;
	}

	private applyRunEnd(event: TraceEvent): void {
		const payload = objectRecord(event.payload);
		this.runCount += 1;
		const status = typeof payload.status === "string" ? payload.status : "";
		if (status === "passed") this.runPassed += 1;
		else if (status === "failed") this.runFailed += 1;
		else if (status === "errored") this.runErrored += 1;
		else if (status === "timeout") this.runTimeout += 1;
		const durationMs = numberField(payload, "durationMs") ?? (this.currentRunStartedAt === undefined ? undefined : Math.max(0, event.timestamp - this.currentRunStartedAt));
		if (durationMs !== undefined) this.runDurationsMs.push(durationMs);
		this.currentRunStartedAt = undefined;
	}

	private applyModelRequest(event: TraceEvent): void {
		this.modelRequestCount += 1;
		this.pendingModelStartedAt = event.timestamp;
		const turn = numberField(objectRecord(event.payload), "turn");
		if (turn !== undefined) this.turnCount = Math.max(this.turnCount, turn);
	}

	private applyModelResponse(event: TraceEvent): void {
		this.modelResponseCount += 1;
		const timing = extractModelTiming(event.payload);
		const durationMs = timing?.durationMs ?? (this.pendingModelStartedAt === undefined ? undefined : Math.max(0, event.timestamp - this.pendingModelStartedAt));
		if (durationMs !== undefined) this.modelDurationsMs.push(durationMs);
		const usage = extractModelUsage(event.payload);
		if (usage) addTokens(this.tokens, usage);
		const turnUsage = extractTurnUsage(event.payload);
		if (turnUsage) {
			this.turnUsageHistory.push(turnUsage);
			if (this.turnUsageHistory.length > 20) this.turnUsageHistory.shift();
		}
		this.recentRequestId = stringValue(objectPath(event.payload, ["requestId"])) ?? stringValue(objectPath(event.payload, ["metadata", "requestId"])) ?? this.recentRequestId;
		this.recentStopReason = stringValue(objectPath(event.payload, ["metadata", "stopReason"])) ?? stringValue(objectPath(event.payload, ["metadata", "stop_reason"])) ?? this.recentStopReason;
		this.pendingModelStartedAt = undefined;
	}

	private applyAssistantDelta(event: TraceEvent): void {
		this.assistantDeltaCount += 1;
		if (this.ttftMs === undefined && this.pendingModelStartedAt !== undefined) this.ttftMs = Math.max(0, event.timestamp - this.pendingModelStartedAt);
	}

	private applyToolCall(event: TraceEvent): void {
		const call = objectRecord(objectPath(event.payload, ["call"]));
		this.toolCallCount += 1;
		const id = stringValue(call.id);
		if (id) this.pendingToolInputBytes.set(id, estimateSerializedSize(call.input));
	}

	private applyToolResult(event: TraceEvent): void {
		const result = extractToolResult(event.payload);
		if (!result) return;
		this.toolResultCount += 1;
		this.toolStatuses[result.status] += 1;
		const durationMs = result.durationMs ?? 0;
		if (durationMs > 0) this.toolDurationsMs.push(durationMs);
		this.addToolNameStats(result, durationMs);
		this.addToolCategoryStats(result.name, durationMs);
	}

	private applyContextCompaction(event: TraceEvent): void {
		this.compactionCount += 1;
		const payload = objectRecord(event.payload);
		const after = numberField(payload, "tokenEstimateAfter");
		if (after !== undefined) this.latestContextTokens = after;
	}

	private applyMicroCompact(event: TraceEvent): void {
		const payload = objectRecord(event.payload);
		const after = numberField(payload, "tokenEstimateAfter");
		if (after !== undefined) this.latestContextTokens = after;
	}

	private applyScore(event: TraceEvent): void {
		const payload = objectRecord(event.payload);
		const score = numberField(payload, "score");
		const maxScore = numberField(payload, "maxScore");
		if (score === undefined || maxScore === undefined || maxScore <= 0) return;
		this.scoreCount += 1;
		if (payload.passed === true) this.scorePassed += 1;
		this.latestScoreRatio = score / maxScore;
		this.scoreRatioTotal += this.latestScoreRatio;
	}

	private applyError(payload: unknown): void {
		this.errorCount += 1;
		this.latestError = summarize(payload);
	}

	private runSnapshot(now: number | undefined, latency: LatencySummary): TuiStatsSnapshot["runs"] {
		return {
			count: this.runCount,
			passed: this.runPassed,
			failed: this.runFailed,
			errored: this.runErrored,
			timeout: this.runTimeout,
			...(this.currentRunStartedAt === undefined ? {} : { currentStartedAt: this.currentRunStartedAt }),
			...(this.currentRunStartedAt !== undefined && now !== undefined ? { currentDurationMs: Math.max(0, now - this.currentRunStartedAt) } : {}),
			totalDurationMs: latency.totalMs,
			...(latency.avgMs === undefined ? {} : { avgDurationMs: latency.avgMs }),
		};
	}

	private modelSnapshot(): TuiStatsSnapshot["model"] {
		const latency = latencySummary(this.modelDurationsMs);
		const outputTokensPerSecond = latency.totalMs > 0 && this.tokens.outputTokens > 0 ? this.tokens.outputTokens / (latency.totalMs / 1000) : undefined;
		return {
			requestCount: this.modelRequestCount,
			responseCount: this.modelResponseCount,
			assistantDeltaCount: this.assistantDeltaCount,
			tokens: { ...this.tokens },
			latency,
			...(this.ttftMs === undefined ? {} : { ttftMs: this.ttftMs }),
			...(outputTokensPerSecond === undefined ? {} : { outputTokensPerSecond }),
			...(this.recentRequestId ? { recentRequestId: this.recentRequestId } : {}),
			...(this.recentStopReason ? { recentStopReason: this.recentStopReason } : {}),
			turnUsageHistory: [...this.turnUsageHistory],
			...(this.turnUsageHistory.length === 0 ? {} : { latestTurnUsage: this.turnUsageHistory[this.turnUsageHistory.length - 1] }),
			compactionCount: this.compactionCount,
			...(this.latestContextTokens === undefined ? {} : { contextTokens: this.latestContextTokens }),
		};
	}

	private toolSnapshot(latency: LatencySummary): TuiStatsSnapshot["tools"] {
		return {
			callCount: this.toolCallCount,
			resultCount: this.toolResultCount,
			statuses: { ...this.toolStatuses },
			totalDurationMs: latency.totalMs,
			...(latency.avgMs === undefined ? {} : { avgDurationMs: latency.avgMs }),
			...(latency.maxMs === undefined ? {} : { maxDurationMs: latency.maxMs }),
			mcpCount: this.mcpCount,
			mcpDurationMs: this.mcpDurationMs,
			skillCount: this.skillCount,
			skillDurationMs: this.skillDurationMs,
			memory: { ...this.memoryCounts },
		};
	}

	private scoreSnapshot(): TuiStatsSnapshot["scores"] {
		return {
			count: this.scoreCount,
			passed: this.scorePassed,
			...(this.scoreCount === 0 ? {} : { avgRatio: this.scoreRatioTotal / this.scoreCount }),
			...(this.latestScoreRatio === undefined ? {} : { latestRatio: this.latestScoreRatio }),
		};
	}

	private addToolNameStats(result: ExtractedToolResult, durationMs: number): void {
		const stats = this.toolsByName.get(result.name) ?? { name: result.name, count: 0, totalDurationMs: 0, maxDurationMs: 0, errors: 0, inputBytes: 0, outputBytes: 0 };
		stats.count += 1;
		stats.totalDurationMs += durationMs;
		stats.maxDurationMs = Math.max(stats.maxDurationMs, durationMs);
		if (result.status !== "success") stats.errors += 1;
		stats.inputBytes += result.inputBytes;
		stats.outputBytes += result.outputBytes;
		this.toolsByName.set(result.name, stats);
	}

	private addToolCategoryStats(name: string, durationMs: number): void {
		if (name.startsWith("mcp__")) {
			this.mcpCount += 1;
			this.mcpDurationMs += durationMs;
		} else if (name === "Skill" || name.toLowerCase().startsWith("skill")) {
			this.skillCount += 1;
			this.skillDurationMs += durationMs;
		}
		if (name.startsWith("memory_")) this.memoryCounts[name] = (this.memoryCounts[name] ?? 0) + 1;
	}

	private topTools(score: (tool: ToolNameAccumulator) => number): ToolNameStats[] {
		return Array.from(this.toolsByName.values())
			.sort((left, right) => score(right) - score(left) || left.name.localeCompare(right.name))
			.slice(0, 5)
			.map((tool) => ({
				name: tool.name,
				count: tool.count,
				totalDurationMs: tool.totalDurationMs,
				...(tool.count === 0 ? {} : { avgDurationMs: tool.totalDurationMs / tool.count }),
				maxDurationMs: tool.maxDurationMs,
				errors: tool.errors,
				inputBytes: tool.inputBytes,
				outputBytes: tool.outputBytes,
			}));
	}
}

interface ExtractedToolResult {
	name: string;
	status: ToolResultStatus;
	durationMs?: number;
	inputBytes: number;
	outputBytes: number;
}

export function latencySummary(values: number[]): LatencySummary {
	if (values.length === 0) return { count: 0, totalMs: 0 };
	const sorted = [...values].sort((left, right) => left - right);
	const totalMs = sorted.reduce((sum, value) => sum + value, 0);
	return { count: sorted.length, totalMs, avgMs: totalMs / sorted.length, minMs: sorted[0]!, maxMs: sorted[sorted.length - 1]!, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), p99Ms: percentile(sorted, 0.99) };
}

export function estimateSerializedSize(value: unknown): number {
	if (value === undefined) return 0;
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return 0;
	}
}

function percentile(sorted: number[], ratio: number): number {
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
	return sorted[index] ?? 0;
}

function extractToolResult(payload: unknown): ExtractedToolResult | undefined {
	const value = objectRecord(payload);
	const call = objectRecord(value.call);
	const name = stringValue(call.name);
	const status = toolStatus(value.status);
	if (!name || !status) return undefined;
	const durationMs = numberField(value, "durationMs");
	return { name, status, ...(durationMs === undefined ? {} : { durationMs }), inputBytes: estimateSerializedSize(call.input), outputBytes: estimateSerializedSize(value.output ?? value.errorMessage ?? value.metadata) };
}

function extractTurnUsage(payload: unknown): ModelTurnUsageSnapshot | undefined {
	const value = objectRecord(payload);
	const usage = objectRecord(value.turnUsage ?? value.usage);
	const turn = numberField(value, "turn");
	const inputEstimate = numberField(value, "inputTokenEstimate");
	const messageCount = numberField(value, "messageCount");
	if (turn === undefined) return undefined;
	const inputTokens = usageFromRecord(usage)?.inputTokens ?? inputEstimate ?? 0;
	const outputTokens = usageFromRecord(usage)?.outputTokens ?? 0;
	const totalTokens = inputTokens + outputTokens;
	const purpose = stringValue(value.purpose) ?? "main";
	const source = stringValue(value.usageSource) ?? "estimated";
	return { turn, purpose, inputTokens, outputTokens, totalTokens, source, messageCount: messageCount ?? 0 };
}

function extractModelUsage(payload: unknown): TokenStats | undefined {
	const direct = usageFromRecord(objectRecord(objectPath(payload, ["usage"])));
	if (direct) return direct;
	return usageFromRecord(objectRecord(objectPath(payload, ["metadata", "usage"])));
}

function extractModelTiming(payload: unknown): { durationMs?: number } | undefined {
	const timing = objectRecord(objectPath(payload, ["timing"]));
	const durationMs = numberField(timing, "durationMs");
	return durationMs === undefined ? undefined : { durationMs };
}

function usageFromRecord(value: Record<string, unknown>): TokenStats | undefined {
	const inputTokens = numberAny(value, ["inputTokens", "input_tokens", "prompt_tokens"]);
	const outputTokens = numberAny(value, ["outputTokens", "output_tokens", "completion_tokens"]);
	const reasoningTokens = numberAny(value, ["reasoningTokens", "reasoning_tokens"]) ?? numberField(objectRecord(value.output_tokens_details), "reasoning_tokens") ?? numberField(objectRecord(value.completion_tokens_details), "reasoning_tokens");
	const cacheReadTokens = numberAny(value, ["cacheReadTokens", "cache_read_input_tokens", "cached_tokens"]) ?? numberField(objectRecord(value.input_token_details), "cached_tokens") ?? numberField(objectRecord(value.prompt_tokens_details), "cached_tokens");
	const cacheWriteTokens = numberAny(value, ["cacheWriteTokens", "cache_creation_input_tokens"]);
	const totalTokens = numberAny(value, ["totalTokens", "total_tokens"]) ?? sumKnown([inputTokens, outputTokens]);
	const costUsd = numberAny(value, ["costUsd", "cost_usd", "cost"]);
	if ([inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens, costUsd].every((item) => item === undefined)) return undefined;
	return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, reasoningTokens: reasoningTokens ?? 0, cacheReadTokens: cacheReadTokens ?? 0, cacheWriteTokens: cacheWriteTokens ?? 0, totalTokens: totalTokens ?? 0, ...(costUsd === undefined ? {} : { costUsd }) };
}

function addTokens(target: TokenStats, source: TokenStats): void {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.reasoningTokens += source.reasoningTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.totalTokens += source.totalTokens;
	if (source.costUsd !== undefined) target.costUsd = (target.costUsd ?? 0) + source.costUsd;
}

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function objectPath(value: unknown, path: string[]): unknown {
	let current = value;
	for (const key of path) current = objectRecord(current)[key];
	return current;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
	const item = value[key];
	return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function numberAny(value: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const item = numberField(value, key);
		if (item !== undefined) return item;
	}
	return undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toolStatus(value: unknown): ToolResultStatus | undefined {
	return value === "success" || value === "error" || value === "denied" || value === "unknown" || value === "limit_exceeded" || value === "timeout" ? value : undefined;
}

function sumKnown(values: Array<number | undefined>): number | undefined {
	if (!values.some((value) => value !== undefined)) return undefined;
	return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function summarize(payload: unknown): string {
	if (typeof payload === "string") return payload;
	const message = stringValue(objectPath(payload, ["message"])) ?? stringValue(objectPath(payload, ["error"]));
	if (message) return message;
	try {
		const text = JSON.stringify(payload);
		return text.length > 120 ? `${text.slice(0, 117)}...` : text;
	} catch {
		return String(payload);
	}
}
