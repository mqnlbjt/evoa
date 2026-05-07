import { formatTable } from "../cli/format.js";
import type { ChatServiceContext } from "../cli/chat-service.js";
import type { TuiState } from "./state.js";
import type { TuiView } from "./types.js";

export interface SlashCommandContext {
	state: TuiState;
	chat: ChatServiceContext;
	stop: () => void;
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
	if (name === "/exit" || name === "/quit") {
		context.stop();
		return { handled: true, exit: true };
	}
	if (name === "/status") return message(statusText(context));
	if (name === "/stats") return switchView(context, "stats");
	if (name === "/chat") return switchView(context, "chat");
	if (name === "/tools") return message(toolsText(context));
	if (name === "/memory") return message(memoryText(context));
	if (name === "/trace") return switchView(context, "trace");
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
		"/exit    Exit TUI",
		"/status  Show session/runtime status",
		"/stats   Show stats page",
		"/chat    Show chat page",
		"/tools   List available tools",
		"/memory  Show memory status",
		"/trace   Show trace page",
	].join("\n");
}

function statusText(context: SlashCommandContext): string {
	const snapshot = context.state.snapshot();
	return [
		`session: ${snapshot.sessionId}`,
		`agent: ${snapshot.agentName} (${snapshot.agentId})`,
		`model: ${snapshot.provider}/${snapshot.model}`,
		`profile: ${snapshot.toolProfile}`,
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

function memoryText(context: SlashCommandContext): string {
	return context.chat.memoryManager ? "memory: enabled" : "memory: disabled";
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
