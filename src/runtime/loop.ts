import type { TaskExecutionOutput } from "../benchmark/types.js";
import type { ModelClient, ModelMessage, ModelPurpose, ModelRequest, ModelResponse, ModelToolDefinition, ModelTurnUsage, ModelUsage } from "../models/types.js";
import { normalizeToolResultForModel, type ToolCall, type ToolRegistry, type RuntimeHook, type ToolResult } from "../tools/registry.js";
import { decideToolUse } from "../tools/policy.js";
import { estimateTextTokens, shouldMicroCompact, resolveContextBudget, resolveToolOutputBudget, isContextOverflowError } from "./budget.js";
import { maybeCompactContext, type CompactionResult } from "./compaction.js";
import { buildModelContextView, enforceContextBudget, type ContextTrimResult, type ContextView } from "./context-view.js";
import { collapseContext, defaultContextCollapseConfig, shouldContextCollapse } from "./context-collapse.js";
import { microCompact, shouldTimeBasedMicroCompact, timeBasedMicroCompact } from "./micro-compact.js";
import { postCompactRestore } from "./post-compact-restore.js";
import { CacheBreakDetector, type CacheBreakResult } from "./cache-break.js";
import { BudgetTracker, shouldAutoContinue, type TokenBudgetConfig } from "./token-budget.js";
import type { BudgetDepletedPayload, CacheBreakPayload, ContextCompactionPayload, ContextTrimPayload, DiminishingReturnsPayload, MicroCompactPayload, ResponseTruncatedPayload, ToolResultPayload, ToolOutputTruncationMeta, TraceEvent, TraceEventObserver } from "./events.js";
import { appendAssistantEntry, appendToolResultEntry, ensureSessionEntries, type AgentSession, type CompactionSessionEntry, type SessionEntry } from "./session.js";
import type { ToolOutputTruncationMetadata } from "../tools/truncation.js";

export interface AgentLoopOptions {
	modelClient: ModelClient;
	toolRegistry?: ToolRegistry;
	hooks?: RuntimeHook[];
	createId?: () => string;
	now?: () => number;
	stableMemoryContext?: ModelMessage;
	dynamicMemoryContext?: ModelMessage;
	memoryContextItemIds?: { stable: string[]; dynamic: string[] };
	eventObserver?: TraceEventObserver;
	contextTransform?: (messages: ModelMessage[], session: AgentSession) => ModelMessage[] | Promise<ModelMessage[]>;
}

