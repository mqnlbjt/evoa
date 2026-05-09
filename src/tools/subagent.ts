import type { ModelClient } from "../models/types.js";
import type { RuntimeHook, ToolCall, ToolRegistry } from "./registry.js";
import type { AgentSpec, SubagentSpec, TaskSpec } from "../specs.js";
import type { TraceEvent } from "../runtime/events.js";
import { runAgentLoop } from "../runtime/loop.js";
import { createAgentSession, type AgentSession } from "../runtime/session.js";
import { summarizeBranch } from "../runtime/branch-summarization.js";
import { isAbortError } from "../runtime/timeout.js";
import type { EvolvingAgentTool, ToolExecutionContext } from "./types.js";
import type { SubagentTranscriptStore } from "../sessions/subagent-transcript-store.js";

export interface SubagentTaskItem {
	subagentId: string;
	task: string;
	title?: string;
	allowedTools?: string[];
	systemPrompt?: string;
	metadata?: Record<string, unknown>;
}

export interface SubagentToolInput {
	subagentId?: string;
	task?: string;
	title?: string;
	allowedTools?: string[];
	systemPrompt?: string;
	metadata?: Record<string, unknown>;
	tasks?: SubagentTaskItem[];
}

type ParsedSubagentInput = { kind: "single"; item: SubagentTaskItem } | { kind: "batch"; items: SubagentTaskItem[] };

export interface SubagentTraceSummary {
	eventCount: number;
	modelRequestCount: number;
	modelResponseCount: number;
	toolCallCount: number;
	toolResultCount: number;
	errorCount: number;
	turnCount: number;
	totalDurationMs: number;
	inputTokens?: number;
	outputTokens?: number;
}

export interface SubagentToolOutput {
	subagentId: string;
	agentId: string;
	taskId: string;
	sessionId: string;
	status: "completed" | "errored";
	answer: string;
	traceSummary: SubagentTraceSummary;
	errorMessage?: string;
	parentSessionId?: string;
	parentToolCallId?: string;
}

export interface SubagentToolOptions {
	subagents: SubagentSpec[];
	modelClient: ModelClient;
	parentToolRegistry: ToolRegistry;
	hooks?: RuntimeHook[];
	createId?: () => string;
	now?: () => number;
	toolResultStorageDir?: string;
	transcriptStore?: SubagentTranscriptStore;
}

export function createSubagentTool(options: SubagentToolOptions): EvolvingAgentTool<SubagentToolInput, SubagentToolOutput | SubagentToolOutput[]> {
	return {
		name: "subagent",
		description: "Run subagent(s) on focused tasks. Use `subagentId`+`task` for a single subagent, or `tasks[]` to run multiple subagents in parallel. Returns each subagent's answer and trace summary.",
		inputSchema: {
			type: "object",
			properties: {
				subagentId: { type: "string" },
				task: { type: "string" },
				title: { type: "string" },
				allowedTools: { type: "array", items: { type: "string" } },
				systemPrompt: { type: "string" },
				metadata: { type: "object" },
				tasks: {
					type: "array",
					items: {
						type: "object",
						properties: {
							subagentId: { type: "string" },
							task: { type: "string" },
							title: { type: "string" },
							allowedTools: { type: "array", items: { type: "string" } },
							systemPrompt: { type: "string" },
							metadata: { type: "object" },
						},
						required: ["subagentId", "task"],
						additionalProperties: false,
					},
				},
			},
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "medium" },
		concurrency: "parallel-safe",
		maxResultBytes: 16 * 1024,
		async execute(input, signal, context) {
			if (!context) throw new Error("subagent tool requires execution context");
			const parsed = parseInput(input);

			if (parsed.kind === "batch") {
				const results = await Promise.allSettled(
					parsed.items.map((item) => runSingleSubagent(item, options, context, signal)),
				);
				return results.map((settled, index) => {
					if (settled.status === "fulfilled") return settled.value;
					const item = parsed.items[index]!;
					return erroredOutput(item, options, context, settled.reason instanceof Error ? settled.reason.message : String(settled.reason));
				});
			}

			return runSingleSubagent(parsed.item, options, context, signal);
		},
	};
}

