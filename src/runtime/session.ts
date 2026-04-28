import type { ModelMessage } from "../models/types.js";
import type { AgentSpec, TaskSpec } from "../specs.js";
import type { TraceEvent } from "./events.js";

export interface AgentSession {
	id: string;
	agent: AgentSpec;
	task: TaskSpec;
	messages: ModelMessage[];
	trace: TraceEvent[];
	turnCount: number;
	toolCallCount: number;
	parentSessionId?: string;
	parentToolCallId?: string;
	subagentId?: string;
}

export interface AgentSessionOptions {
	id: string;
	agent: AgentSpec;
	task: TaskSpec;
	messages?: ModelMessage[];
	turnCount?: number;
	toolCallCount?: number;
	parentSessionId?: string;
	parentToolCallId?: string;
	subagentId?: string;
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
	return {
		id: options.id,
		agent: options.agent,
		task: options.task,
		messages: options.messages ?? initialMessages(options.agent, options.task),
		trace: [],
		turnCount: options.turnCount ?? 0,
		toolCallCount: options.toolCallCount ?? 0,
		...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
		...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
		...(options.subagentId ? { subagentId: options.subagentId } : {}),
	};
}

export function appendUserMessage(session: AgentSession, content: string): void {
	session.messages.push({ role: "user", content });
}

function initialMessages(agent: AgentSpec, task: TaskSpec): ModelMessage[] {
	return [
		{ role: "system", content: agent.prompts.system },
		{ role: "user", content: task.prompt },
	];
}
