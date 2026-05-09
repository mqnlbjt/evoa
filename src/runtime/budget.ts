import type { ModelContentBlock, ModelMessage } from "../models/types.js";
import type { AgentSpec } from "../specs.js";

export interface TimeBasedMicroCompactConfig {
	enabled: boolean;
	gapThresholdMinutes: number;
	keepRecent: number;
}

export interface MicroCompactConfig {
	enabled: boolean;
	compactableToolNames: string[];
	keepRecentTools: number;
	timeBased: TimeBasedMicroCompactConfig;
}

export interface ResolvedContextBudget {
	maxInputTokens: number;
	reserveTokens: number;
	keepRecentTokens: number;
	triggerRatio: number;
	summaryMaxTokens: number;
	maxCompactionsPerRun: number;
	maxConsecutiveCompactionFailures: number;
	failureMode: "continue" | "error";
	microCompact: MicroCompactConfig;
	iterativeSummary: boolean;
}

export interface ResolvedToolOutputBudget {
	maxBytes: number;
	strategy: "head-tail" | "head-only";
	headBytes: number;
	tailBytes: number;
	includeMetadata: boolean;
}

export interface ShouldCompactInput {
	mode?: "off" | "auto";
	tokens: number;
	budget: ResolvedContextBudget;
	compactionCount?: number;
	consecutiveFailures?: number;
}