export async function runAgentLoop(
	session: AgentSession,
	options: AgentLoopOptions,
	signal?: AbortSignal,
): Promise<TaskExecutionOutput> {
	const createId = options.createId ?? (() => crypto.randomUUID());
	const now = options.now ?? Date.now;
	let lastResponse: ModelResponse | undefined;
	let overflowRecoveryAttempted = false;
	const cacheBreakDetector = new CacheBreakDetector();
	const budgetTracker = initBudgetTracker(session);

	const maxTurns = session.agent.runtime.maxTurns;
	while (maxTurns === undefined || session.turnCount < maxTurns) {
		session.turnCount += 1;
		const tools = modelTools(session, options.toolRegistry);
		const budget = resolveContextBudget(session.agent);
		const viewOptions = {
			budget,
			...(options.stableMemoryContext ? { stableMemoryContext: options.stableMemoryContext } : {}),
			...(options.dynamicMemoryContext ? { dynamicMemoryContext: options.dynamicMemoryContext } : {}),
			...(options.memoryContextItemIds ? { memoryContextItemIds: options.memoryContextItemIds } : {}),
		};
		let contextView = buildModelContextView(session, viewOptions);

		const collapseConfig = contextCollapseConfig(session);
		if (shouldContextCollapse(session, collapseConfig)) {
			const collapseResult = collapseContext(session, collapseConfig, budget);
			if (collapseResult.collapsed) {
				recordEvent(session, options, event(createId, now, "context_collapse", session, collapseResult));
				contextView = buildModelContextView(session, viewOptions);
			}
		}

		if (shouldTimeBasedMicroCompact(session, budget.microCompact.timeBased, now)) {
			const tbmcResult = timeBasedMicroCompact(session, budget.microCompact.timeBased, budget, now);
			if (tbmcResult.cleared) {
				recordEvent(session, options, event(createId, now, "time_based_micro_compact", session, tbmcResult));
				contextView = buildModelContextView(session, viewOptions);
			}
		}

		if (shouldMicroCompact({ config: budget.microCompact, tokens: contextView.tokenEstimate, budget })) {
			const mcResult = microCompact(session, budget.microCompact, budget);
			if (mcResult.compacted) {
				recordEvent(session, options, event(createId, now, "micro_compact", session, mcResult));
				contextView = buildModelContextView(session, viewOptions);
			}
		}

		const memoryContent = compactionMemoryContent(options);
		const compaction = await maybeCompactContext({ session, modelClient: options.modelClient, budget, contextView, createId, now, ...(signal ? { signal } : {}), ...(memoryContent ? { memoryContent } : {}) });
		if (compaction.compacted || compaction.reason === "failed" || compaction.reason === "circuit_breaker") recordEvent(session, options, event(createId, now, "context_compaction", session, compaction));
		updateCompactionFailureState(session, compaction);
		if (compaction.compacted) {
			contextView = buildModelContextView(session, viewOptions);
		}
		const trim = enforceContextBudget(session, viewOptions);
		if (trim.trimmed) recordEvent(session, options, event(createId, now, "context_trim", session, traceContextTrim(trim)));
		if (trim.reason === "untrimmable" && budget.failureMode === "error") throw new Error(`context remains over budget after trim: ${trim.tokenEstimateAfter} tokens`);
		contextView = trim.view;
		if (compaction.compacted) {
			const restoreSourceEntries = getCompactedSourceEntries(session);
			if (restoreSourceEntries.length > 0) {
				const restore = postCompactRestore(restoreSourceEntries);
				if (restore.messages.length > 0) {
					contextView = { ...contextView, messages: [...restore.messages, ...contextView.messages] };
					recordEvent(session, options, event(createId, now, "post_compact_restore", session, { restoredFiles: restore.restoredFiles, messageCount: restore.messages.length }));
				}
			}
		}
		let modelMessages = contextView.messages;
		if (options.contextTransform) {
			modelMessages = await options.contextTransform(modelMessages, session);
			recordEvent(session, options, event(createId, now, "context_transform", session, { messageCount: modelMessages.length }));
		}

		const purpose = modelPurpose(session, tools.length);
		const request: ModelRequest = {
			agent: session.agent,
			task: session.task,
			messages: modelMessages,
			turn: session.turnCount,
			purpose,
			routing: { inputTokenEstimate: contextView.tokenEstimate, ...(tools.length > 0 ? { toolCount: tools.length } : {}) },
			sessionId: session.id,
			...(tools.length > 0 ? { tools } : {}),
		};

		let modelStartedAt = now();
		recordModelRequest(session, options, createId, now, request, purpose, contextView, modelStartedAt);
		try {
			lastResponse = await options.modelClient.complete(request, signal);
		} catch (error) {
			if (!isContextOverflowError(error) || overflowRecoveryAttempted) throw error;
			overflowRecoveryAttempted = true;
			const recovery = await maybeCompactContext({ session, modelClient: options.modelClient, budget, contextView, createId, now, force: true, ...(signal ? { signal } : {}), ...(memoryContent ? { memoryContent } : {}) });
			recordEvent(session, options, event(createId, now, "context_compaction", session, recovery));
			updateCompactionFailureState(session, recovery);
			if (!recovery.compacted) throw error;
			contextView = buildModelContextView(session, viewOptions);
			const recoveryTrim = enforceContextBudget(session, viewOptions);
			if (recoveryTrim.trimmed) recordEvent(session, options, event(createId, now, "context_trim", session, traceContextTrim(recoveryTrim)));
			contextView = recoveryTrim.view;
			request.messages = contextView.messages;
			request.routing = { inputTokenEstimate: contextView.tokenEstimate, ...(tools.length > 0 ? { toolCount: tools.length } : {}) };
			modelStartedAt = now();
			recordModelRequest(session, options, createId, now, request, purpose, contextView, modelStartedAt);
			lastResponse = await options.modelClient.complete(request, signal);
		}
		const modelEndedAt = now();
		const timing = lastResponse.timing ?? { startedAt: modelStartedAt, endedAt: modelEndedAt, durationMs: Math.max(0, modelEndedAt - modelStartedAt) };
		const turnUsage = modelTurnUsage(lastResponse, request, contextView.tokenEstimate, contextView.messages.length);
		recordEvent(session, options, event(createId, now, "model_response", session, { ...lastResponse, turn: request.turn, purpose, inputTokenEstimate: contextView.tokenEstimate, messageCount: contextView.messages.length, usageSource: turnUsage.source, turnUsage, timing }));

		if (lastResponse.usage) {
			session.lastTurnEstimatedInputTokens = contextView.tokenEstimate;
			session.lastTurnIncludedEntryIds = contextView.includedEntryIds;
			if (lastResponse.usage.inputTokens !== undefined) {
				session.lastTurnRealInputTokens = lastResponse.usage.inputTokens;
				session.cumulativeRealInputTokens = (session.cumulativeRealInputTokens ?? 0) + lastResponse.usage.inputTokens;
			}
			session.cumulativeRealOutputTokens = (session.cumulativeRealOutputTokens ?? 0) + (lastResponse.usage.outputTokens ?? 0);
		}

		detectAndRecordCacheBreak(session, options, cacheBreakDetector, request, lastResponse, createId, now);
			consumeTokenBudget(budgetTracker, lastResponse, session);

			appendAssistantEntry(session, lastResponse, createId(), now());

		const truncationReason = detectTruncation(lastResponse);
		if (truncationReason) {
			recordEvent(session, options, event(createId, now, "response_truncated", session, { reason: truncationReason, textLength: lastResponse.text?.length ?? 0 }));
		}

		if (!lastResponse.toolCalls || lastResponse.toolCalls.length === 0) {
			return { answer: lastResponse.text ?? "", trace: session.trace };
		}

		if (!options.toolRegistry) {
			throw new Error("model requested tools but no tool registry was provided");
		}

		const results = await executeToolCalls(
			session,
			lastResponse.toolCalls.map((modelCall) => ({ id: modelCall.id, name: modelCall.name, input: modelCall.input })),
			{ ...options, toolRegistry: options.toolRegistry },
			createId,
			now,
			signal,
		);
		for (const result of results) {
			const toolBudget = resolveToolOutputBudget(session.agent, result.call.name, result.maxResultBytes);
			const normalized = normalizeToolResultForModel(result, toolBudget);
			const entry = appendToolResultEntry(session, result, { id: createId(), createdAt: now(), content: normalized.content, truncation: normalized.metadata });
			recordEvent(session, options, event(createId, now, "tool_result", session, traceToolResult(result, entry.id, normalized.content, normalized.metadata)));
		}

		if (budgetTracker) {
			const staleTurns = session.agent.runtime.contextBudget?.contextCollapse?.preserveRecentTurns ?? 3;
			const decision = shouldAutoContinue(budgetTracker, session.turnCount, maxTurns, staleTurns);
			if (!decision.continue) {
				if (decision.reason === "budget_depleted") {
					recordEvent(session, options, event(createId, now, "budget_depleted", session, budgetDepletedPayload(budgetTracker, session.turnCount)));
				} else if (decision.reason === "diminishing_returns") {
					recordEvent(session, options, event(createId, now, "diminishing_returns", session, diminishingPayload(budgetTracker, session.turnCount)));
				}
				break;
			}
		}
	}

	return { answer: lastResponse?.text ?? "", trace: session.trace };
}

