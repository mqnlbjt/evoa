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
}

export interface AgentSessionOptions {
	id: string;
	agent: AgentSpec;
	task: TaskSpec;
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
	return {
		id: options.id,
		agent: options.agent,
		task: options.task,
		messages: [
			{ role: "system", content: options.agent.prompts.system },
			{ role: "user", content: options.task.prompt },
		],
		trace: [],
		turnCount: 0,
		toolCallCount: 0,
	};
}
