import type { ModelMessage } from "../models/types.js";
import { calibrateTokenEstimate, effectiveInputTokenLimit, estimateMessageTokens, isOverContextBudget, type ResolvedContextBudget } from "./budget.js";
import { ensureSessionEntries, type AgentSession, type CompactionSessionEntry, type SessionEntry } from "./session.js";

export interface BuildContextViewOptions {
	budget: ResolvedContextBudget;
	stableMemoryContext?: ModelMessage;
	dynamicMemoryContext?: ModelMessage;
	memoryContextItemIds?: { stable: string[]; dynamic: string[] };
}

export interface ContextView {
	messages: ModelMessage[];
	includedEntryIds: string[];
	omittedEntryIds: string[];
	compactionEntryIds: string[];
	tokenEstimate: number;
	messagesPreview: ModelMessage[];
	memoryContext?: { stable: string[]; dynamic: string[] };
	budgetSnapshot?: {
		budgetMaxTokens: number;
		budgetReserveTokens: number;
		effectiveLimit: number;
		usageFraction: number;
	};
}

export interface ContextCutPoint {
	sourceEntries: SessionEntry[];
	keptRecentEntries: SessionEntry[];
	tokenEstimateBefore: number;
}

export type ContextTrimReason = "within_budget" | "hard_trim" | "aggressive_trim" | "fallback_minimal" | "system_only" | "system_truncated" | "untrimmable";

export interface ContextTrimResult {
	view: ContextView;
	trimmed: boolean;
	reason: ContextTrimReason;
	tokenEstimateBefore: number;
	tokenEstimateAfter: number;
	trimmedEntryIds: string[];
	keptEntryIds: string[];
}

const previewMaxChars = 500;

export function buildModelContextView(session: AgentSession, options: BuildContextViewOptions): ContextView {
	const sessionEntries = ensureSessionEntries(session);
	const entries = entriesForLatestCompaction(sessionEntries);
	const view = buildContextViewFromEntries(sessionEntries, entries, options);
	applyTokenEstimate(view, entries, session);
	return view;
}

export function enforceContextBudget(session: AgentSession, options: BuildContextViewOptions): ContextTrimResult {
	const sessionEntries = ensureSessionEntries(session);
	const entries = entriesForLatestCompaction(sessionEntries);
	const view = buildContextViewFromEntries(sessionEntries, entries, options);
	applyTokenEstimate(view, entries, session);
	if (!isOverContextBudget(view.tokenEstimate, options.budget)) return trimResult(view, false, "within_budget", view.tokenEstimate, view.tokenEstimate);
	const hardTrimmed = hardTrimEntries(sessionEntries, entries, options);
	const hardView = buildContextViewFromEntries(sessionEntries, hardTrimmed, options);
	applyTokenEstimate(hardView, hardTrimmed, session);
	if (!isOverContextBudget(hardView.tokenEstimate, options.budget)) return trimResult(hardView, true, "hard_trim", view.tokenEstimate, hardView.tokenEstimate);
	const aggressiveEntries = aggressiveTrimEntries(entries);
	const aggressiveView = buildContextViewFromEntries(sessionEntries, aggressiveEntries, options);
	applyTokenEstimate(aggressiveView, aggressiveEntries, session);
	if (!isOverContextBudget(aggressiveView.tokenEstimate, options.budget)) return trimResult(aggressiveView, true, "aggressive_trim", view.tokenEstimate, aggressiveView.tokenEstimate);
	const fallbackEntries = minimalFallbackEntries(entries);
	const fallbackView = buildContextViewFromEntries(sessionEntries, fallbackEntries, options);
	applyTokenEstimate(fallbackView, fallbackEntries, session);
	if (!isOverContextBudget(fallbackView.tokenEstimate, options.budget)) return trimResult(fallbackView, true, "fallback_minimal", view.tokenEstimate, fallbackView.tokenEstimate);
	const systemOnlyEntries = systemOnlyFallback(sessionEntries);
	const systemOnlyView = buildContextViewFromEntries(sessionEntries, systemOnlyEntries, options);
	applyTokenEstimate(systemOnlyView, systemOnlyEntries, session);
	if (!isOverContextBudget(systemOnlyView.tokenEstimate, options.budget)) return trimResult(systemOnlyView, true, "system_only", view.tokenEstimate, systemOnlyView.tokenEstimate);
	const truncatedEntries = truncateSystemPrompt(systemOnlyEntries, options.budget);
	const truncatedView = buildContextViewFromEntries(sessionEntries, truncatedEntries, options);
	applyTokenEstimate(truncatedView, truncatedEntries, session);
	const reason: ContextTrimReason = isOverContextBudget(truncatedView.tokenEstimate, options.budget) ? "untrimmable" : "system_truncated";
	return trimResult(truncatedView, true, reason, view.tokenEstimate, truncatedView.tokenEstimate);
}

