import type { AgentSpec, TaskSpec } from "../specs.js";
import type { EvolvingAgentTool, ToolPermissionDecision } from "./types.js";

export interface ToolDecision {
	decision: ToolPermissionDecision;
	reason: string;
}

export function decideToolUse(agent: AgentSpec, task: TaskSpec, tool: EvolvingAgentTool): ToolDecision {
	if (agent.tools.permissionMode === "deny") {
		return { decision: "deny", reason: "agent permission mode denies all tools" };
	}

	if (agent.tools.deniedTools?.includes(tool.name)) {
		return { decision: "deny", reason: `tool ${tool.name} is denied by agent policy` };
	}

	if (!agent.tools.allowedTools.includes(tool.name)) {
		return { decision: "deny", reason: `tool ${tool.name} is not in agent allowed tools` };
	}

	if (task.allowedTools && !task.allowedTools.includes(tool.name)) {
		return { decision: "deny", reason: `tool ${tool.name} is not allowed for task ${task.id}` };
	}

	return { decision: tool.permission.defaultDecision, reason: `tool default decision is ${tool.permission.defaultDecision}` };
}

export function assertToolCallLimit(agent: AgentSpec, currentToolCalls: number): void {
	const maxToolCalls = agent.tools.maxToolCalls;
	if (maxToolCalls !== undefined && currentToolCalls >= maxToolCalls) {
		throw new Error(`max tool calls exceeded: ${maxToolCalls}`);
	}
}
