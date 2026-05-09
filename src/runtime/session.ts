import type { ModelContentBlock, ModelMessage, ModelResponse } from "../models/types.js";
import type { AgentSpec, TaskSpec } from "../specs.js";
import type { ToolResult } from "../tools/registry.js";
import type { ToolOutputTruncationMetadata } from "../tools/truncation.js";
import type { TraceEvent } from "./events.js";

export type SessionEntryKind = "system" | "user" | "assistant" | "tool_result" | "compaction" | "branch_summary";

export interface SessionEntryBase {
	id: string;
	kind: SessionEntryKind;
	createdAt: number;
}

export interface SystemSessionEntry extends SessionEntryBase {
	kind: "system";
	message: ModelMessage;
}

export interface UserSessionEntry extends SessionEntryBase {
	kind: "user";
	message: ModelMessage;
}

export interface AssistantSessionEntry extends SessionEntryBase {
	kind: "assistant";
	message: ModelMessage;
}

export interface ToolResultSessionEntry extends SessionEntryBase {
	kind: "tool_result";
	message: ModelMessage;
	result?: ToolResult;
	modelVisibleContent: string;
	truncation?: ToolOutputTruncationMetadata;
}

export interface CompactionSessionEntry extends SessionEntryBase {
	kind: "compaction";
	summary: string;
	message: ModelMessage;
	sourceEntryIds: string[];
	keptRecentEntryIds: string[];
	tokenEstimateBefore: number;
	tokenEstimateAfter?: number;
	turn: number;
}

export interface BranchSummarySessionEntry extends SessionEntryBase {
	kind: "branch_summary";
	branchId: string;
	subagentId: string;
	task: string;
	answer: string;
	status: "completed" | "errored";
	errorMessage?: string;
	turnCount: number;
	durationMs: number;
	message: ModelMessage;
}

export type SessionEntry = SystemSessionEntry | UserSessionEntry | AssistantSessionEntry | ToolResultSessionEntry | CompactionSessionEntry | BranchSummarySessionEntry;

export interface AgentSession {
	id: string;
	agent: AgentSpec;
	task: TaskSpec;
	messages: ModelMessage[];
	entries?: SessionEntry[];
	trace: TraceEvent[];
	turnCount: number;
	toolCallCount: number;
	compactionCount?: number;
	consecutiveCompactionFailures?: number;
	collapsedEntryIds?: string[];
	cumulativeRealInputTokens?: number;
	cumulativeRealOutputTokens?: number;
	lastTurnEstimatedInputTokens?: number;
	lastTurnRealInputTokens?: number;
	lastTurnIncludedEntryIds?: string[];
	parentSessionId?: string;
	parentToolCallId?: string;
	subagentId?: string;
	sessionMemoryIds?: string[];
}

export interface AgentSessionOptions {
	id: string;
	agent: AgentSpec;
	task: TaskSpec;
	messages?: ModelMessage[];
	entries?: SessionEntry[];
	turnCount?: number;
	toolCallCount?: number;
	compactionCount?: number;
	consecutiveCompactionFailures?: number;
	cumulativeRealInputTokens?: number;
	cumulativeRealOutputTokens?: number;
	lastTurnEstimatedInputTokens?: number;
	lastTurnRealInputTokens?: number;
	lastTurnIncludedEntryIds?: string[];
	parentSessionId?: string;
	parentToolCallId?: string;
	subagentId?: string;
	sessionMemoryIds?: string[];
}

export interface AppendToolResultOptions {
	content: string;
	truncation?: ToolOutputTruncationMetadata;
	id?: string;
	createdAt?: number;
}

