import type { ModelMessage } from "../models/types.js";
import { estimateTextTokens } from "./budget.js";
import type { SessionEntry, ToolResultSessionEntry } from "./session.js";

export interface PostCompactRestoreConfig {
	maxFiles: number;
	maxTokensPerFile: number;
	maxTotalTokens: number;
}

const defaultConfig: PostCompactRestoreConfig = {
	maxFiles: 8,
	maxTokensPerFile: 5_000,
	maxTotalTokens: 50_000,
};

export interface PostCompactRestoreResult {
	messages: ModelMessage[];
	restoredFiles: string[];
}

export function postCompactRestore(
	sourceEntries: SessionEntry[],
	config: PostCompactRestoreConfig = defaultConfig,
): PostCompactRestoreResult {
	const fileResults = extractRestorableResults(sourceEntries);
	const recentExchange = extractRecentUserAssistant(sourceEntries);

	if (fileResults.length === 0 && !recentExchange.userMessage) {
		return { messages: [], restoredFiles: [] };
	}

	const messages: ModelMessage[] = [];
	const restoredFiles: string[] = [];
	let totalTokens = 0;

	// Task anchor: most recent user request before compaction
	if (recentExchange.userMessage) {
		const content = recentExchange.userMessage.content;
		const truncated = truncateContent(content, config.maxTokensPerFile);
		const tokens = estimateTextTokens(truncated);
		if (totalTokens + tokens <= config.maxTotalTokens) {
			totalTokens += tokens;
			messages.push({
				role: "user",
				content: `[Restored context: most recent user request before compaction]\n${truncated}`,
			});
		}
	}

	// Task anchor: most recent assistant response before compaction (the plan/reasoning)
	if (recentExchange.assistantMessage) {
		const content = recentExchange.assistantMessage.content;
		const truncated = truncateContent(content, config.maxTokensPerFile);
		const tokens = estimateTextTokens(truncated);
		if (totalTokens + tokens <= config.maxTotalTokens) {
			totalTokens += tokens;
			messages.push({
				role: "user",
				content: `[Restored context: most recent assistant plan before compaction]\n${truncated}`,
			});
		}
	}

	// Restore file content from tool results (Read, Grep, Glob, WebFetch)
	const latestByPath = deduplicateByPath(fileResults);
	const sorted = latestByPath.sort((a, b) => b.index - a.index);
	const selected = sorted.slice(0, config.maxFiles);

	for (const entry of selected) {
		const truncated = truncateContent(entry.content, config.maxTokensPerFile);
		const tokens = estimateTextTokens(truncated);
		if (totalTokens + tokens > config.maxTotalTokens) break;
		totalTokens += tokens;
		restoredFiles.push(entry.path);

		const truncatedNote = entry.content.length > truncated.length
			? `(content truncated to ~${config.maxTokensPerFile} tokens; original was ${entry.content.length} chars)\n`
			: "";
		const header = `[Restored context: previously fetched content]\nTool: ${entry.toolName}\nPath: ${entry.path}\n${truncatedNote}Content:\n${truncated}`;
		messages.push({ role: "user", content: header });
	}

	return { messages, restoredFiles };
}

interface RestorableResultEntry {
	path: string;
	content: string;
	index: number;
	toolName: string;
	offset?: number;
	limit?: number;
}

function extractRestorableResults(entries: SessionEntry[]): RestorableResultEntry[] {
	const results: RestorableResultEntry[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry?.kind !== "tool_result") continue;
		const toolResult = entry as ToolResultSessionEntry;
		const toolName = toolResult.message.toolName ?? toolResult.result?.call.name;
		if (!toolName || !isRestorableTool(toolName)) continue;
		const path = extractPath(toolResult, toolName);
		if (!path) continue;
		const content = toolResult.modelVisibleContent;
		if (!content || content.length === 0) continue;
		const restorable: RestorableResultEntry = { path, content, index: i, toolName };
		const off = readOffset(toolResult);
		const lim = readLimit(toolResult);
		if (off !== undefined) restorable.offset = off;
		if (lim !== undefined) restorable.limit = lim;
		results.push(restorable);
	}
	return results;
}

function extractRecentUserAssistant(entries: SessionEntry[]): { userMessage: ModelMessage | undefined; assistantMessage: ModelMessage | undefined } {
	let userMessage: ModelMessage | undefined;
	let assistantMessage: ModelMessage | undefined;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) continue;
		if (userMessage === undefined && entry.kind === "user") {
			userMessage = entry.message;
		}
		if (assistantMessage === undefined && entry.kind === "assistant") {
			assistantMessage = entry.message;
		}
		if (userMessage !== undefined && assistantMessage !== undefined) break;
	}

	return { userMessage, assistantMessage };
}

function deduplicateByPath(entries: RestorableResultEntry[]): RestorableResultEntry[] {
	const map = new Map<string, RestorableResultEntry>();
	for (const entry of entries) {
		const key = `${entry.toolName}:${entry.path}`;
		const existing = map.get(key);
		if (!existing || entry.index > existing.index) {
			map.set(key, entry);
		}
	}
	return [...map.values()];
}

function truncateContent(content: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (content.length <= maxChars) return content;
	const head = Math.floor(maxChars * 0.7);
	const tail = maxChars - head - 50;
	return `${content.slice(0, head)}\n\n...[content truncated: ${content.length - maxChars} chars omitted]...\n\n${content.slice(content.length - tail)}`;
}

function isRestorableTool(name: string): boolean {
	return name === "Read" || name === "read_file" || name === "read"
		|| name === "Grep" || name === "Glob"
		|| name === "WebFetch" || name === "web_fetch";
}

function extractPath(entry: ToolResultSessionEntry, toolName: string): string | undefined {
	const input = entry.result?.call.input;
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;

	if (toolName === "Grep") {
		return stringField(record, "path") ?? stringField(record, "pattern") ?? "(grep)";
	}
	if (toolName === "Glob") {
		return stringField(record, "pattern") ?? "(glob)";
	}
	if (toolName === "WebFetch" || toolName === "web_fetch") {
		return stringField(record, "url") ?? "(web_fetch)";
	}

	return stringField(record, "path") ?? stringField(record, "file_path") ?? stringField(record, "filePath");
}

function readOffset(entry: ToolResultSessionEntry): number | undefined {
	const input = entry.result?.call.input;
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	const offset = record["offset"];
	return typeof offset === "number" ? offset : undefined;
}

function readLimit(entry: ToolResultSessionEntry): number | undefined {
	const input = entry.result?.call.input;
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	const limit = record["limit"];
	return typeof limit === "number" ? limit : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