async function runSingleSubagent(
	input: SubagentTaskItem,
	options: SubagentToolOptions,
	context: ToolExecutionContext,
	signal?: AbortSignal,
): Promise<SubagentToolOutput> {
	const subagent = options.subagents.find((candidate) => candidate.id === input.subagentId);
	if (!subagent) throw new Error(`Unknown subagent: ${input.subagentId}`);

	const createId = options.createId ?? (() => crypto.randomUUID());
	const sessionId = createId();
	const task = createSubagentTask(input, context, subagent);
	const parentAgent = context.session.agent;
	const agent: AgentSpec = {
		...parentAgent,
		id: subagent.agent.id,
		version: subagent.agent.version,
		name: subagent.agent.name,
		kind: subagent.agent.kind,
		prompts: input.systemPrompt !== undefined ? { ...subagent.agent.prompts, system: input.systemPrompt } : subagent.agent.prompts,
		tools: input.allowedTools !== undefined ? { ...subagent.agent.tools, allowedTools: input.allowedTools } : subagent.agent.tools,
		runtime: subagent.agent.runtime,
		...(subagent.agent.metadata !== undefined ? { metadata: subagent.agent.metadata } : {}),
	};
	const session = createAgentSession({
		id: sessionId,
		agent,
		task,
		parentSessionId: context.session.id,
		parentToolCallId: context.call.id,
		subagentId: subagent.id,
	});

	try {
		const subagentRegistry = options.parentToolRegistry.filterByAllowedTools(
			agent.tools.allowedTools.length > 0 ? agent.tools.allowedTools : ["*"],
		);

		const result = await raceAbort(
			runAgentLoop(session, {
				modelClient: options.modelClient,
				toolRegistry: subagentRegistry,
				...(options.hooks ? { hooks: options.hooks } : {}),
				createId,
				...(options.now ? { now: options.now } : {}),
				...(options.toolResultStorageDir ? { toolResultStorageDir: options.toolResultStorageDir } : {}),
			}, signal),
			signal,
		);
		const trace = result.trace ?? session.trace;
		const summary = summarizeTraceInternal(trace, session);

		summarizeBranch(context.session, {
			subagentId: subagent.id,
			task: input.task,
			answer: result.answer ?? "",
			status: "completed",
			turnCount: session.turnCount,
			durationMs: summary.totalDurationMs,
		}, createId, options.now ?? Date.now);

		if (options.transcriptStore) {
			const now = options.now ?? Date.now;
			await options.transcriptStore.saveTranscript({
				sessionId,
				parentSessionId: context.session.id,
				parentToolCallId: context.call.id,
				subagentId: subagent.id,
				agentId: subagent.agent.id,
				taskId: task.id,
				trace,
				summary,
				createdAt: now(),
			});
		}

		return {
			subagentId: subagent.id,
			agentId: subagent.agent.id,
			taskId: task.id,
			sessionId,
			status: "completed",
			answer: result.answer ?? "",
			traceSummary: summary,
			parentSessionId: context.session.id,
			parentToolCallId: context.call.id,
		};
	} catch (error) {
		const trace = session.trace;
		const summary = summarizeTraceInternal(trace, session);

		if (isAbortError(error, signal)) throw error;

		summarizeBranch(context.session, {
			subagentId: subagent.id,
			task: input.task,
			answer: "",
			status: "errored",
			errorMessage: error instanceof Error ? error.message : String(error),
			turnCount: session.turnCount,
			durationMs: summary.totalDurationMs,
		}, createId, options.now ?? Date.now);

		return {
			subagentId: subagent.id,
			agentId: subagent.agent.id,
			taskId: task.id,
			sessionId,
			status: "errored",
			answer: "",
			traceSummary: summary,
			errorMessage: error instanceof Error ? error.message : String(error),
			parentSessionId: context.session.id,
			parentToolCallId: context.call.id,
		};
	}
}

function erroredOutput(
	item: SubagentTaskItem,
	options: SubagentToolOptions,
	context: ToolExecutionContext,
	errorMessage: string,
): SubagentToolOutput {
	const subagent = options.subagents.find((candidate) => candidate.id === item.subagentId);
	const agentId = subagent?.agent.id ?? item.subagentId;
	return {
		subagentId: item.subagentId,
		agentId,
		taskId: `${context.session.task.id}::subagent::${item.subagentId}::${context.call.id}`,
		sessionId: "",
		status: "errored",
		answer: "",
		traceSummary: { eventCount: 0, modelRequestCount: 0, modelResponseCount: 0, toolCallCount: 0, toolResultCount: 0, errorCount: 1, turnCount: 0, totalDurationMs: 0 },
		errorMessage,
		parentSessionId: context.session.id,
		parentToolCallId: context.call.id,
	};
}

function createSubagentTask(input: SubagentTaskItem, context: ToolExecutionContext, subagent: SubagentSpec): TaskSpec {
	return {
		id: `${context.session.task.id}::subagent::${subagent.id}::${context.call.id}`,
		type: context.session.task.type,
		title: input.title ?? `Subagent ${subagent.id}`,
		prompt: input.task,
		scoring: { method: "custom", maxScore: 1 },
		metadata: {
			parentTaskId: context.session.task.id,
			parentSessionId: context.session.id,
			parentToolCallId: context.call.id,
			subagentId: subagent.id,
			...(input.metadata ?? {}),
		},
	};
}