export function findSafeCutPoint(entries: SessionEntry[], budget: ResolvedContextBudget): ContextCutPoint | undefined {
	const compactableEntries = entries.filter((entry) => entry.kind !== "system" && entry.kind !== "compaction");
	if (compactableEntries.length < 3) return undefined;
	let keepTokens = 0;
	let keepStart = compactableEntries.length;
	for (let index = compactableEntries.length - 1; index >= 0; index -= 1) {
		const entry = compactableEntries[index]!;
		keepTokens += estimateMessageTokens([entry.message]);
		keepStart = index;
		if (keepTokens >= budget.keepRecentTokens && hasUserEntry(compactableEntries.slice(keepStart))) break;
	}
	keepStart = adjustKeepStartToToolBoundary(compactableEntries, keepStart);
	const sourceEntries = compactableEntries.slice(0, keepStart);
	const keptRecentEntries = compactableEntries.slice(keepStart);
	if (sourceEntries.length === 0 || keptRecentEntries.length === 0) return undefined;
	return { sourceEntries, keptRecentEntries, tokenEstimateBefore: estimateMessageTokens(entries.map((entry) => entry.message)) };
}

function buildContextViewFromEntries(sessionEntries: SessionEntry[], entries: SessionEntry[], options: BuildContextViewOptions): ContextView {
	const baseMessages = entries.map((entry) => entry.message);
	const messages = injectMemoryMessages(baseMessages, options);
	const tokenEstimate = estimateMessageTokens(messages);
	const includedEntryIds = entries.map((entry) => entry.id);
	const includedSet = new Set(includedEntryIds);
	const omittedEntryIds = sessionEntries.filter((entry) => !includedSet.has(entry.id)).map((entry) => entry.id);
	const effectiveLimit = effectiveInputTokenLimit(options.budget);
	return {
		messages,
		includedEntryIds,
		omittedEntryIds,
		compactionEntryIds: entries.filter((entry) => entry.kind === "compaction").map((entry) => entry.id),
		tokenEstimate,
		messagesPreview: previewMessages(messages),
		...(options.memoryContextItemIds ? { memoryContext: options.memoryContextItemIds } : {}),
		budgetSnapshot: {
			budgetMaxTokens: options.budget.maxInputTokens,
			budgetReserveTokens: options.budget.reserveTokens,
			effectiveLimit,
			usageFraction: tokenEstimate / options.budget.maxInputTokens,
		},
	};
}

function applyTokenEstimate(view: ContextView, entries: SessionEntry[], session: AgentSession): void {
	const estimate = usageBasedTokenEstimate(entries, session) ?? calibrateTokenEstimate(view.tokenEstimate, session);
	view.tokenEstimate = estimate;
	if (view.budgetSnapshot) {
		view.budgetSnapshot = {
			...view.budgetSnapshot,
			usageFraction: estimate / view.budgetSnapshot.budgetMaxTokens,
		};
	}
}

function usageBasedTokenEstimate(entries: SessionEntry[], session: AgentSession): number | undefined {
	const previousIds = session.lastTurnIncludedEntryIds;
	const realInputTokens = session.lastTurnRealInputTokens;
	if (!previousIds || realInputTokens === undefined || realInputTokens <= 0) return undefined;
	if (!isPrefix(previousIds, entries.map((entry) => entry.id))) return undefined;
	const trailingEntries = entries.slice(previousIds.length);
	return realInputTokens + estimateMessageTokens(trailingEntries.map((entry) => entry.message));
}

