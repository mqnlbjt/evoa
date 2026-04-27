import type { AgentSpec, SubagentSpec } from "../specs.js";

export function validateAgentSpec(value: unknown): AgentSpec {
	if (!isRecord(value)) throw new Error("agent spec must be an object");
	const agent = value as Partial<AgentSpec>;

	requireString(agent.id, "id");
	requireString(agent.version, "version");
	requireString(agent.name, "name");
	if (agent.kind !== "baseline" && agent.kind !== "candidate") throw new Error("kind must be baseline or candidate");
	if (!isRecord(agent.model)) throw new Error("model is required");
	requireString(agent.model.provider, "model.provider");
	requireString(agent.model.model, "model.model");
	if (!isRecord(agent.prompts)) throw new Error("prompts is required");
	requireString(agent.prompts.system, "prompts.system");
	if (!isRecord(agent.tools)) throw new Error("tools is required");
	if (!Array.isArray(agent.tools.allowedTools)) throw new Error("tools.allowedTools must be an array");
	for (const tool of agent.tools.allowedTools) requireString(tool, "tools.allowedTools[]");
	if (agent.tools.deniedTools !== undefined) {
		if (!Array.isArray(agent.tools.deniedTools)) throw new Error("tools.deniedTools must be an array");
		for (const tool of agent.tools.deniedTools) requireString(tool, "tools.deniedTools[]");
	}
	if (agent.tools.permissionMode !== undefined && !["allow", "ask", "deny"].includes(agent.tools.permissionMode)) {
		throw new Error("tools.permissionMode must be allow, ask, or deny");
	}
	if (agent.tools.maxToolCalls !== undefined && (!Number.isInteger(agent.tools.maxToolCalls) || agent.tools.maxToolCalls < 0)) {
		throw new Error("tools.maxToolCalls must be a non-negative integer");
	}
	if (!isRecord(agent.runtime)) throw new Error("runtime is required");
	if (!Number.isInteger(agent.runtime.maxTurns) || agent.runtime.maxTurns < 1) {
		throw new Error("runtime.maxTurns must be a positive integer");
	}

	return agent as AgentSpec;
}

export function validateSubagentSpec(value: unknown): SubagentSpec {
	if (!isRecord(value)) throw new Error("subagent spec must be an object");
	const subagent = value as Partial<SubagentSpec>;
	requireString(subagent.id, "id");
	if (!["planner", "critic", "verifier", "tool-specialist"].includes(String(subagent.role))) {
		throw new Error("role must be planner, critic, verifier, or tool-specialist");
	}
	validateAgentSpec(subagent.agent);
	return subagent as SubagentSpec;
}

function requireString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
