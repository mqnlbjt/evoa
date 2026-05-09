import type { ModelContentBlock } from "../models/types.js";
import { effectiveInputTokenLimit, estimateMessageTokens, type MicroCompactConfig, type ResolvedContextBudget, type TimeBasedMicroCompactConfig } from "./budget.js";
import { ensureSessionEntries, refreshSessionMessages, type AgentSession, type AssistantSessionEntry, type SessionEntry, type ToolResultSessionEntry } from "./session.js";

export interface MicroCompactResult {
	compacted: boolean;
	toolsCleared: number;
	toolsKept: number;
	errorsPreserved: number;
	tokenEstimateBefore: number;
	tokenEstimateAfter: number;
	overBudgetAfter: boolean;
}

export interface TimeBasedMicroCompactResult {
	cleared: boolean;
	toolsCleared: number;
	gapMinutes: number;
}

const clearedMarker = "[Old tool result content cleared]";

export function shouldTimeBasedMicroCompact(session: AgentSession, config: TimeBasedMicroCompactConfig, now: () => number): boolean {
	if (!config.enabled) return false;
	const entries = ensureSessionEntries(session);
	const lastAssistant = findLastAssistantEntry(entries);
	if (!lastAssistant) return false;
	const gapMs = now() - lastAssistant.createdAt;
	const gapMinutes = gapMs / 60_000;
	return gapMinutes >= config.gapThresholdMinutes;
}

export function timeBasedMicroCompact(session: AgentSession, config: TimeBasedMicroCompactConfig, budget: ResolvedContextBudget, now: () => number): TimeBasedMicroCompactResult {
	const entries = ensureSessionEntries(session);
	const compactableToolNames = new Set(["Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "FileEdit", "FileWrite"]);

	const assistantEntries = entries.filter((e): e is AssistantSessionEntry => e.kind === "assistant");
	const recentAssistantIds = new Set(assistantEntries.slice(-config.keepRecent).map((e) => e.id));
	const recentToolIds = new Set<string>();
	for (const entry of assistantEntries) {
		if (!recentAssistantIds.has(entry.id)) continue;
		for (const block of entry.message.contentBlocks ?? []) {
			if (block.type === "tool_call" && compactableToolNames.has(block.name)) {
				recentToolIds.add(block.id);
			}
		}
	}

	let toolsCleared = 0;
	for (const entry of entries) {
		if (entry.kind !== "tool_result") continue;
		const id = toolResultId(entry);
		if (!id || !isCompactableToolResult(entries, id, compactableToolNames)) continue;
		if (recentToolIds.has(id)) continue;
		if (isClearedToolResult(entry)) continue;
		if (isErrorToolResult(entry)) continue;
		clearToolResultEntry(entry);
		toolsCleared += 1;
	}

	if (toolsCleared > 0) refreshSessionMessages(session);
	const gapMs = now() - (findLastAssistantEntry(entries)?.createdAt ?? now());
	return { cleared: toolsCleared > 0, toolsCleared, gapMinutes: Math.floor(gapMs / 60_000) };
}

function isCompactableToolResult(entries: SessionEntry[], toolCallId: string, compactableToolNames: Set<string>): boolean {
	for (const entry of entries) {
		if (entry.kind !== "assistant") continue;
		for (const block of entry.message.contentBlocks ?? []) {
			if (block.type === "tool_call" && block.id === toolCallId && compactableToolNames.has(block.name)) return true;
		}
	}
	return false;
}

function findLastAssistantEntry(entries: SessionEntry[]): AssistantSessionEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]!.kind === "assistant") return entries[i] as AssistantSessionEntry;
	}
	return undefined;
}