function isPrefix(prefix: string[], values: string[]): boolean {
	if (prefix.length > values.length) return false;
	return prefix.every((value, index) => values[index] === value);
}

function entriesForLatestCompaction(entries: SessionEntry[]): SessionEntry[] {
	const compaction = latestCompaction(entries);
	if (!compaction) return entries;
	const compactionIndex = entries.findIndex((entry) => entry.id === compaction.id);
	const systemEntries = entries.filter((entry) => entry.kind === "system");
	const keptIds = new Set(compaction.keptRecentEntryIds);
	const keptEntries = entries.filter((entry, index) => index < compactionIndex && keptIds.has(entry.id));
	const afterCompaction = entries.slice(compactionIndex + 1);
	return dedupeEntries([...systemEntries, compaction, ...keptEntries, ...afterCompaction]);
}

function latestCompaction(entries: SessionEntry[]): CompactionSessionEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.kind === "compaction") return entry;
	}
	return undefined;
}

function hardTrimEntries(sessionEntries: SessionEntry[], entries: SessionEntry[], options: BuildContextViewOptions): SessionEntry[] {
	const mandatory = mandatoryEntryIds(entries);
	const selected = new Set(mandatory);
	for (const group of groupedEntries(entries).reverse()) {
		if (group.entries.some((entry) => selected.has(entry.id))) continue;
		if (group.kind === "orphan_tool_result") continue;
		const candidate = orderedSelectedEntries(entries, new Set([...selected, ...group.entries.map((entry) => entry.id)]));
		const view = buildContextViewFromEntries(sessionEntries, candidate, options);
		if (view.tokenEstimate <= effectiveInputTokenLimit(options.budget)) {
			for (const entry of group.entries) selected.add(entry.id);
		}
	}
	return orderedSelectedEntries(entries, selected);
}

function mandatoryEntryIds(entries: SessionEntry[]): string[] {
	const ids = entries.filter((entry) => entry.kind === "system").map((entry) => entry.id);
	const compaction = latestCompaction(entries);
	if (compaction) ids.push(compaction.id);
	const user = latestEntryOfKind(entries, "user");
	if (user) ids.push(user.id);
	return ids;
}

function minimalFallbackEntries(entries: SessionEntry[]): SessionEntry[] {
	const selected = new Set(mandatoryEntryIds(entries));
	return orderedSelectedEntries(entries, selected);
}

function systemOnlyFallback(sessionEntries: SessionEntry[]): SessionEntry[] {
	const selected = new Set<string>();
	for (const entry of sessionEntries) {
		if (entry.kind === "system") { selected.add(entry.id); break; }
	}
	const compaction = latestCompaction(sessionEntries);
	if (compaction) selected.add(compaction.id);
	const lastUser = latestEntryOfKind(sessionEntries, "user");
	if (lastUser) selected.add(lastUser.id);
	return orderedSelectedEntries(sessionEntries, selected);
}

function truncateSystemPrompt(entries: SessionEntry[], budget: ResolvedContextBudget): SessionEntry[] {
	const sysEntry = entries.find((e) => e.kind === "system");
	if (!sysEntry) return entries;
	const nonSystemTokens = estimateMessageTokens(entries.filter((e) => e.id !== sysEntry.id).map((e) => e.message));
	const availableTokens = Math.max(1, effectiveInputTokenLimit(budget) - nonSystemTokens);
	const maxChars = availableTokens * 4;
	if (sysEntry.message.content.length <= maxChars) return entries;
	const truncated: SessionEntry = {
		...sysEntry,
		message: { ...sysEntry.message, content: `${sysEntry.message.content.slice(0, maxChars)}\n[system prompt truncated]` },
	};
	return entries.map((e) => (e.id === sysEntry.id ? truncated : e));
}

