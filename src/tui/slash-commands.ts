import { formatTable } from "../cli/format.js";
import type { ChatServiceContext } from "../cli/chat-service.js";
import type { MemoryItem } from "../memory/types.js";
import type { EvolutionHistoryRecord } from "../evolution/history-store.js";
import type { TuiState } from "./state.js";
import type { TuiView } from "./types.js";

export interface SlashCommandContext {
	state: TuiState;
	chat: ChatServiceContext;
	stop: () => void;
	newSession?: () => Promise<string>;
	loadEvolutionHistory?: (historyPath: string) => Promise<EvolutionHistoryRecord[]>;
}

export interface SlashCommandResult {
	handled: boolean;
	exit?: boolean;
	message?: string;
}

export async function handleSlashCommand(input: string, context: SlashCommandContext): Promise<SlashCommandResult> {
	const [name = "", ...args] = input.trim().split(/\s+/);
	if (!name.startsWith("/")) return { handled: false };
	if (name === "/help") return message(helpText());
	if (name === "/clear") {
		context.state.clearLog();
		context.state.addSystemMessage("Cleared");
		return { handled: true };
	}
	if (name === "/new") {
		if (!context.newSession) return message("New session is unavailable");
		const sessionId = await context.newSession();
		context.state.addSystemMessage(`Started new session: ${sessionId}`);
		return { handled: true };
	}
	if (name === "/exit" || name === "/quit") {
		context.stop();
		return { handled: true, exit: true };
	}
	if (name === "/status") return message(statusText(context));
	if (name === "/stats") return switchView(context, "stats");
	if (name === "/chat") return switchView(context, "chat");
	if (name === "/tools") return message(toolsText(context));
	if (name === "/memory") return message(await memoryText(context, args));
	if (name === "/trace") return message(traceText(context, args));
	if (name === "/trace-page") return switchView(context, "trace");
	if (name === "/evolve-history") return handleEvolveHistoryCommand(context, args);
	if (name === "/evolve") return switchView(context, "evolve");
	return message(`Unknown command: ${name}\nType /help for commands.`);
}

function message(text: string): SlashCommandResult {
	return { handled: true, message: text };
}

function switchView(context: SlashCommandContext, view: TuiView): SlashCommandResult {
	context.state.setView(view);
	return { handled: true };
}

function helpText(): string {
	return [
		"/help    Show commands",
		"/clear   Clear chat log",
		"/new     Start a new session",
		"/exit    Exit TUI",
		"/status  Show session/runtime status",
		"/stats   Show stats page",
		"/chat    Show chat page",
		"/tools   List available tools",
		"/memory [query] Show memory status or search memory",
		"/trace   Show recent trace events",
		"/trace N Show recent N trace events (max 50)",
		"/trace-page Show trace page",
		"/evolve  Show evolution view",
		"/evolve-history <path> Load evolution history from JSONL",
	].join("\n");
}

async function handleEvolveHistoryCommand(context: SlashCommandContext, args: string[]): Promise<SlashCommandResult> {
	const historyPath = args[0];
	if (!historyPath) return message("Usage: /evolve-history <path>");
	if (!context.loadEvolutionHistory) return message("Evolution history loading is not available");
	try {
		const records = await context.loadEvolutionHistory(historyPath);
		context.state.setEvolutionHistory(records);
		context.state.setView("evolve");
		context.state.addSystemMessage(`Loaded ${records.length} evolution history record(s) from ${historyPath}`);
		return { handled: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { handled: true, message: `Failed to load evolution history: ${message}` };
	}
}

function statusText(context: SlashCommandContext): string {
	const snapshot = context.state.snapshot();
	return [
		`session: ${snapshot.sessionId}`,
		`agent: ${snapshot.agentName} (${snapshot.agentId})`,
		`model: ${snapshot.provider}/${snapshot.model}`,
		`profile: ${snapshot.toolProfile}`,
		`mcp servers: ${snapshot.mcpServerCount}`,
		`status: ${snapshot.status}`,
		`view: ${snapshot.activeView}`,
		`turns: ${snapshot.turnCount}`,
		`tools: ${snapshot.toolCallCount}/${snapshot.maxToolCalls ?? "-"}`,
		`tokens: ${snapshot.stats.model.tokens.totalTokens}`,
		`model calls: ${snapshot.stats.model.responseCount}`,
	].join("\n");
}

function toolsText(context: SlashCommandContext): string {
	const rows = [["TOOL", "CONCURRENCY", "TIMEOUT", "DESCRIPTION"], ...context.chat.toolRegistry.list().map((tool) => [
		tool.name,
		tool.concurrency,
		tool.timeoutMs === undefined ? "-" : String(tool.timeoutMs),
		tool.description.slice(0, 60),
	])];
	return formatTable(rows);
}

async function memoryText(context: SlashCommandContext, args: string[]): Promise<string> {
	const manager = context.chat.memoryManager;
	if (!manager) return "memory: disabled";
	const query = args.join(" ").trim();
	try {
		if (query) return memorySearchText(await manager.search({ ...memoryRequest(context, query), query }), query);
		const items = await manager.loadContextItems(memoryRequest(context, lastUserPrompt(context)));
		return memorySummaryText(context, items.stable, items.dynamic);
	} catch (error) {
		return `memory: error\n${error instanceof Error ? error.message : String(error)}`;
	}
}

function memoryRequest(context: SlashCommandContext, prompt: string) {
	return { agentId: context.chat.agent.id, sessionId: context.chat.sessionId, projectId: context.chat.memoryProjectId, prompt, now: context.chat.now };
}

function memorySummaryText(context: SlashCommandContext, stable: MemoryItem[], dynamic: MemoryItem[]): string {
	return [
		"memory: enabled",
		`agent: ${context.chat.agent.id}`,
		`session: ${context.chat.sessionId}`,
		`project: ${context.chat.memoryProjectId}`,
		`stable: ${stable.length}`,
		`dynamic: ${dynamic.length}`,
		memoryPreviewTable([...stable, ...dynamic], 3, 56),
	].filter(Boolean).join("\n");
}

function memorySearchText(items: MemoryItem[], query: string): string {
	return [`memory search: ${query}`, `matches: ${items.length}`, memoryPreviewTable(items, 10, 80)].filter(Boolean).join("\n");
}

function memoryPreviewTable(items: MemoryItem[], limit: number, contentMaxLength: number): string {
	if (items.length === 0) return "No memory items found";
	return formatTable([["SCOPE", "LAYER", "ID", "CONTENT"], ...items.slice(0, limit).map((item) => [item.scope ?? "agent", item.layer, item.id, truncate(item.content, contentMaxLength)])]);
}

function lastUserPrompt(context: SlashCommandContext): string {
	for (const entry of [...context.chat.messages].reverse()) {
		if (entry.role === "user" && entry.content.trim()) return entry.content;
	}
	return "";
}

function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function traceText(context: SlashCommandContext, args: string[]): string {
	const limit = parseLimit(args[0]);
	const events = context.state.snapshot().trace.slice(-limit);
	if (events.length === 0) return "No trace events";
	return formatTable([["TYPE", "ID", "SUMMARY"], ...events.map((event) => [event.type, event.id, summarize(event.payload)])]);
}

function parseLimit(value: string | undefined): number {
	if (!value) return 10;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 50) : 10;
}

function summarize(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return text.length > 80 ? `${text.slice(0, 77)}...` : text;
	} catch {
		return String(value);
	}
}
