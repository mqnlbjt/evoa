import type { TaskExecutionOutput } from "../benchmark/types.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../models/types.js";
import type { ToolCall, ToolRegistry, RuntimeHook } from "../tools/registry.js";
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
		const request: ModelRequest = {
			agent: session.agent,
			task: session.task,
			messages: session.messages,
			turn: session.turnCount,
		};

		session.trace.push(event(createId, now, "model_request", session, { messages: request.messages, turn: request.turn }));
		lastResponse = await options.modelClient.complete(request, signal);
		session.trace.push(event(createId, now, "model_response", session, lastResponse));

		if (lastResponse.text) {
			session.messages.push({ role: "assistant", content: lastResponse.text });
		}

		if (!lastResponse.toolCalls || lastResponse.toolCalls.length === 0) {
			return { answer: lastResponse.text ?? "", trace: session.trace };
		}

		if (!options.toolRegistry) {
			throw new Error("model requested tools but no tool registry was provided");
		}

		for (const modelCall of lastResponse.toolCalls) {
			const call: ToolCall = { id: modelCall.id, name: modelCall.name, input: modelCall.input };
			session.trace.push(event(createId, now, "tool_call", session, call));
			const result = await options.toolRegistry.execute(session, call, options.hooks, signal);
			session.trace.push(event(createId, now, "tool_result", session, result));
			session.messages.push({
				role: "tool",
				content: result.errorMessage ?? JSON.stringify(result.output ?? null),
			});
		}
	}

	return { answer: lastResponse?.text ?? "", trace: session.trace };
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
	};
}