async function executeToolCalls(
	session: AgentSession,
	calls: ToolCall[],
	options: AgentLoopOptions & { toolRegistry: ToolRegistry },
	createId: () => string,
	now: () => number,
	signal?: AbortSignal,
): Promise<ToolResult[]> {
	const results: ToolResult[] = [];
	let index = 0;
	while (index < calls.length) {
		const batch = [calls[index]!];
		index += 1;
		while (index < calls.length && isParallelSafe(options.toolRegistry, batch[0]!) && isParallelSafe(options.toolRegistry, calls[index]!)) {
			batch.push(calls[index]!);
			index += 1;
		}

		for (const call of batch) {
			recordEvent(session, options, event(createId, now, "tool_call", session, { call, concurrency: options.toolRegistry.get(call.name)?.concurrency ?? "sequential" }));
		}

		const batchResults = batch.length > 1
			? await Promise.all(batch.map((call) => options.toolRegistry.execute(session, call, options.hooks, signal)))
			: [await options.toolRegistry.execute(session, batch[0]!, options.hooks, signal)];

		results.push(...batchResults);
	}
	return results;
}

function recordModelRequest(session: AgentSession, options: AgentLoopOptions, createId: () => string, now: () => number, request: ModelRequest, purpose: ModelPurpose, contextView: ContextView, startedAt: number): void {
	recordEvent(session, options, event(createId, now, "model_request", session, {
		turn: request.turn,
		purpose,
		startedAt,
		messageCount: contextView.messages.length,
		tokenEstimate: contextView.tokenEstimate,
		includedEntryIds: contextView.includedEntryIds,
		omittedEntryIds: contextView.omittedEntryIds,
		compactionEntryIds: contextView.compactionEntryIds,
		messagesPreview: contextView.messagesPreview,
		...(contextView.memoryContext ? { memoryContext: contextView.memoryContext } : {}),
		...(contextView.budgetSnapshot ? { budgetSnapshot: contextView.budgetSnapshot } : {}),
	}));
}

