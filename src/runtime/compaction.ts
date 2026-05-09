import type { ModelClient, ModelMessage, ModelResponse } from "../models/types.js";
import { estimateMessageTokens, estimateTextTokens, isContextOverflowError, isOverContextBudget, shouldCompact, type ResolvedContextBudget } from "./budget.js";
import { buildModelContextView, findSafeCutPoint, type ContextView } from "./context-view.js";
import { appendCompactionEntry, ensureSessionEntries, type AgentSession, type CompactionSessionEntry, type SessionEntry } from "./session.js";

export interface MaybeCompactContextInput {
	session: AgentSession;
	modelClient: ModelClient;
	budget: ResolvedContextBudget;
	contextView: ContextView;
	createId: () => string;
	now: () => number;
	signal?: AbortSignal;
	force?: boolean;
	memoryContent?: string;
}

export interface CompactionResult {
	compacted: boolean;
	reason: "budget_exceeded" | "skipped" | "failed" | "circuit_breaker";
	tokenEstimateBefore: number;
	tokenEstimateAfter?: number;
	entryId?: string;
	sourceEntryCount?: number;
	keptRecentEntryCount?: number;
	failure?: string;
	overBudgetAfterCompaction?: boolean;
	needsTrim?: boolean;
	durationMs?: number;
	summaryTokens?: number;
	inputTokens?: number;
	ptlRetry?: { attempts: number; entriesDropped: number };
}

export async function maybeCompactContext(input: MaybeCompactContextInput): Promise<CompactionResult> {
	const mode = input.session.agent.runtime.contextCompression ?? "off";
	const tokenEstimateBefore = input.contextView.tokenEstimate;
	const failures = consecutiveFailureCount(input.session);
	const compact = input.force
		? mode === "auto" && (failures ?? 0) < input.budget.maxConsecutiveCompactionFailures
		: shouldCompact({ mode, tokens: tokenEstimateBefore, budget: input.budget, ...(input.session.compactionCount === undefined ? {} : { compactionCount: input.session.compactionCount }), ...(failures === undefined ? {} : { consecutiveFailures: failures }) });
	if (!compact) {
		if ((consecutiveFailureCount(input.session) ?? 0) >= input.budget.maxConsecutiveCompactionFailures) {
			return { compacted: false, reason: "circuit_breaker", tokenEstimateBefore };
		}
		return { compacted: false, reason: "skipped", tokenEstimateBefore };
	}
	const cut = findSafeCutPoint(ensureSessionEntries(input.session), input.budget);
	if (!cut) return { compacted: false, reason: "skipped", tokenEstimateBefore };
	try {
		const entries = ensureSessionEntries(input.session);
		const previousSummary = latestCompactionSummary(entries);
		const maxValidationAttempts = 2;
		const maxPtlRetries = 3;
		let lastFailure = "";
		let validationAttempt = 0;
		let ptlRetries = 0;
		let totalDropped = 0;
		let sourceEntries = cut.sourceEntries;

		while (validationAttempt < maxValidationAttempts) {
			let compactMessages = buildCompactionMessages(sourceEntries, input.budget, previousSummary, input.memoryContent);
			let inputTokens = estimateMessageTokens(sourceEntries.map((entry) => entry.message));
			const startedAt = input.now();
			let response: ModelResponse | undefined;
			try {
				response = await input.modelClient.complete({
					agent: input.session.agent,
					task: input.session.task,
					messages: compactMessages,
					turn: input.session.turnCount,
					purpose: "compaction",
					sessionId: input.session.id,
					routing: { inputTokenEstimate: inputTokens },
				}, input.signal);
			} catch (error) {
				if (!isContextOverflowError(error) || ptlRetries >= maxPtlRetries) throw error;
				const dropped = dropOldestRound(sourceEntries);
				if (dropped.dropped === 0) throw error;
				totalDropped += dropped.dropped;
				ptlRetries += 1;
				sourceEntries = dropped.remaining;
				continue;
			}
			validationAttempt += 1;
			const durationMs = Math.max(0, input.now() - startedAt);
			const rawSummary = parseCompactionSummary(response.text ?? "");
			const summary = limitCompactionSummary(rawSummary, input.budget);
			const validation = validateCompactionSummary(summary, sourceEntries, input.budget);
			if (validation.valid) {
				const entry = appendCompactionEntry(input.session, {
					id: input.createId(),
					createdAt: input.now(),
					summary,
					sourceEntryIds: sourceEntries.map((entry) => entry.id),
					keptRecentEntryIds: cut.keptRecentEntries.map((entry) => entry.id),
					tokenEstimateBefore,
				});
				const nextView = buildModelContextView(input.session, { budget: input.budget });
				entry.tokenEstimateAfter = nextView.tokenEstimate;
				const result = compactedResult(entry, sourceEntries.length, cut.keptRecentEntries.length, tokenEstimateBefore, nextView.tokenEstimate, input.budget);
				result.durationMs = durationMs;
				result.summaryTokens = estimateTextTokens(summary);
				result.inputTokens = inputTokens;
				if (ptlRetries > 0) result.ptlRetry = { attempts: ptlRetries, entriesDropped: totalDropped };
				return result;
			}
			lastFailure = validation.reason;
		}
		return { compacted: false, reason: "failed", tokenEstimateBefore, failure: `summary validation failed after ${maxValidationAttempts} attempts: ${lastFailure}` };
	} catch (error) {
		if (input.budget.failureMode === "error") throw error;
		return { compacted: false, reason: "failed", tokenEstimateBefore, failure: error instanceof Error ? error.message : String(error) };
	}
}

