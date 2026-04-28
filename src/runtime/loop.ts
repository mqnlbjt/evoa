import type { TaskExecutionOutput } from "../benchmark/types.js";
import type { ModelClient, ModelRequest, ModelResponse, ModelToolDefinition } from "../models/types.js";
import { normalizeToolResultContent, type ToolCall, type ToolRegistry, type RuntimeHook, type ToolResult } from "../tools/registry.js";
import { decideToolUse } from "../tools/policy.js";
import type { TraceEvent } from "./events.js";
import type { AgentSession } from "./session.js";

export interface AgentLoopOptions {
	modelClient: ModelClient;
	toolRegistry?: ToolRegistry;
	hooks?: RuntimeHook[];
	createId?: () => string;
	now?: () => number;
}

export async function runAgentLoop(
	session: AgentSession,
	options: AgentLoopOptions,
	signal?: AbortSignal,
): Promise<TaskExecutionOutput> {
	const createId = options.createId ?? (() => crypto.randomUUID());
	const now = options.now ?? Date.now;
	let lastResponse: ModelResponse | undefined;

	while (session.turnCount < session.agent.runtime.maxTurns) {
		session.turnCount += 1;
		const tools = modelTools(session, options.toolRegistry);
		const request: ModelRequest = {
			agent: session.agent,
			task: session.task,
			messages: session.messages,
			turn: session.turnCount,
			...(tools.length > 0 ? { tools } : {}),
		};

		session.trace.push(event(createId, now, "model_request", session, { messages: request.messages, turn: request.turn }));
		lastResponse = await options.modelClient.complete(request, signal);
		session.trace.push(event(createId, now, "model_response", session, lastResponse));

		if (lastResponse.text || lastResponse.toolCalls?.length) {
			session.messages.push({
				role: "assistant",
				content: lastResponse.text ?? "",
				contentBlocks: [
					...(lastResponse.text ? [{ type: "text" as const, text: lastResponse.text }] : []),
					...(lastResponse.toolCalls?.map((call) => ({
						type: "tool_call" as const,
						id: call.id,
						name: call.name,
						...(call.input === undefined ? {} : { input: call.input }),
					})) ?? []),
				],
			});
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
			const content = normalizeToolResultContent(result);
			session.messages.push({
				role: "tool",
				toolCallId: result.call.id,
				toolName: result.call.name,
				content,
				contentBlocks: [
					{
						type: "tool_result",
						toolCallId: result.call.id,
						toolName: result.call.name,
						content,
						...(result.status !== "success" ? { isError: true } : {}),
					},
				],
			});
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
			session.trace.push(event(createId, now, "tool_call", session, { call, concurrency: options.toolRegistry.get(call.name)?.concurrency ?? "sequential" }));
		}

		const batchResults = batch.length > 1
			? await Promise.all(batch.map((call) => options.toolRegistry.execute(session, call, options.hooks, signal)))
			: [await options.toolRegistry.execute(session, batch[0]!, options.hooks, signal)];

		for (const result of batchResults) {
			session.trace.push(event(createId, now, "tool_result", session, result));
			results.push(result);
		}
	}
	return results;
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

function event(
	createId: () => string,
	now: () => number,
	type: TraceEvent["type"],
	session: AgentSession,
	payload: unknown,
): TraceEvent {
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
	};
}
