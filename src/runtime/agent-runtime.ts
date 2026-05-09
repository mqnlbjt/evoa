import type { AgentRuntimeExecutor, TaskExecutionOutput } from "../benchmark/types.js";
import type { ModelClient, ModelMessage } from "../models/types.js";
import type { AgentSpec, SubagentSpec, TaskSpec } from "../specs.js";
import { ToolRegistry, type RuntimeHook } from "../tools/registry.js";
import { createSubagentTool } from "../tools/subagent.js";
import type { SubagentTranscriptStore } from "../sessions/subagent-transcript-store.js";
import type { TraceEventObserver } from "./events.js";
import { runAgentLoop } from "./loop.js";
import { createAgentSession, type AgentSession } from "./session.js";
import { minDefined, withTimeout } from "./timeout.js";

export interface AgentRuntimeOptions {
	modelClient: ModelClient;
	toolRegistry?: ToolRegistry;
	hooks?: RuntimeHook[];
	createId?: () => string;
	now?: () => number;
	subagents?: SubagentSpec[];
	subagentTranscriptStore?: SubagentTranscriptStore;
	createToolRegistryForAgent?: (agent: AgentSpec) => ToolRegistry;
	memoryContextProvider?: (session: AgentSession) => Promise<{ stable?: ModelMessage; dynamic?: ModelMessage; stableItemIds: string[]; dynamicItemIds: string[] }>;
	eventObserver?: TraceEventObserver;
}

export class AgentRuntime implements AgentRuntimeExecutor {
	constructor(private readonly options: AgentRuntimeOptions) {}

	async close(): Promise<void> {
		await this.options.toolRegistry?.close();
	}

	async runTask(agent: AgentSpec, task: TaskSpec, signal?: AbortSignal): Promise<TaskExecutionOutput> {
		const createId = this.options.createId ?? (() => crypto.randomUUID());
		const session = createAgentSession({ id: createId(), agent, task });
		return this.runSession(session, signal);
	}

	async runSession(session: AgentSession, signal?: AbortSignal): Promise<TaskExecutionOutput> {
		const createId = this.options.createId ?? (() => crypto.randomUUID());
		const toolRegistry = this.createToolRegistry(session.agent);
		if (toolRegistry && this.options.subagents?.length) {
			toolRegistry.register(createSubagentTool({
				subagents: this.options.subagents,
				modelClient: this.options.modelClient,
				createToolRegistryForAgent: (subagentAgent) => {
					const registry = this.options.createToolRegistryForAgent?.(subagentAgent) ?? this.createToolRegistry(subagentAgent);
					if (!registry) throw new Error(`no tool registry available for subagent ${subagentAgent.id}`);
					return registry;
				},
				...(this.options.hooks ? { hooks: this.options.hooks } : {}),
				createId,
				...(this.options.now ? { now: this.options.now } : {}),
				...(this.options.subagentTranscriptStore ? { transcriptStore: this.options.subagentTranscriptStore } : {}),
			}));
			if (!session.agent.tools.allowedTools.includes("subagent")) {
				session.agent.tools = { ...session.agent.tools, allowedTools: [...session.agent.tools.allowedTools, "subagent"] };
			}
		}
		const memoryContext = session.agent.runtime.memoryPolicy === "long-term" ? await this.options.memoryContextProvider?.(session) : undefined;
		const loopOptions = {
			modelClient: this.options.modelClient,
			createId,
			...(toolRegistry ? { toolRegistry } : {}),
			...(this.options.hooks ? { hooks: this.options.hooks } : {}),
			...(this.options.now ? { now: this.options.now } : {}),
			...(memoryContext?.stable ? { stableMemoryContext: memoryContext.stable } : {}),
			...(memoryContext?.dynamic ? { dynamicMemoryContext: memoryContext.dynamic } : {}),
			...(memoryContext ? { memoryContextItemIds: { stable: memoryContext.stableItemIds, dynamic: memoryContext.dynamicItemIds } } : {}),
			...(this.options.eventObserver ? { eventObserver: this.options.eventObserver } : {}),
		};
		return withTimeout((timeoutSignal) => runAgentLoop(session, loopOptions, timeoutSignal), minDefined(session.task.timeoutMs, session.agent.runtime.timeoutMs), signal);
	}

	private createToolRegistry(agent: AgentSpec): ToolRegistry | undefined {
		if (this.options.createToolRegistryForAgent) return this.options.createToolRegistryForAgent(agent);
		if (!this.options.toolRegistry) return undefined;
		return this.options.toolRegistry.clone();
	}
}

export class NotImplementedAgentRuntime implements AgentRuntimeExecutor {
	async runTask(agent: AgentSpec, task: TaskSpec): Promise<TaskExecutionOutput> {
		throw new Error(`AgentRuntime is not implemented for agent ${agent.id} and task ${task.id}`);
	}
}