function parseInput(input: unknown): ParsedSubagentInput {
	if (!isRecord(input)) throw new Error("subagent input must be an object");
	const tasks = input.tasks;
	if (tasks !== undefined) {
		if (!Array.isArray(tasks)) throw new Error("tasks must be an array");
		if (tasks.length === 0) throw new Error("tasks must not be empty");
		return { kind: "batch", items: tasks.map((t: unknown, i: number) => parseTaskItem(t, i)) };
	}
	const item = parseTaskItem(input, 0);
	return { kind: "single", item };
}

function parseTaskItem(input: unknown, index: number): SubagentTaskItem {
	if (!isRecord(input)) throw new Error(`tasks[${index}] must be an object`);
	const subagentId = input.subagentId;
	const task = input.task;
	if (typeof subagentId !== "string" || subagentId.trim() === "") throw new Error(`tasks[${index}].subagentId must be a non-empty string`);
	if (typeof task !== "string" || task.trim() === "") throw new Error(`tasks[${index}].task must be a non-empty string`);
	const title = input.title;
	if (title !== undefined && typeof title !== "string") throw new Error(`tasks[${index}].title must be a string`);
	const allowedTools = input.allowedTools;
	if (allowedTools !== undefined) {
		if (!Array.isArray(allowedTools) || allowedTools.some((t: unknown) => typeof t !== "string")) throw new Error(`tasks[${index}].allowedTools must be a string array`);
	}
	const systemPrompt = input.systemPrompt;
	if (systemPrompt !== undefined && typeof systemPrompt !== "string") throw new Error(`tasks[${index}].systemPrompt must be a string`);
	const metadata = input.metadata;
	if (metadata !== undefined && !isRecord(metadata)) throw new Error(`tasks[${index}].metadata must be an object`);
	return {
		subagentId,
		task,
		...(title === undefined ? {} : { title }),
		...(allowedTools === undefined ? {} : { allowedTools }),
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		...(metadata === undefined ? {} : { metadata }),
	};
}

function summarizeTraceInternal(trace: TraceEvent[], session: AgentSession): SubagentTraceSummary {
	const runEnd = trace.find((event) => event.type === "run_end");
	const durationMs: number | undefined = runEnd?.payload && typeof runEnd.payload === "object" && "durationMs" in runEnd.payload
		? (runEnd.payload as { durationMs: number }).durationMs
		: undefined;

	return {
		eventCount: trace.length,
		modelRequestCount: trace.filter((event) => event.type === "model_request").length,
		modelResponseCount: trace.filter((event) => event.type === "model_response").length,
		toolCallCount: trace.filter((event) => event.type === "tool_call").length,
		toolResultCount: trace.filter((event) => event.type === "tool_result").length,
		errorCount: trace.filter((event) => event.type === "error").length,
		turnCount: session.turnCount,
		totalDurationMs: durationMs ?? 0,
		...(session.cumulativeRealInputTokens === undefined ? {} : { inputTokens: session.cumulativeRealInputTokens }),
		...(session.cumulativeRealOutputTokens === undefined ? {} : { outputTokens: session.cumulativeRealOutputTokens }),
	};
}

export function summarizeTrace(trace: TraceEvent[]): SubagentTraceSummary {
	return {
		eventCount: trace.length,
		modelRequestCount: trace.filter((event) => event.type === "model_request").length,
		modelResponseCount: trace.filter((event) => event.type === "model_response").length,
		toolCallCount: trace.filter((event) => event.type === "tool_call").length,
		toolResultCount: trace.filter((event) => event.type === "tool_result").length,
		errorCount: trace.filter((event) => event.type === "error").length,
		turnCount: 0,
		totalDurationMs: 0,
	};
}

function runEndDurationMs(trace: TraceEvent[]): number | undefined {
	const runEnd = trace.find((event) => event.type === "run_end");
	return runEnd?.payload && typeof runEnd.payload === "object" && "durationMs" in runEnd.payload
		? (runEnd.payload as { durationMs: number }).durationMs
		: undefined;
}

export function isSubagentToolOutput(value: unknown): value is SubagentToolOutput {
	return isRecord(value)
		&& typeof value.subagentId === "string"
		&& typeof value.agentId === "string"
		&& typeof value.taskId === "string"
		&& typeof value.sessionId === "string"
		&& (value.status === "completed" || value.status === "errored")
		&& typeof value.answer === "string";
}

async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			signal.addEventListener("abort", () => {
				reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
			}, { once: true });
		}),
	]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
