import type { AgentSession } from "../runtime/session.js";
import type { EvolvingAgentTool } from "./types.js";
import { assertToolCallLimit, decideToolUse, type ToolDecision } from "./policy.js";

export interface ToolCall {
	id: string;
	name: string;
	input?: unknown;
}

export interface ToolResult {
	call: ToolCall;
	decision: ToolDecision;
	output?: unknown;
	errorMessage?: string;
}

export interface RuntimeHook {
	beforeToolCall?(session: AgentSession, call: ToolCall): Promise<void> | void;
	afterToolResult?(session: AgentSession, result: ToolResult): Promise<void> | void;
}

export class ToolRegistry {
	private readonly tools = new Map<string, EvolvingAgentTool>();

	constructor(tools: EvolvingAgentTool[] = []) {
		for (const tool of tools) {
			this.register(tool);
		}
	}

	register(tool: EvolvingAgentTool): void {
		this.tools.set(tool.name, tool);
	}

	get(name: string): EvolvingAgentTool | undefined {
		return this.tools.get(name);
	}

	list(): EvolvingAgentTool[] {
		return Array.from(this.tools.values());
	}

	async execute(session: AgentSession, call: ToolCall, hooks: RuntimeHook[] = [], signal?: AbortSignal): Promise<ToolResult> {
		const tool = this.get(call.name);
		if (!tool) {
			return {
				call,
				decision: { decision: "deny", reason: `tool ${call.name} is not registered` },
				errorMessage: `Unknown tool: ${call.name}`,
			};
		}

		assertToolCallLimit(session.agent, session.toolCallCount);
		const decision = decideToolUse(session.agent, session.task, tool);
		if (decision.decision !== "allow") {
			return { call, decision, errorMessage: decision.reason };
		}

		for (const hook of hooks) {
			await hook.beforeToolCall?.(session, call);
		}

		try {
			const output = await tool.execute(call.input, signal);
			session.toolCallCount += 1;
			const result: ToolResult = { call, decision, output };
			for (const hook of hooks) {
				await hook.afterToolResult?.(session, result);
			}
			return result;
		} catch (error) {
			const result: ToolResult = {
				call,
				decision,
				errorMessage: error instanceof Error ? error.message : String(error),
			};
			for (const hook of hooks) {
				await hook.afterToolResult?.(session, result);
			}
			return result;
		}
	}
}
