import type { ContextViewPayload } from "../runtime/events.js";
import type { ModelMessage, ModelResponse } from "../models/types.js";
import type { TraceEvent } from "../runtime/events.js";
import type { ToolCall, ToolResult } from "../tools/registry.js";
import { StatsAccumulator } from "./stats.js";
import { renderToolCall, renderToolResultText } from "./tool-renderers.js";
import type { EvolutionHistoryRecord } from "../evolution/history-store.js";
import type { ChatLogEntry, ChatLogSeverity, ContextUsage, RunningToolEntry, ChatStateOptions, ChatStateSnapshot, ChatStatus, ChatView } from "./types.js";

const DEFAULT_MAX_LOG_ENTRIES = 200;
const DEFAULT_MAX_TRACE_EVENTS = 500;

export class ChatState {
	private readonly log: ChatLogEntry[] = [];
	private readonly runningTools = new Map<string, RunningToolEntry>();
	private readonly trace: TraceEvent[] = [];
	private stats = new StatsAccumulator();
	private status: ChatStatus = "idle";
	private activeView: ChatView = "chat";
	private turnCount = 0;
	private toolCallCount = 0;
	private lastError: string | undefined;
	private streamingAssistantLogId: string | undefined;
	private runStartedAt: number | undefined;
	private runDurationMs: number | undefined;
	private toolDurationMs = 0;
	private mcpDurationMs = 0;
	private skillDurationMs = 0;
	private readonly now: () => number;
	private readonly createId: () => string;
	private currentModel: string;
	private currentProvider: string;
	private contextUsage: ContextUsage | undefined;
	private evolutionHistory: EvolutionHistoryRecord[] = [];

	constructor(private options: ChatStateOptions) {
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? (() => crypto.randomUUID());
		this.currentModel = options.model;
		this.currentProvider = options.provider;
	}

	snapshot(): ChatStateSnapshot {
		const runningTool = Array.from(this.runningTools.values()).at(-1);
		return {
			agentName: this.options.agentName,
			agentId: this.options.agentId,
			model: this.currentModel,
			provider: this.currentProvider,
			...(this.options.reasoningLevel ? { reasoningLevel: this.options.reasoningLevel } : {}),
			toolProfile: this.options.toolProfile,
			mcpServerCount: this.options.mcpServerCount ?? 0,
			cwd: this.options.cwd,
			sessionId: this.options.sessionId,
			...(this.options.maxToolCalls === undefined ? {} : { maxToolCalls: this.options.maxToolCalls }),
			status: this.status,
			turnCount: this.turnCount,
			toolCallCount: this.toolCallCount,
			...(runningTool ? { runningToolName: runningTool.name } : {}),
			...(this.runStartedAt === undefined ? {} : { runStartedAt: this.runStartedAt }),
			...(this.runDurationMs === undefined ? {} : { runDurationMs: this.runDurationMs }),
			toolDurationMs: this.toolDurationMs,
			mcpDurationMs: this.mcpDurationMs,
			skillDurationMs: this.skillDurationMs,
			...(this.lastError ? { lastError: this.lastError } : {}),
			activeView: this.activeView,
			stats: this.stats.snapshot(this.now()),
			log: [...this.log],
			runningTools: Array.from(this.runningTools.values()),
			trace: [...this.trace],
			...(this.contextUsage ? { contextUsage: this.contextUsage } : {}),
			evolutionHistory: [...this.evolutionHistory],
		};
	}

	reset(options: ChatStateOptions): void {
		this.options = options;
		this.currentModel = options.model;
		this.currentProvider = options.provider;
		this.log.length = 0;
		this.runningTools.clear();
		this.trace.length = 0;
		this.stats = new StatsAccumulator();
		this.status = "idle";
		this.activeView = "chat";
		this.turnCount = 0;
		this.toolCallCount = 0;
		this.lastError = undefined;
		this.streamingAssistantLogId = undefined;
		this.runStartedAt = undefined;
		this.runDurationMs = undefined;
		this.toolDurationMs = 0;
		this.mcpDurationMs = 0;
		this.skillDurationMs = 0;
			this.contextUsage = undefined;
		this.evolutionHistory = [];
	}

	addUserMessage(text: string): void {
		this.addLog({ kind: "user", text, severity: "info" });
	}

	addSystemMessage(text: string): void {
		this.addLog({ kind: "system", text, severity: "info" });
	}