function compactedResult(entry: CompactionSessionEntry, sourceEntryCount: number, keptRecentEntryCount: number, tokenEstimateBefore: number, tokenEstimateAfter: number, budget: ResolvedContextBudget): CompactionResult {
	const overBudgetAfterCompaction = isOverContextBudget(tokenEstimateAfter, budget);
	return {
		compacted: true,
		reason: "budget_exceeded",
		tokenEstimateBefore,
		tokenEstimateAfter,
		entryId: entry.id,
		sourceEntryCount,
		keptRecentEntryCount,
		...(overBudgetAfterCompaction ? { overBudgetAfterCompaction, needsTrim: true } : {}),
	};
}

function buildCompactionMessages(entries: SessionEntry[], budget: ResolvedContextBudget, previousSummary?: string, memoryContent?: string): ModelMessage[] {
	const serialized = serializeEntriesForSummary(entries);
	const structuredFileOps = formatStructuredFileOps(collectFileOps(entries));
	const memorySection = memoryContent ? `\n<session_memories>\nThese memories were extracted from earlier turns in this session. Use them to avoid re-extracting the same information:\n${memoryContent}\n</session_memories>\n` : "";
	const sections = [
		"<primary_request>Copy the user's original request verbatim.</primary_request>",
		"<key_technical_concepts>Languages, frameworks, libraries, APIs, patterns, and protocols used or discussed. Include version constraints if known.</key_technical_concepts>",
		"<files_and_code_sections>List every file path that was read, modified, or created. For each, include: path, a one-line summary of its role, and key functions/classes touched. Preserve exact paths.</files_and_code_sections>",
		"<errors_and_fixes>Every error encountered, its root cause, the fix applied, and whether it was resolved. Mark unresolved errors clearly.</errors_and_fixes>",
		"<problem_solving>Problems solved and how. Include approach decisions, trade-offs made, alternatives considered and rejected, and any dead ends explored.</problem_solving>",
		"<all_user_messages>List every message the user sent, in order. Preserve the exact text of important constraints or instructions.</all_user_messages>",
		"<pending_tasks>Tasks not yet started, ordered by priority. Each with a one-line description.</pending_tasks>",
		"<current_work>Work in progress right now: what was being done when the conversation was compacted, any blockers, partial results.</current_work>",
		"<optional_next_step>The single most important next action, with enough context for the next agent to start immediately.</optional_next_step>",
	];
	const outputFormat = `<analysis>\nThink step by step about what happened in the conversation. Identify the primary request, key decisions, files touched, errors and their fixes, problems solved, user messages, and remaining work.\n</analysis>\n<summary>\n${sections.join("\n")}\n</summary>`;
	const systemPrompt = previousSummary
		? `You are a conversation archivist. Summarize the new entries below and merge them with the existing <previous-summary>, producing a single updated summary. Do NOT call tools. Return ONLY the XML structure shown—no text outside the tags.\n\nFirst, in <analysis>, reason about what is new vs already covered in the previous summary. Then, in <summary>, output the merged result with all 9 sections updated.\n\nMerge rules:\n- <primary_request>: preserve verbatim unless the user changed it.\n- <key_technical_concepts>: append new concepts; do not drop old ones.\n- <files_and_code_sections>: merge both old and new file lists; deduplicate by path.\n- <errors_and_fixes>: append new errors; mark resolved ones.\n- <problem_solving>: preserve old decisions; add new ones.\n- <all_user_messages>: append new user messages in order.\n- <pending_tasks>: remove completed items; add new pending tasks.\n- <current_work>: update to reflect the latest state.\n- <optional_next_step>: replace with the latest next step.\n\nOutput format:\n${outputFormat}`
		: `You are a conversation archivist. Summarize the conversation below for another agent that will resume the work. Do NOT call tools. Return ONLY the XML structure shown—no text outside the tags.\n\nFirst, in <analysis>, reason step by step about the conversation. Then, in <summary>, capture everything in 9 structured sections.\n\nRules for each section:\n- <primary_request>: the user's original task, verbatim.\n- <key_technical_concepts>: every technology, library, pattern, or protocol mentioned.\n- <files_and_code_sections>: every file path with what changed or was read.\n- <errors_and_fixes>: error → root cause → fix → resolved/unresolved.\n- <problem_solving>: approach, trade-offs, dead ends.\n- <all_user_messages>: every user message, preserving exact constraints.\n- <pending_tasks>: ordered by priority.\n- <current_work>: what was happening right now, with blockers.\n- <optional_next_step>: one specific, actionable next step.\n\nOutput format:\n${outputFormat}`;
	return [
		{ role: "system", content: systemPrompt },
		{
			role: "user",
			content: `<conversation maxSummaryTokens="${budget.summaryMaxTokens}">\n${memorySection}${structuredFileOps}${serialized}\n</conversation>${previousSummary ? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>` : ""}`,
		},
	];
}

interface FileOperation {
	action: "read" | "write" | "edit" | "search" | "list" | "execute";
	toolName: string;
	path: string;
}

function collectFileOps(entries: SessionEntry[]): FileOperation[] {
	const operations = new Map<string, FileOperation>();
	for (const entry of entries) {
		if (entry.kind !== "assistant" || !entry.message.contentBlocks) continue;
		for (const block of entry.message.contentBlocks) {
			if (block.type !== "tool_call") continue;
			const operation = fileOperationFromToolCall(block.name, block.input);
			if (!operation) continue;
			operations.set(`${operation.action}:${operation.toolName}:${operation.path}`, operation);
		}
	}
	return [...operations.values()];
}

function fileOperationFromToolCall(toolName: string, input: unknown): FileOperation | undefined {
	const record = objectRecord(input);
	const path = record ? stringValue(record, "path") ?? stringValue(record, "filePath") ?? stringValue(record, "file_path") ?? stringValue(record, "cwd") : undefined;
	const action = fileOperationAction(toolName);
	if (!action || !path) return undefined;
	return { action, toolName, path };
}

function fileOperationAction(toolName: string): FileOperation["action"] | undefined {
	const normalized = toolName.toLowerCase();
	if (normalized === "read" || normalized === "read_file") return "read";
	if (normalized === "write" || normalized === "write_file" || normalized === "filewrite") return "write";
	if (normalized === "edit" || normalized === "edit_file" || normalized === "fileedit") return "edit";
	if (normalized === "grep" || normalized === "glob" || normalized === "find_files") return "search";
	if (normalized === "list_dir") return "list";
	if (normalized === "bash") return "execute";
	return undefined;
}

function formatStructuredFileOps(operations: FileOperation[]): string {
	if (operations.length === 0) return "";
	const lines = operations.map((operation) => `- ${operation.action} ${operation.path} via ${operation.toolName}`);
	return `<structured_file_ops>\n${lines.join("\n")}\n</structured_file_ops>\n\n`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function serializeEntriesForSummary(entries: SessionEntry[]): string {
	return entries.map((entry) => {
		if (entry.kind === "tool_result") {
			const status = entry.result?.status;
			const tag = status === "error" || status === "timeout" ? "ERROR" : status === "denied" ? "DENIED" : entry.message.toolName ?? "unknown";
			const errorDetail = (status === "error" || status === "timeout") && entry.result?.errorMessage ? ` ${entry.result.errorMessage}` : "";
			return `[tool:${tag}]${errorDetail} ${limitSummaryText(entry.modelVisibleContent)}`;
		}
		return `[${entry.kind}] ${limitSummaryText(entry.message.content)}`;
	}).join("\n\n");
}

function limitSummaryText(value: string): string {
	const limit = 2_000;
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars of ${value.length} total]`;
}

function parseCompactionSummary(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) return "No summary was produced during context compaction.";
	const summaryMatch = trimmed.match(/<summary>([\s\S]*)<\/summary>/);
	if (summaryMatch && summaryMatch[1]) return summaryMatch[1].trim();
	return trimmed;
}

