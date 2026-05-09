import type { ModelClient } from "../models/types.js";
import type { RuntimeHook, ToolCall, ToolRegistry } from "./registry.js";
import type { AgentSpec, SubagentSpec, TaskSpec } from "../specs.js";
import type { TraceEvent } from "../runtime/events.js";
import { runAgentLoop } from "../runtime/loop.js";
import { createAgentSession, type AgentSession } from "../runtime/session.js";
import { summarizeBranch } from "../runtime/branch-summarization.js";
import type { EvolvingAgentTool, ToolExecutionContext } from "./types.js";
import type { SubagentTranscriptStore } from "../sessions/subagent-transcript-store.js";

export interface SubagentToolInput {
	subagentId: string;
	task: string;
	title?: string;
	metadata?: Record<string, unknown>;
}

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
	trace: TraceEvent[];
	traceSummary: SubagentTraceSummary;
	errorMessage?: string;
	parentSessionId?: string;
	parentToolCallId?: string;
}

export interface SubagentToolOptions {
	subagents: SubagentSpec[];
	modelClient: ModelClient;
	createToolRegistryForAgent: (agent: AgentSpec) => ToolRegistry;
	hooks?: RuntimeHook[];
	createId?: () => string;
	now?: () => number;
	transcriptStore?: SubagentTranscriptStore;
}

export function createSubagentTool(options: SubagentToolOptions): EvolvingAgentTool<SubagentToolInput, SubagentToolOutput> {
	return {
		name: "subagent",
		description: "Run one bundle-defined subagent on a focused task and return its answer and trace summary.",
		inputSchema: {
			type: "object",
			properties: {
				subagentId: { type: "string" },
				task: { type: "string" },
				title: { type: "string" },
				metadata: { type: "object" },
			},
			required: ["subagentId", "task"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "medium" },
		concurrency: "sequential",
		maxResultBytes: 16 * 1024,
		async execute(input, signal, context) {
			if (!context) throw new Error("subagent tool requires execution context");
			const parsed = parseInput(input);
			const subagent = options.subagents.find((candidate) => candidate.id === parsed.subagentId);
			if (!subagent) throw new Error(`Unknown subagent: ${parsed.subagentId}`);

			const createId = options.createId ?? (() => crypto.randomUUID());
			const sessionId = createId();
			const task = createSubagentTask(parsed, context, subagent);
			const session = createAgentSession({
				id: sessionId,
				agent: subagent.agent,
				task,
				parentSessionId: context.session.id,
				parentToolCallId: context.call.id,
				subagentId: subagent.id,
			});

			try {
				let subagentRegistry = options.createToolRegistryForAgent(subagent.agent);
				if (subagent.agent.tools.allowedTools.length > 0) {
					subagentRegistry = subagentRegistry.filterByAllowedTools(subagent.agent.tools.allowedTools);
				}

				const result = await runAgentLoop(session, {
					modelClient: options.modelClient,
					toolRegistry: subagentRegistry,
					...(options.hooks ? { hooks: options.hooks } : {}),
					createId,
					...(options.now ? { now: options.now } : {}),
				}, signal);
				const trace = result.trace ?? session.trace;
				const summary = summarizeTraceInternal(trace, session);

				for (const event of trace) {
					context.session.trace.push(event);
				}

				const branchOutcome = summarizeBranch(context.session, {
					subagentId: subagent.id,
					task: parsed.task,
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
					trace,
					traceSummary: summary,
					parentSessionId: context.session.id,
					parentToolCallId: context.call.id,
				};
			} catch (error) {
				const trace = session.trace;
				const summary = summarizeTraceInternal(trace, session);

				for (const event of trace) {
					context.session.trace.push(event);
				}

				summarizeBranch(context.session, {
					subagentId: subagent.id,
					task: parsed.task,
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
					trace,
					traceSummary: summary,
					errorMessage: error instanceof Error ? error.message : String(error),
					parentSessionId: context.session.id,
					parentToolCallId: context.call.id,
				};
			}
		},
	};
}

function createSubagentTask(input: SubagentToolInput, context: ToolExecutionContext, subagent: SubagentSpec): TaskSpec {
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

function parseInput(input: unknown): SubagentToolInput {
	if (!isRecord(input)) throw new Error("subagent input must be an object");
	const subagentId = input.subagentId;
	const task = input.task;
	if (typeof subagentId !== "string" || subagentId.trim() === "") throw new Error("subagentId must be a non-empty string");
	if (typeof task !== "string" || task.trim() === "") throw new Error("task must be a non-empty string");
	const title = input.title;
	if (title !== undefined && typeof title !== "string") throw new Error("title must be a string");
	const metadata = input.metadata;
	if (metadata !== undefined && !isRecord(metadata)) throw new Error("metadata must be an object");
	return {
		subagentId,
		task,
		...(title === undefined ? {} : { title }),
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
		&& typeof value.answer === "string"
		&& Array.isArray(value.trace);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