export interface AppendCompactionOptions {
	summary: string;
	sourceEntryIds: string[];
	keptRecentEntryIds: string[];
	tokenEstimateBefore: number;
	tokenEstimateAfter?: number;
	id?: string;
	createdAt?: number;
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
	const entries = options.entries ?? entriesFromMessages(options.messages ?? initialMessages(options.agent, options.task));
	const session: AgentSession = {
		id: options.id,
		agent: options.agent,
		task: options.task,
		messages: messagesFromEntries(entries),
		entries,
		trace: [],
		turnCount: options.turnCount ?? 0,
		toolCallCount: options.toolCallCount ?? 0,
		compactionCount: options.compactionCount ?? countCompactionEntries(entries),
		...(options.consecutiveCompactionFailures === undefined ? {} : { consecutiveCompactionFailures: options.consecutiveCompactionFailures }),
		...(options.cumulativeRealInputTokens === undefined ? {} : { cumulativeRealInputTokens: options.cumulativeRealInputTokens }),
		...(options.cumulativeRealOutputTokens === undefined ? {} : { cumulativeRealOutputTokens: options.cumulativeRealOutputTokens }),
		...(options.lastTurnEstimatedInputTokens === undefined ? {} : { lastTurnEstimatedInputTokens: options.lastTurnEstimatedInputTokens }),
		...(options.lastTurnRealInputTokens === undefined ? {} : { lastTurnRealInputTokens: options.lastTurnRealInputTokens }),
		...(options.lastTurnIncludedEntryIds === undefined ? {} : { lastTurnIncludedEntryIds: options.lastTurnIncludedEntryIds }),
		...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
		...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
		...(options.subagentId ? { subagentId: options.subagentId } : {}),
			...(options.sessionMemoryIds ? { sessionMemoryIds: options.sessionMemoryIds } : {}),
	};
	return session;
}

export function appendUserMessage(session: AgentSession, content: string): void {
	appendEntry(session, {
		id: createEntryId(),
		kind: "user",
		createdAt: Date.now(),
		message: { role: "user", content },
	});
}

export function appendAssistantEntry(session: AgentSession, response: ModelResponse, id = createEntryId(), createdAt = Date.now()): AssistantSessionEntry | undefined {
	if (!response.text && !response.reasoning && !response.toolCalls?.length) return undefined;
	const message: ModelMessage = {
		role: "assistant",
		content: response.text ?? "",
		contentBlocks: [
			...(response.reasoning ? [{ type: "reasoning" as const, text: response.reasoning }] : []),
			...(response.text ? [{ type: "text" as const, text: response.text }] : []),
			...(response.toolCalls?.map((call) => ({
				type: "tool_call" as const,
				id: call.id,
				name: call.name,
				...(call.input === undefined ? {} : { input: call.input }),
			})) ?? []),
		],
	};
	const entry: AssistantSessionEntry = { id, kind: "assistant", createdAt, message };
	appendEntry(session, entry);
	return entry;
}

export function appendToolResultEntry(session: AgentSession, result: ToolResult, options: AppendToolResultOptions): ToolResultSessionEntry {
	const message: ModelMessage = {
		role: "tool",
		toolCallId: result.call.id,
		toolName: result.call.name,
		content: options.content,
		contentBlocks: [
			{
				type: "tool_result",
				toolCallId: result.call.id,
				toolName: result.call.name,
				content: options.content,
				...(result.status !== "success" ? { isError: true } : {}),
			},
		],
	};
	const entry: ToolResultSessionEntry = {
		id: options.id ?? createEntryId(),
		kind: "tool_result",
		createdAt: options.createdAt ?? Date.now(),
		message,
		result,
		modelVisibleContent: options.content,
		...(options.truncation ? { truncation: options.truncation } : {}),
	};
	appendEntry(session, entry);
	return entry;
}

