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
	notableFacts?: string[];
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
				const facts = extractNotableFacts(summary);
				if (facts.length > 0) result.notableFacts = facts;
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

const compactSectionTemplate = `## Task Goal
[What the user wants to accomplish. Current progress, what remains to be done.]

## Key Decisions
- [What choices were made and why]
- [Technologies, frameworks, libraries, patterns involved]
- [Approaches rejected and reasons]

## File Changes
- \`path/to/file\` — what changed, key function/class names
- (Keep exact paths)

## Errors and Fixes
- Error → Cause → Fix → Resolved/Unresolved

## User Messages
- [List all user messages verbatim in order]
- [Especially constraints and corrective feedback]

## Next Steps
1. [Actionable steps in priority order]

## Notable Facts
- [Fact worth remembering for future sessions. One fact per line. Write "(none)" if nothing notable.]
- [Include: user preferences, project conventions, key architectural decisions, repeated errors that should be avoided]`;

const compactOutputRules = `Output only the Markdown structure above. Do not output any other text. Do not call tools. The Notable Facts section is optional — write "(none)" when there are no notable facts to carry forward.`;

function buildCompactionMessages(entries: SessionEntry[], budget: ResolvedContextBudget, previousSummary?: string, memoryContent?: string): ModelMessage[] {
	const serialized = serializeEntriesForSummary(entries);
	const structuredFileOps = formatStructuredFileOps(collectFileOps(entries));
	const memorySection = memoryContent ? `\n## Existing Memories\nThe following are memories already extracted from this session. Avoid duplicating them:\n${memoryContent}\n` : "";

	const systemPrompt = previousSummary
		? `You are a conversation archivist. Merge the new conversation content below into the existing <previous-summary> to produce an updated summary.\n\n${compactOutputRules}\n\nMerge rules:\n- Task Goal: Add new progress, keep the original goal\n- Key Decisions: Append new decisions, keep old ones\n- File Changes: Merge both lists, deduplicate by path\n- Errors and Fixes: Append new errors, mark resolved ones\n- User Messages: Append new messages in order\n- Next Steps: Remove completed items, add new ones, keep priority order\n\nOutput format:\n${compactSectionTemplate}`
		: `You are a conversation archivist. Summarize the conversation below for another Agent to continue working.\n\n${compactOutputRules}\n\nOutput format:\n${compactSectionTemplate}`;

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
	return trimmed;
}

function extractNotableFacts(summary: string): string[] {
	const sectionMatch = summary.match(/## Notable Facts\s*\n([\s\S]*?)(?=\n## |$)/i);
	if (!sectionMatch?.[1]) return [];
	const body = sectionMatch[1].trim();
	const stripped = body.split("\n")[0]?.replace(/^[-*]\s*/, "").trim().toLowerCase() ?? "";
	if (body === "" || stripped === "(none)" || stripped === "n/a") return [];
	return body
		.split("\n")
		.map((line) => line.replace(/^[-*]\s*/, "").trim())
		.filter((line) => line.length > 0);
}

interface SummaryValidation {
	valid: boolean;
	reason: string;
}

function validateCompactionSummary(summary: string, sourceEntries: SessionEntry[], budget: ResolvedContextBudget): SummaryValidation {
	if (!summary || summary.length < 100) return { valid: false, reason: `summary too short (${summary.length} chars, need >= 100)` };
	if (estimateTextTokens(summary) > budget.summaryMaxTokens) return { valid: false, reason: `summary tokens ${estimateTextTokens(summary)} exceed budget ${budget.summaryMaxTokens}` };
	const requiredSections = ["## Task Goal", "## File Changes", "## Next Steps"];
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

export function summarizeCompletedSession(session: AgentSession): boolean {
	const entries = ensureSessionEntries(session);
	const systemEntries = entries.filter((e) => e.kind === "system");
	const nonSystem = entries.filter((e) => e.kind !== "system");
	if (nonSystem.length < 2) return false;

	const userEntries = nonSystem.filter((e) => e.kind === "user");
	const lastUser = userEntries[userEntries.length - 1];
	const lastAssistant = lastOfKind(nonSystem, "assistant");
	if (!lastAssistant) return false;

	const question = lastUser ? `Question: ${limitSummaryText(lastUser.message.content)}` : "";
	const answer = `Answer: ${limitSummaryText(lastAssistant.message.content)}`;
	const summary = [question, answer].filter(Boolean).join("\n") || "Task completed.";

	const tokenEstimateBefore = estimateMessageTokens(entries.map((e) => e.message));
	session.entries = [...systemEntries];
	session.messages = systemEntries.map((e) => e.message);
	appendCompactionEntry(session, {
		summary,
		sourceEntryIds: nonSystem.map((e) => e.id),
		keptRecentEntryIds: [],
		tokenEstimateBefore,
		tokenEstimateAfter: estimateTextTokens(summary),
	});
	return true;
}

function lastOfKind(entries: SessionEntry[], kind: SessionEntry["kind"]): SessionEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		if (entries[i]?.kind === kind) return entries[i];
	}
	return undefined;
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