const defaultCompactableToolNames = ["Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "FileEdit", "FileWrite"];

const defaultTimeBasedMicroCompact: TimeBasedMicroCompactConfig = {
	enabled: false,
	gapThresholdMinutes: 60,
	keepRecent: 5,
};

const defaultMicroCompact: MicroCompactConfig = {
	enabled: true,
	compactableToolNames: defaultCompactableToolNames,
	keepRecentTools: 12,
	timeBased: defaultTimeBasedMicroCompact,
};

const defaultContextBudget: ResolvedContextBudget = {
	maxInputTokens: 64_000,
	reserveTokens: 8_000,
	keepRecentTokens: 16_000,
	triggerRatio: 0.85,
	summaryMaxTokens: 4_000,
	maxCompactionsPerRun: 3,
	maxConsecutiveCompactionFailures: 3,
	failureMode: "continue",
	microCompact: defaultMicroCompact,
	iterativeSummary: true,
};

const defaultToolOutputMaxBytes = 64 * 1024;

export function resolveContextBudget(agent: AgentSpec): ResolvedContextBudget {
	const microCompact = resolveMicroCompact(agent.runtime.contextBudget?.microCompact);
	return {
		maxInputTokens: agent.runtime.contextBudget?.maxInputTokens ?? defaultContextBudget.maxInputTokens,
		reserveTokens: agent.runtime.contextBudget?.reserveTokens ?? defaultContextBudget.reserveTokens,
		keepRecentTokens: agent.runtime.contextBudget?.keepRecentTokens ?? defaultContextBudget.keepRecentTokens,
		triggerRatio: agent.runtime.contextBudget?.triggerRatio ?? defaultContextBudget.triggerRatio,
		summaryMaxTokens: agent.runtime.contextBudget?.summaryMaxTokens ?? defaultContextBudget.summaryMaxTokens,
		maxCompactionsPerRun: agent.runtime.contextBudget?.maxCompactionsPerRun ?? defaultContextBudget.maxCompactionsPerRun,
		maxConsecutiveCompactionFailures: agent.runtime.contextBudget?.maxConsecutiveCompactionFailures ?? defaultContextBudget.maxConsecutiveCompactionFailures,
		failureMode: agent.runtime.contextBudget?.failureMode ?? defaultContextBudget.failureMode,
		microCompact,
		iterativeSummary: agent.runtime.contextBudget?.iterativeSummary ?? defaultContextBudget.iterativeSummary,
	};
}

function resolveMicroCompact(spec: { enabled?: boolean; compactableToolNames?: string[]; keepRecentTools?: number; timeBased?: { enabled?: boolean; gapThresholdMinutes?: number; keepRecent?: number } } | undefined): MicroCompactConfig {
	const timeBased: TimeBasedMicroCompactConfig = {
		enabled: spec?.timeBased?.enabled ?? defaultTimeBasedMicroCompact.enabled,
		gapThresholdMinutes: spec?.timeBased?.gapThresholdMinutes ?? defaultTimeBasedMicroCompact.gapThresholdMinutes,
		keepRecent: Math.max(0, spec?.timeBased?.keepRecent ?? defaultTimeBasedMicroCompact.keepRecent),
	};
	return {
		enabled: spec?.enabled ?? defaultMicroCompact.enabled,
		compactableToolNames: normalizeCompactableTools(spec?.compactableToolNames),
		keepRecentTools: Math.max(0, spec?.keepRecentTools ?? defaultMicroCompact.keepRecentTools),
		timeBased,
	};
}

function normalizeCompactableTools(names: string[] | undefined): string[] {
	if (!names || names.length === 0) return defaultCompactableToolNames;
	return names;
}

export function resolveToolOutputBudget(agent: AgentSpec, toolName?: string, toolMaxBytes?: number): ResolvedToolOutputBudget {
	const runtimeBudget = agent.runtime.toolOutputBudget;
	const perToolBudget = toolName ? runtimeBudget?.perTool?.[toolName] : undefined;
	const maxBytes = perToolBudget?.maxBytes ?? runtimeBudget?.maxBytes ?? toolMaxBytes ?? defaultToolOutputMaxBytes;
	const strategy = perToolBudget?.strategy ?? runtimeBudget?.strategy ?? "head-tail";
	const requestedHeadBytes = perToolBudget?.headBytes ?? runtimeBudget?.headBytes;
	const requestedTailBytes = perToolBudget?.tailBytes ?? runtimeBudget?.tailBytes;
	const fallbackHeadBytes = strategy === "head-only" ? maxBytes : Math.floor(maxBytes / 2);
	const fallbackTailBytes = strategy === "head-only" ? 0 : maxBytes - fallbackHeadBytes;
	const headBytes = Math.min(requestedHeadBytes ?? fallbackHeadBytes, maxBytes);
	const tailBytes = strategy === "head-only" ? 0 : Math.min(requestedTailBytes ?? fallbackTailBytes, Math.max(0, maxBytes - headBytes));
	return {
		maxBytes,
		strategy,
		headBytes,
		tailBytes,
		includeMetadata: perToolBudget?.includeMetadata ?? runtimeBudget?.includeMetadata ?? true,
	};
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
	return messages.reduce((total, message) => total + estimateTextTokens(message.role) + estimateTextTokens(message.content) + estimateContentBlocksTokens(message.contentBlocks), 0);
}

export function estimateTextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

export function calibrateTokenEstimate(estimate: number, session: { lastTurnEstimatedInputTokens?: number; lastTurnRealInputTokens?: number }): number {
	if (session.lastTurnEstimatedInputTokens === undefined || session.lastTurnRealInputTokens === undefined) return estimate;
	if (session.lastTurnEstimatedInputTokens <= 0) return estimate;
	const ratio = session.lastTurnRealInputTokens / session.lastTurnEstimatedInputTokens;
	return Math.round(estimate * Math.min(2.0, Math.max(0.5, ratio)));
}

export function effectiveInputTokenLimit(budget: ResolvedContextBudget): number {
	return Math.max(1, budget.maxInputTokens - budget.reserveTokens);
}

export function isOverContextBudget(tokens: number, budget: ResolvedContextBudget): boolean {
	return tokens > effectiveInputTokenLimit(budget);
}

export function shouldCompact(input: ShouldCompactInput): boolean {
	if (input.mode !== "auto") return false;
	if ((input.compactionCount ?? 0) >= input.budget.maxCompactionsPerRun) return false;
	if ((input.consecutiveFailures ?? 0) >= input.budget.maxConsecutiveCompactionFailures) return false;
	const threshold = Math.floor(effectiveInputTokenLimit(input.budget) * input.budget.triggerRatio);
	return input.tokens >= threshold;
}

export interface ShouldMicroCompactInput {
	config: MicroCompactConfig;
	tokens: number;
	budget: ResolvedContextBudget;
}

export function shouldMicroCompact(input: ShouldMicroCompactInput): boolean {
	if (!input.config.enabled) return false;
	const threshold = Math.floor(effectiveInputTokenLimit(input.budget) * 0.75);
	return input.tokens >= threshold;
}

export function isContextOverflowError(error: unknown): boolean {
	const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	const normalized = message.toLowerCase();
	return normalized.includes("context") && (normalized.includes("overflow") || normalized.includes("too long") || normalized.includes("length") || normalized.includes("maximum"))
		|| normalized.includes("prompt is too long")
		|| normalized.includes("maximum context length")
		|| normalized.includes("context window");
}

function estimateContentBlocksTokens(blocks: ModelContentBlock[] | undefined): number {
	if (!blocks) return 0;
	return blocks.reduce((total, block) => {
		if (block.type === "text" || block.type === "reasoning") return total + estimateTextTokens(block.text);
		if (block.type === "tool_result") return total + estimateTextTokens(block.content);
		return total + estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input ?? null));
	}, 0);
}