export function appendCompactionEntry(session: AgentSession, options: AppendCompactionOptions): CompactionSessionEntry {
	const message: ModelMessage = {
		role: "user",
		content: formatCompactionSummary(options.summary),
		contentBlocks: [{ type: "text", text: formatCompactionSummary(options.summary) }],
	};
	const entry: CompactionSessionEntry = {
		id: options.id ?? createEntryId(),
		kind: "compaction",
		createdAt: options.createdAt ?? Date.now(),
		summary: options.summary,
		message,
		sourceEntryIds: options.sourceEntryIds,
		keptRecentEntryIds: options.keptRecentEntryIds,
		tokenEstimateBefore: options.tokenEstimateBefore,
		...(options.tokenEstimateAfter === undefined ? {} : { tokenEstimateAfter: options.tokenEstimateAfter }),
		turn: session.turnCount,
	};
	session.compactionCount = (session.compactionCount ?? 0) + 1;
	appendEntry(session, entry);
	return entry;
}

export interface AppendBranchSummaryOptions {
	branchId: string;
	subagentId: string;
	task: string;
	answer: string;
	status: "completed" | "errored";
	errorMessage?: string;
	turnCount: number;
	durationMs: number;
	id?: string;
	createdAt?: number;
}

export function appendBranchSummaryEntry(session: AgentSession, options: AppendBranchSummaryOptions): BranchSummarySessionEntry {
	const summary = formatBranchSummaryForModel(options);
	const message: ModelMessage = {
		role: "user",
		content: summary,
		contentBlocks: [{ type: "text", text: summary }],
	};
	const entry: BranchSummarySessionEntry = {
		id: options.id ?? createEntryId(),
		kind: "branch_summary",
		createdAt: options.createdAt ?? Date.now(),
		branchId: options.branchId,
		subagentId: options.subagentId,
		task: options.task,
		answer: options.answer,
		status: options.status,
		...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
		turnCount: options.turnCount,
		durationMs: options.durationMs,
		message,
	};
	appendEntry(session, entry);
	return entry;
}

function formatBranchSummaryForModel(options: AppendBranchSummaryOptions): string {
	const header = `[Subagent "${options.subagentId}" ${options.status === "completed" ? "completed" : "errored"}]`;
	const lines = [header, `Task: ${options.task}`, `Turns: ${options.turnCount}`, `Duration: ${options.durationMs}ms`];
	if (options.answer) lines.push(`Answer: ${options.answer}`);
	if (options.errorMessage) lines.push(`Error: ${options.errorMessage}`);
	return lines.join("\n");
}

export function refreshSessionMessages(session: AgentSession): void {
	session.messages = messagesFromEntries(ensureSessionEntries(session));
}

export function ensureSessionEntries(session: AgentSession): SessionEntry[] {
	if (!session.entries) session.entries = entriesFromMessages(session.messages);
	if (session.compactionCount === undefined) session.compactionCount = countCompactionEntries(session.entries);
	return session.entries;
}

function countCompactionEntries(entries: SessionEntry[]): number {
	return entries.filter((entry) => entry.kind === "compaction").length;
}

export function entriesFromMessages(messages: ModelMessage[], now = Date.now): SessionEntry[] {
	return messages.map((message, index): SessionEntry => {
		const base = { id: `legacy-${index}`, createdAt: now() + index };
		if (message.role === "system") return { ...base, kind: "system", message };
		if (message.role === "user") return { ...base, kind: "user", message };
		if (message.role === "assistant") return { ...base, kind: "assistant", message };
		return { ...base, kind: "tool_result", message, modelVisibleContent: message.content };
	});
}

export function messagesFromEntries(entries: SessionEntry[]): ModelMessage[] {
	return entries.map((entry) => entry.message);
}

export function modelMessagesFromEntries(entries: SessionEntry[]): ModelMessage[] {
	return messagesFromEntries(entries);
}

function appendEntry(session: AgentSession, entry: SessionEntry): void {
	ensureSessionEntries(session).push(entry);
	refreshSessionMessages(session);
}

function initialMessages(agent: AgentSpec, task: TaskSpec): ModelMessage[] {
	return [
		{ role: "system", content: agent.prompts.system },
		{ role: "user", content: task.prompt },
	];
}

function formatCompactionSummary(summary: string): string {
	return `[Compacted conversation summary]\n${summary}`;
}

function createEntryId(): string {
	return crypto.randomUUID();
}