	addError(text: string): void {
		this.lastError = text;
		this.status = "error";
		this.addLog({ kind: "error", text, severity: "error" });
	}

	hasErrorMessage(text: string): boolean {
		return this.lastError === text;
	}

	clearLog(): void {
		this.log.length = 0;
	}

	/** 用已存储会话的消息重建聊天记录（仅用户/助手文本，不含 system prompt 与工具细节）。 */
	restoreMessages(messages: ModelMessage[]): void {
		this.clearLog();
		for (const message of messages) {
			if (!message.content.trim()) continue;
			// system 角色 = 系统提示词/工具声明，属内部配置，不展示给用户
			if (message.role === "system") continue;
			if (message.role === "user") this.addLog({ kind: "user", text: message.content, severity: "info" });
			else if (message.role === "assistant") this.addLog({ kind: "assistant", text: message.content, severity: "info" });
		}
	}

	setView(view: ChatView): void {
		this.activeView = view;
	}

	setEvolutionHistory(records: EvolutionHistoryRecord[]): void {
		this.evolutionHistory = records;
	}

	getEvolutionHistory(): EvolutionHistoryRecord[] {
		return this.evolutionHistory;
	}

	/** 导出统计供持久化。 */
	serializeStats(): Record<string, unknown> {
		return this.stats.serialize();
	}

	/** 恢复持久化的统计（resume 会话时）。 */
	restoreStats(data: Record<string, unknown> | undefined): void {
		this.stats.restore(data);
	}

	applyTraceEvent(event: TraceEvent): void {
		this.stats.apply(event);
		this.trace.push(event);
		trimToLimit(this.trace, this.options.maxTraceEvents ?? DEFAULT_MAX_TRACE_EVENTS);
		if (event.type === "run_start") this.applyRunStart(event);
		else if (event.type === "model_request") this.applyModelRequest(event);
		else if (event.type === "assistant_delta") this.applyAssistantDelta(event);
		else if (event.type === "model_response") this.applyModelResponse(event);
		else if (event.type === "tool_call") this.applyToolCall(event);
		else if (event.type === "tool_result") this.applyToolResult(event);
		else if (event.type === "score") this.addLog({ kind: "score", text: summarizePayload(event.payload), severity: "info" });
		else if (event.type === "interrupted") this.addSystemMessage("Turn interrupted");
		else if (event.type === "response_truncated") this.addLog({ kind: "error", text: `⚠ model output truncated (${summarizePayload(event.payload)})`, severity: "warning" });
		else if (event.type === "context_view") this.applyContextView(event);
		else if (event.type === "run_end") this.applyRunEnd(event);
		else if (event.type === "error") this.addError(errorMessage(event.payload));
	}

	private applyContextView(event: TraceEvent): void {
		const payload = event.payload as ContextViewPayload;
		this.contextUsage = {
			tokenEstimate: payload.tokenEstimate,
			budgetMaxTokens: payload.budgetMaxTokens,
			effectiveLimit: payload.effectiveLimit,
			usageFraction: payload.usageFraction,
		};
	}

	private applyRunStart(event: TraceEvent): void {
		this.status = "thinking";
		this.runStartedAt = event.timestamp;
		this.runDurationMs = undefined;
		this.toolDurationMs = 0;
		this.mcpDurationMs = 0;
		this.skillDurationMs = 0;
		this.lastError = undefined;
	}

	private applyModelRequest(event: TraceEvent): void {
		this.status = "thinking";
		const payload = event.payload as { turn?: number };
		if (typeof payload.turn === "number") this.turnCount = payload.turn;
	}

	private applyAssistantDelta(event: TraceEvent): void {
		const text = extractDeltaText(event.payload);
		if (!text) return;
		const existing = this.log.find((entry) => entry.id === this.streamingAssistantLogId);
		if (existing) {
			existing.text += text;
			return;
		}
		const entry = this.createLogEntry({ kind: "assistant", text, severity: "info" });
		this.log.push(entry);
		this.streamingAssistantLogId = entry.id;
		this.trimLog();
	}

	private applyModelResponse(event: TraceEvent): void {
		const response = event.payload as ModelResponse;
		this.applyModelRouting(response);
		if (response.text) this.upsertAssistantResponse(response.text);
		this.streamingAssistantLogId = undefined;
		if (this.runningTools.size === 0) this.status = "idle";
	}

