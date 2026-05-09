import type { ModelContentBlock, ModelMessage } from "../models/types.js";
import { effectiveInputTokenLimit, estimateMessageTokens, type ResolvedContextBudget } from "./budget.js";
import { ensureSessionEntries, refreshSessionMessages, type AgentSession, type AssistantSessionEntry, type ToolResultSessionEntry, type SessionEntry } from "./session.js";

export interface ContextCollapseConfig {
	enabled: boolean;
	preserveRecentTurns: number;
}

export interface ContextCollapseResult {
	collapsed: boolean;
	collapsedEntries: number;
	tokenEstimateBefore: number;
	tokenEstimateAfter: number;
}

const collapseMarker = "[Tool result content collapsed]";

const collapsedToolNames = new Set(["Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"]);

export function defaultContextCollapseConfig(): ContextCollapseConfig {
	return { enabled: false, preserveRecentTurns: 5 };
}

export function shouldContextCollapse(session: AgentSession, config: ContextCollapseConfig): boolean {
	if (!config.enabled) return false;
	const entries = ensureSessionEntries(session);
	const turnBoundaries = countTurnBoundaries(entries);
	return turnBoundaries > config.preserveRecentTurns;
}

export function collapseContext(session: AgentSession, config: ContextCollapseConfig, budget: ResolvedContextBudget): ContextCollapseResult {
	const entries = ensureSessionEntries(session);
	const tokenBefore = estimateMessageTokens(entries.map((e) => e.message));

	const turnStarts = turnStartIndices(entries);
	if (turnStarts.length <= config.preserveRecentTurns) {
		return { collapsed: false, collapsedEntries: 0, tokenEstimateBefore: tokenBefore, tokenEstimateAfter: tokenBefore };
	}

	const cutoffTurnIndex = turnStarts.length - config.preserveRecentTurns;
	const cutoffEntryIndex = turnStarts[cutoffTurnIndex]!;
	const candidateToolIds = collectCandidateToolIds(entries, cutoffEntryIndex);
	if (candidateToolIds.size === 0) {
		return { collapsed: false, collapsedEntries: 0, tokenEstimateBefore: tokenBefore, tokenEstimateAfter: tokenBefore };
	}

	let collapsedCount = 0;
	for (let i = 0; i < cutoffEntryIndex; i++) {
		const entry = entries[i];
		if (entry?.kind !== "tool_result") continue;
		const toolEntry = entry as ToolResultSessionEntry;
		const id = toolCallId(toolEntry);
		if (!id || !candidateToolIds.has(id)) continue;
		collapseToolResult(toolEntry);
		collapsedCount += 1;
	}

	if (collapsedCount > 0) {
		refreshSessionMessages(session);
		if (!session.collapsedEntryIds) session.collapsedEntryIds = [];
	}
	const tokenAfter = estimateMessageTokens(entries.map((e) => e.message));
	return {
		collapsed: collapsedCount > 0,
		collapsedEntries: collapsedCount,
		tokenEstimateBefore: tokenBefore,
		tokenEstimateAfter: tokenAfter,
	};
}

function countTurnBoundaries(entries: SessionEntry[]): number {
	return turnStartIndices(entries).length;
}

function turnStartIndices(entries: SessionEntry[]): number[] {
	const indices: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (entries[i]!.kind === "user") indices.push(i);
	}
	return indices;
}

function collectCandidateToolIds(entries: SessionEntry[], cutoffIndex: number): Set<string> {
	const ids = new Set<string>();
	for (let i = 0; i < cutoffIndex; i++) {
		if (entries[i]!.kind !== "assistant") continue;
		const assistant = entries[i] as AssistantSessionEntry;
		for (const block of assistant.message.contentBlocks ?? []) {
			if (block.type === "tool_call" && collapsedToolNames.has(block.name)) {
				ids.add(block.id);
			}
		}
	}
	return ids;
}

function collapseToolResult(entry: ToolResultSessionEntry): void {
	entry.modelVisibleContent = collapseMarker;
	entry.message.content = collapseMarker;
	if (entry.message.contentBlocks) {
		entry.message.contentBlocks = entry.message.contentBlocks.map((block): ModelContentBlock => {
			if (block.type !== "tool_result") return block;
			return {
				type: "tool_result" as const,
				toolCallId: block.toolCallId,
				...(block.toolName ? { toolName: block.toolName } : {}),
				content: collapseMarker,
				...(block.isError ? { isError: block.isError } : {}),
			};
		});
	}
}

function toolCallId(entry: ToolResultSessionEntry): string | undefined {
	return entry.message.toolCallId ?? entry.result?.call.id;
}