function aggressiveTrimEntries(entries: SessionEntry[]): SessionEntry[] {
	const selected = new Set(mandatoryEntryIds(entries));
	const groups = groupedEntries(entries);
	let lastUserIndex = -1;
	for (let index = groups.length - 1; index >= 0; index -= 1) {
		const group = groups[index]!;
		if (group.kind === "orphan_tool_result") continue;
		for (const entry of group.entries) selected.add(entry.id);
		lastUserIndex = index;
		break;
	}
	if (lastUserIndex > 0) {
		const prev = groups[lastUserIndex - 1]!;
		for (const entry of prev.entries) selected.add(entry.id);
	}
	return orderedSelectedEntries(entries, selected);
}

function latestEntryOfKind(entries: SessionEntry[], kind: SessionEntry["kind"]): SessionEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]?.kind === kind) return entries[index];
	}
	return undefined;
}

interface EntryGroup {
	kind: "normal" | "tool_pair" | "orphan_tool_result";
	entries: SessionEntry[];
}

function groupedEntries(entries: SessionEntry[]): EntryGroup[] {
	const groups: EntryGroup[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (entry.kind === "assistant" && assistantHasToolCalls(entry.message)) {
			const group: SessionEntry[] = [entry];
			while (entries[index + 1]?.kind === "tool_result") group.push(entries[++index]!);
			groups.push({ kind: "tool_pair", entries: group });
			continue;
		}
		groups.push({ kind: entry.kind === "tool_result" ? "orphan_tool_result" : "normal", entries: [entry] });
	}
	return groups;
}

function orderedSelectedEntries(entries: SessionEntry[], selected: Set<string>): SessionEntry[] {
	return entries.filter((entry) => selected.has(entry.id));
}

function trimResult(view: ContextView, trimmed: boolean, reason: ContextTrimReason, tokenEstimateBefore: number, tokenEstimateAfter: number): ContextTrimResult {
	return {
		view,
		trimmed,
		reason,
		tokenEstimateBefore,
		tokenEstimateAfter,
		trimmedEntryIds: view.omittedEntryIds,
		keptEntryIds: view.includedEntryIds,
	};
}

function injectMemoryMessages(messages: ModelMessage[], options: BuildContextViewOptions): ModelMessage[] {
	const memoryContext = [options.stableMemoryContext, options.dynamicMemoryContext].filter((message): message is ModelMessage => message !== undefined);
	if (memoryContext.length === 0) return messages;
	const currentUserIndex = lastUserMessageIndex(messages);
	if (currentUserIndex === -1) return [...memoryContext, ...messages];
	return [...messages.slice(0, currentUserIndex), ...memoryContext, ...messages.slice(currentUserIndex)];
}

function lastUserMessageIndex(messages: ModelMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

function hasUserEntry(entries: SessionEntry[]): boolean {
	return entries.some((entry) => entry.kind === "user");
}

function adjustKeepStartToToolBoundary(entries: SessionEntry[], keepStart: number): number {
	let start = keepStart;
	while (start > 0 && entries[start]?.kind === "tool_result") start -= 1;
	const firstKept = entries[start];
	if (firstKept?.kind === "assistant" && !assistantHasToolCalls(firstKept.message)) return start;
	if (firstKept?.kind === "assistant") return start;
	const previous = entries[start - 1];
	if (previous?.kind === "assistant" && assistantHasToolCalls(previous.message)) return start - 1;
	return start;
}

function assistantHasToolCalls(message: ModelMessage): boolean {
	return message.contentBlocks?.some((block) => block.type === "tool_call") ?? false;
}

function dedupeEntries(entries: SessionEntry[]): SessionEntry[] {
	const seen = new Set<string>();
	const output: SessionEntry[] = [];
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		output.push(entry);
	}
	return output;
}

function previewMessages(messages: ModelMessage[]): ModelMessage[] {
	return messages.map((message) => ({
		...message,
		content: previewText(message.content),
		...(message.contentBlocks ? { contentBlocks: message.contentBlocks.map((block) => block.type === "text" ? { ...block, text: previewText(block.text) } : block.type === "reasoning" ? { ...block, text: `[reasoning omitted: ${block.text.length} chars]` } : block.type === "tool_result" ? { ...block, content: previewText(block.content) } : block) } : {}),
	}));
}

function previewText(value: string): string {
	if (value.length <= previewMaxChars) return value;
	return `${value.slice(0, previewMaxChars)}...[preview truncated ${value.length - previewMaxChars} chars]`;
}