function recordEvent(session: AgentSession, options: AgentLoopOptions, event: TraceEvent): void {
	session.trace.push(event);
	try {
		void options.eventObserver?.(event);
	} catch {
		// UI observers must not affect runtime execution.
	}
}

function updateCompactionFailureState(session: AgentSession, compaction: CompactionResult): void {
	if (compaction.reason === "failed") {
		session.consecutiveCompactionFailures = (session.consecutiveCompactionFailures ?? 0) + 1;
	} else if (compaction.compacted) {
		session.consecutiveCompactionFailures = 0;
	}
}

function isParallelSafe(registry: ToolRegistry, call: ToolCall): boolean {
	return registry.get(call.name)?.concurrency === "parallel-safe";
}

function modelTools(session: AgentSession, registry?: ToolRegistry): ModelToolDefinition[] {
	if (!registry) return [];
	return registry
		.list()
		.filter((tool) => decideToolUse(session.agent, session.task, tool).decision === "allow")
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
		}));
}

function modelPurpose(session: AgentSession, toolCount: number): ModelPurpose {
	const rules = session.agent.modelRouting?.purposeRules;
	if (rules?.codingTasks === true && session.task.type === "coding") return "coding";
	if (rules?.toolHeavy === true && toolCount > 0) return "tool-heavy";
	return "main";
}

function traceContextTrim(result: ContextTrimResult): ContextTrimPayload {
	return {
		reason: result.reason,
		tokenEstimateBefore: result.tokenEstimateBefore,
		tokenEstimateAfter: result.tokenEstimateAfter,
		trimmedEntryIds: result.trimmedEntryIds,
		keptEntryIds: result.keptEntryIds,
	};
}

function traceToolResult(result: ToolResult, entryId: string, visibleContent: string, truncationMeta: ToolOutputTruncationMetadata): ToolResultPayload {
	const toolOutput: ToolOutputTruncationMeta = {
		truncated: truncationMeta.truncated,
		strategy: truncationMeta.strategy,
		originalBytes: truncationMeta.originalBytes,
		visibleBytes: truncationMeta.visibleBytes,
		maxBytes: truncationMeta.maxBytes,
		...(truncationMeta.headBytes === undefined ? {} : { headBytes: truncationMeta.headBytes }),
		...(truncationMeta.tailBytes === undefined ? {} : { tailBytes: truncationMeta.tailBytes }),
		...(truncationMeta.omittedBytes === undefined ? {} : { omittedBytes: truncationMeta.omittedBytes }),
	};
	return {
		call: result.call,
		decision: result.decision,
		status: result.status,
		...(result.output === undefined ? {} : { output: result.output }),
		...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
		...(result.errorCategory ? { errorCategory: result.errorCategory } : {}),
		...(result.errorSource ? { errorSource: result.errorSource } : {}),
		...(result.errorPhase ? { errorPhase: result.errorPhase } : {}),
		...(result.retryable === undefined ? {} : { retryable: result.retryable }),
		...(result.rawErrorName ? { rawErrorName: result.rawErrorName } : {}),
		...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
		...(result.endedAt === undefined ? {} : { endedAt: result.endedAt }),
		...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
		metadata: { ...result.metadata, entryId, toolOutput },
		visibleContentPreview: previewText(visibleContent),
	};
}

