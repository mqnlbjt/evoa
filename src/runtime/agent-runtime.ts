import type { AgentRuntimeExecutor, TaskExecutionOutput } from "../benchmark/types.js";
import type { ModelClient } from "../models/types.js";
import type { AgentSpec, TaskSpec } from "../specs.js";
import type { RuntimeHook, ToolRegistry } from "../tools/registry.js";
import { runAgentLoop } from "./loop.js";
import { createAgentSession } from "./session.js";

export interface AgentRuntimeOptions {
	modelClient: ModelClient;
	toolRegistry?: ToolRegistry;
	hooks?: RuntimeHook[];
	createId?: () => string;
	now?: () => number;
}

export class AgentRuntime implements AgentRuntimeExecutor {
	constructor(private readonly options: AgentRuntimeOptions) {}

	async runTask(agent: AgentSpec, task: TaskSpec, signal?: AbortSignal): Promise<TaskExecutionOutput> {
		const createId = this.options.createId ?? (() => crypto.randomUUID());
		const session = createAgentSession({ id: createId(), agent, task });
		const loopOptions = {
			modelClient: this.options.modelClient,
			createId,
			...(this.options.toolRegistry ? { toolRegistry: this.options.toolRegistry } : {}),
			...(this.options.hooks ? { hooks: this.options.hooks } : {}),
			...(this.options.now ? { now: this.options.now } : {}),
		};
		return runAgentLoop(session, loopOptions, signal);
	}
}

export class NotImplementedAgentRuntime implements AgentRuntimeExecutor {
	async runTask(agent: AgentSpec, task: TaskSpec): Promise<TaskExecutionOutput> {
		throw new Error(`AgentRuntime is not implemented for agent ${agent.id} and task ${task.id}`);
	}
}