export function microCompact(session: AgentSession, config: MicroCompactConfig, budget: ResolvedContextBudget): MicroCompactResult {
	if (!config.enabled) return noopResult(session);

	const entries = ensureSessionEntries(session);
	const cleared = new Set<string>();
	const compactableIds: string[] = [];
	const compactableIdSet = new Set<string>();
	const compactableToolNames = new Set(config.compactableToolNames);

	for (const entry of entries) {
		if (entry.kind !== "assistant" || !entry.message.contentBlocks) continue;
		for (const block of entry.message.contentBlocks) {
			if (block.type !== "tool_call" || !compactableToolNames.has(block.name) || compactableIdSet.has(block.id)) continue;
			compactableIds.push(block.id);
			compactableIdSet.add(block.id);
		}
	}

	if (compactableIds.length === 0) return noopResult(session);

	const keepCount = Math.max(0, config.keepRecentTools);
	const keepSet = keepCount === 0 ? new Set<string>() : new Set(compactableIds.slice(-keepCount));
	const tokenEstimateBefore = estimateMessageTokens(entries.map((entry) => entry.message));

	let errorsPreserved = 0;
	for (const entry of entries) {
		if (entry.kind !== "tool_result") continue;
		const id = toolResultId(entry);
		if (!id || !compactableIdSet.has(id)) continue;
		if (keepSet.has(id)) continue;
		if (isClearedToolResult(entry)) continue;
		if (isErrorToolResult(entry)) {
			errorsPreserved += 1;
			continue;
		}
		clearToolResultEntry(entry);
		cleared.add(id);
	}

	if (cleared.size > 0) refreshSessionMessages(session);
	const tokenEstimateAfter = cleared.size > 0 ? estimateMessageTokens(entries.map((entry) => entry.message)) : tokenEstimateBefore;
	return {
		compacted: cleared.size > 0,
		toolsCleared: cleared.size,
		toolsKept: keepSet.size,
		errorsPreserved,
		tokenEstimateBefore,
		tokenEstimateAfter,
		overBudgetAfter: tokenEstimateAfter > effectiveInputTokenLimit(budget),
	};
}

function toolResultId(entry: ToolResultSessionEntry): string | undefined {
	return entry.message.toolCallId ?? entry.result?.call.id;
}

function isClearedToolResult(entry: ToolResultSessionEntry): boolean {
	return entry.modelVisibleContent === clearedMarker
		|| entry.message.content === clearedMarker
		|| entry.message.contentBlocks?.some((block) => block.type === "tool_result" && block.content === clearedMarker) === true;
}

function isErrorToolResult(entry: ToolResultSessionEntry): boolean {
	if (entry.result?.status && entry.result.status !== "success") return true;
	return entry.message.contentBlocks?.some((block) => block.type === "tool_result" && block.isError) === true;
}

function clearToolResultEntry(entry: ToolResultSessionEntry): void {
	entry.modelVisibleContent = clearedMarker;
	entry.message.content = clearedMarker;
	entry.message.contentBlocks = clearedToolResultBlocks(entry);
}

function clearedToolResultBlocks(entry: ToolResultSessionEntry): ModelContentBlock[] {
	const blocks = entry.message.contentBlocks?.filter((block) => block.type === "tool_result");
	if (blocks?.length) {
		return blocks.map((block) => ({
			type: "tool_result" as const,
			toolCallId: block.toolCallId,
			...(block.toolName ? { toolName: block.toolName } : {}),
			content: clearedMarker,
			...(block.isError ? { isError: block.isError } : {}),
		}));
	}
	const toolCallId = entry.message.toolCallId ?? entry.result?.call.id;
	if (!toolCallId) return [{ type: "text", text: clearedMarker }];
	const toolName = entry.message.toolName ?? entry.result?.call.name;
	return [{
		type: "tool_result",
		toolCallId,
		...(toolName ? { toolName } : {}),
		content: clearedMarker,
	}];
}

function noopResult(session: AgentSession): MicroCompactResult {
	const entries = ensureSessionEntries(session);
	const tokens = estimateMessageTokens(entries.map((entry) => entry.message));
	return { compacted: false, toolsCleared: 0, toolsKept: 0, errorsPreserved: 0, tokenEstimateBefore: tokens, tokenEstimateAfter: tokens, overBudgetAfter: false };
}