function previewText(value: string): string {
	const limit = 2_000;
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}...[preview truncated ${value.length - limit} chars]`;
}

function detectTruncation(response: ModelResponse): string | undefined {
	const meta = response.metadata;
	if (!meta || typeof meta !== "object") return undefined;
	const record = meta as Record<string, unknown>;
	const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
	const finishReason = typeof record.finishReason === "string" ? record.finishReason : undefined;
	if (stopReason === "max_tokens") return "anthropic:max_tokens";
	if (finishReason === "length") return "openai:length";
	return undefined;
}

function event<T extends TraceEvent["type"]>(
	createId: () => string,
	now: () => number,
	type: T,
	session: AgentSession,
	payload: ExtractPayload<T>,
): Extract<TraceEvent, { type: T }> {
	return {
		id: createId(),
		type,
		timestamp: now(),
		agentId: session.agent.id,
		taskId: session.task.id,
		payload,
		sessionId: session.id,
		...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
		...(session.parentToolCallId ? { parentToolCallId: session.parentToolCallId } : {}),
		...(session.subagentId ? { subagentId: session.subagentId } : {}),
	} as Extract<TraceEvent, { type: T }>;
}

type ExtractPayload<T extends TraceEvent["type"]> = Extract<TraceEvent, { type: T }>["payload"];

function contextCollapseConfig(session: AgentSession) {
	const spec = session.agent.runtime.contextBudget?.contextCollapse;
	return {
		enabled: spec?.enabled ?? defaultContextCollapseConfig().enabled,
		preserveRecentTurns: spec?.preserveRecentTurns ?? defaultContextCollapseConfig().preserveRecentTurns,
	};
}


function compactionMemoryContent(options: AgentLoopOptions): string | undefined {
	const parts: string[] = [];
	if (options.stableMemoryContext?.content) parts.push(options.stableMemoryContext.content);
	if (options.dynamicMemoryContext?.content) parts.push(options.dynamicMemoryContext.content);
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function getCompactedSourceEntries(session: AgentSession): SessionEntry[] {
	const entries = ensureSessionEntries(session);
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.kind === "compaction") {
			const comp = entry as CompactionSessionEntry;
			return comp.sourceEntryIds.map((id) => entries.find((e) => e.id === id)).filter((e): e is SessionEntry => e !== undefined);
		}
	}
	return [];
}

function modelTurnUsage(response: ModelResponse, request: ModelRequest, inputTokenEstimate: number, messageCount: number): ModelTurnUsage {
	const purpose = request.purpose ?? "main";
	if (response.usage) {
		return { turn: request.turn, purpose, inputTokenEstimate, messageCount, usage: response.usage, source: "provider" };
	}
	const outputTokens = estimateTextTokens((response.text ?? "") + (response.reasoning ?? ""));
	const inputTokens = inputTokenEstimate;
	const estimated: ModelUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
	return { turn: request.turn, purpose, inputTokenEstimate, messageCount, usage: estimated, source: "estimated" };
}

	function detectAndRecordCacheBreak(
		session: AgentSession,
		options: AgentLoopOptions,
		detector: CacheBreakDetector,
		request: ModelRequest,
		response: ModelResponse,
		createId: () => string,
		now: () => number,
	): void {
		const systemMsg = request.messages.find((m) => m.role === "system");
		const systemContent = systemMsg?.content ?? "";
		const tools = request.tools ?? [];
		const cacheReadTokens = response.usage?.cacheReadTokens;
		const result = detector.detect({ systemContent, toolDefinitions: tools, cacheReadTokens });
		if (result.broken) {
			recordEvent(session, options, event(createId, now, "cache_break", session, cacheBreakPayload(result, request.turn)));
		}
	}

	function cacheBreakPayload(result: CacheBreakResult, turn: number): CacheBreakPayload {
		return {
			broken: result.broken,
			reason: result.reason,
			...(result.previousCacheReadTokens === undefined ? {} : { previousCacheReadTokens: result.previousCacheReadTokens }),
			...(result.currentCacheReadTokens === undefined ? {} : { currentCacheReadTokens: result.currentCacheReadTokens }),
			turn,
		};
	}

	function initBudgetTracker(session: AgentSession): BudgetTracker | undefined {
		const tokenBudget = session.agent.runtime.tokenBudget;
		if (tokenBudget === undefined || tokenBudget <= 0) return undefined;
		return new BudgetTracker({ totalBudget: tokenBudget });
	}

	function consumeTokenBudget(tracker: BudgetTracker | undefined, response: ModelResponse, session: AgentSession): void {
		if (!tracker || !response.usage) return;
		const toolCallCount = response.toolCalls?.length ?? 0;
		tracker.consume(response.usage, toolCallCount);
	}

	function budgetDepletedPayload(tracker: BudgetTracker, turn: number): BudgetDepletedPayload {
		const snap = tracker.snapshot();
		return { consumedTokens: snap.consumedInputTokens + snap.consumedOutputTokens, totalBudget: snap.totalBudget, turn };
	}

	function diminishingPayload(tracker: BudgetTracker, turn: number): DiminishingReturnsPayload {
		return { noToolCallStreak: tracker.snapshot().noToolCallStreak, turn };
	}