interface SummaryValidation {
	valid: boolean;
	reason: string;
}

function validateCompactionSummary(summary: string, sourceEntries: SessionEntry[], budget: ResolvedContextBudget): SummaryValidation {
	if (!summary || summary.length < 100) return { valid: false, reason: `summary too short (${summary.length} chars, need >= 100)` };
	if (estimateTextTokens(summary) > budget.summaryMaxTokens) return { valid: false, reason: `summary tokens ${estimateTextTokens(summary)} exceed budget ${budget.summaryMaxTokens}` };
	const requiredSections = ["<primary_request>", "<files_and_code_sections>", "<pending_tasks>"];
	const missingSections = requiredSections.filter((s) => !summary.includes(s));
	if (missingSections.length > 0) return { valid: false, reason: `missing required sections: ${missingSections.join(", ")}` };
	const paths = extractFilePaths(sourceEntries);
	const missingPaths = paths.filter((p) => !summary.includes(p));
	if (missingPaths.length > paths.length * 0.5) return { valid: false, reason: `${missingPaths.length}/${paths.length} file paths missing from summary` };
	return { valid: true, reason: "ok" };
}

function extractFilePaths(entries: SessionEntry[]): string[] {
	const paths = new Set<string>();
	for (const operation of collectFileOps(entries)) paths.add(operation.path);
	const pathPattern = /(?:\/[^\s,;)\]}>]+)+/g;
	for (const entry of entries) {
		const text = entry.kind === "tool_result" ? entry.modelVisibleContent : entry.message.content;
		const matches = text.match(pathPattern);
		if (matches) for (const m of matches) paths.add(m);
	}
	return [...paths];
}