	private applyModelRouting(response: ModelResponse): void {
		const routing = objectRecord(response.metadata?.routing);
		const model = stringField(routing, "model");
		const provider = stringField(routing, "provider");
		if (model) this.currentModel = model;
		if (provider) this.currentProvider = provider;
	}

	private applyToolCall(event: TraceEvent): void {
		const payload = event.payload as { call?: ToolCall };
		if (!payload.call) return;
		this.status = "running_tool";
		this.runningTools.set(payload.call.id, { id: payload.call.id, name: payload.call.name, input: payload.call.input, startedAt: event.timestamp, status: "running" });
		this.addLog({ kind: "tool_call", text: renderToolCall(payload.call, 100).join("\n"), toolCallId: payload.call.id, toolName: payload.call.name, raw: payload.call });
	}

	private applyToolResult(event: TraceEvent): void {
		const result = event.payload as ToolResult;
		this.runningTools.delete(result.call.id);
		this.toolCallCount += 1;
		this.addToolDuration(result);
		const severity = toolSeverity(result.status);
		this.addLog({ kind: "tool_result", text: renderToolResultText(result, 100), severity, toolCallId: result.call.id, toolName: result.call.name, raw: result });
		this.status = this.runningTools.size > 0 ? "running_tool" : "idle";
	}

	private applyRunEnd(event: TraceEvent): void {
		this.streamingAssistantLogId = undefined;
		const payload = event.payload as { status?: string; durationMs?: number };
		if (typeof payload.durationMs === "number") this.runDurationMs = payload.durationMs;
		else if (this.runStartedAt !== undefined) this.runDurationMs = Math.max(0, event.timestamp - this.runStartedAt);
		if (this.lastError || payload.status === "failed" || payload.status === "errored" || payload.status === "timeout") {
			this.lastError ??= `run ended with status: ${payload.status ?? "error"}`;
			this.status = "error";
		} else this.status = "done";
	}

	private addToolDuration(result: ToolResult): void {
		const durationMs = result.durationMs ?? 0;
		if (durationMs <= 0) return;
		this.toolDurationMs += durationMs;
		if (result.call.name.startsWith("mcp__")) this.mcpDurationMs += durationMs;
		else if (result.call.name === "Skill" || result.call.name.toLowerCase().startsWith("skill")) this.skillDurationMs += durationMs;
	}

	private upsertAssistantResponse(text: string): void {
		const existing = this.log.find((entry) => entry.id === this.streamingAssistantLogId);
		if (existing) {
			existing.text = text;
			return;
		}
		this.addLog({ kind: "assistant", text, severity: "info" });
	}

	private addLog(input: Omit<ChatLogEntry, "id" | "timestamp">): void {
		this.log.push(this.createLogEntry(input));
		this.trimLog();
	}

	private createLogEntry(input: Omit<ChatLogEntry, "id" | "timestamp">): ChatLogEntry {
		return { id: this.createId(), timestamp: this.now(), ...input };
	}

	private trimLog(): void {
		const removed = trimToLimit(this.log, this.options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES);
		if (removed > 0 && this.streamingAssistantLogId && !this.log.some((entry) => entry.id === this.streamingAssistantLogId)) this.streamingAssistantLogId = undefined;
	}
}

function toolSeverity(status: ToolResult["status"]): ChatLogSeverity {
	if (status === "success") return "success";
	if (status === "denied" || status === "timeout" || status === "error" || status === "limit_exceeded") return "error";
	return "warning";
}

function summarizePayload(payload: unknown): string {
	if (payload === undefined) return "";
	if (typeof payload === "string") return payload;
	try {
		const text = JSON.stringify(payload);
		return text.length > 240 ? `${text.slice(0, 237)}...` : text;
	} catch {
		return String(payload);
	}
}

function errorMessage(payload: unknown): string {
	const record = objectRecord(payload);
	const message = record.message;
	return typeof message === "string" ? message : summarizePayload(payload);
}

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" && field.length > 0 ? field : undefined;
}

function extractDeltaText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";
	const delta = (payload as { delta?: unknown }).delta;
	if (typeof delta === "string") return delta;
	const text = (payload as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
}

function trimToLimit<T>(items: T[], limit: number): number {
	if (limit <= 0) {
		const removed = items.length;
		items.length = 0;
		return removed;
	}
	const removed = Math.max(0, items.length - limit);
	if (removed > 0) items.splice(0, removed);
	return removed;
}
