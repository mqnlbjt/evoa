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

	if (agent.tools.permissionMode === "ask") {
		return { decision: "deny", reason: "ask permission is unsupported in non-interactive benchmark mode" };
	}

	if (agent.tools.deniedTools?.includes(tool.name)) {
		return { decision: "deny", reason: `tool ${tool.name} is denied by agent policy` };
	}

	if (!tool.name.startsWith("mcp__") && !agent.tools.allowedTools.includes(tool.name)) {
		return { decision: "deny", reason: `tool ${tool.name} is not in agent allowed tools` };
	}

	if (task.allowedTools && !task.allowedTools.includes(tool.name)) {
		return { decision: "deny", reason: `tool ${tool.name} is not allowed for task ${task.id}` };
	}

	if (tool.permission.defaultDecision === "ask") {
		return { decision: "deny", reason: "ask permission is unsupported in non-interactive benchmark mode" };
	}

	return { decision: tool.permission.defaultDecision, reason: `tool default decision is ${tool.permission.defaultDecision}` };
}

export function toolCallLimitDecision(agent: AgentSpec, currentToolCalls: number): ToolDecision | undefined {
	const maxToolCalls = agent.tools.maxToolCalls;
	if (maxToolCalls !== undefined && currentToolCalls >= maxToolCalls) {
		return { decision: "deny", reason: `max tool calls exceeded: ${maxToolCalls}` };
	}
	return undefined;
}

export function assertToolCallLimit(agent: AgentSpec, currentToolCalls: number): void {
	const decision = toolCallLimitDecision(agent, currentToolCalls);
	if (decision) throw new Error(decision.reason);
}