function limitCompactionSummary(summary: string, budget: ResolvedContextBudget): string {
	if (estimateTextTokens(summary) <= budget.summaryMaxTokens) return summary;
	const marker = "\n[compaction summary truncated]";
	const maxChars = Math.max(1, budget.summaryMaxTokens * 4 - marker.length);
	const headChars = Math.max(1, Math.floor(maxChars * 0.7));
	const tailChars = Math.max(1, maxChars - headChars);
	return `${summary.slice(0, headChars)}${marker}\n${summary.slice(Math.max(0, summary.length - tailChars))}`;
}

function latestCompactionSummary(entries: SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry !== undefined && entry.kind === "compaction") return (entry as CompactionSessionEntry).summary;
	}
	return undefined;
}

function consecutiveFailureCount(session: AgentSession): number | undefined {
	return session.consecutiveCompactionFailures;
}

interface DropOldestRoundResult {
	dropped: number;
	remaining: SessionEntry[];
}

function dropOldestRound(entries: SessionEntry[]): DropOldestRoundResult {
	if (entries.length === 0) return { dropped: 0, remaining: entries };
	const firstAssistantIdx = entries.findIndex((e) => e.kind === "assistant");
	if (firstAssistantIdx === -1) return { dropped: 1, remaining: entries.slice(1) };
	let endIdx = firstAssistantIdx + 1;
	while (endIdx < entries.length && entries[endIdx]?.kind === "tool_result") {
		endIdx += 1;
	}
	const dropped = endIdx;
	return { dropped, remaining: entries.slice(endIdx) };
}
