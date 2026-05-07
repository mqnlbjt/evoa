import type { AgentSpec, ModelRoutingSpec, ModelSpec, SubagentSpec } from "../specs.js";
import type { ModelPurpose } from "../models/types.js";

export function validateAgentSpec(value: unknown): AgentSpec {
	if (!isRecord(value)) throw new Error("agent spec must be an object");
	const agent = value as Partial<AgentSpec>;

	requireString(agent.id, "id");
	requireString(agent.version, "version");
	requireString(agent.name, "name");
	if (agent.kind !== "baseline" && agent.kind !== "candidate") throw new Error("kind must be baseline or candidate");
	if (!isRecord(agent.model)) throw new Error("model is required");
	validateModelSpec(agent.model, "model");
	if (agent.modelRouting !== undefined) validateModelRoutingSpec(agent.modelRouting);
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
	if (agent.runtime.timeoutMs !== undefined && (!Number.isInteger(agent.runtime.timeoutMs) || agent.runtime.timeoutMs < 1)) {
		throw new Error("runtime.timeoutMs must be a positive integer");
	}
	if (agent.runtime.contextCompression !== undefined && !["off", "auto"].includes(agent.runtime.contextCompression)) {
		throw new Error("runtime.contextCompression must be off or auto");
	}
	if (agent.runtime.memoryPolicy !== undefined && !["none", "session", "long-term"].includes(agent.runtime.memoryPolicy)) {
		throw new Error("runtime.memoryPolicy must be none, session, or long-term");
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

function validateModelSpec(value: unknown, path: string): asserts value is ModelSpec {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	requireString(value.provider, `${path}.provider`);
	requireString(value.model, `${path}.model`);
	if (value.reasoningLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(value.reasoningLevel))) {
		throw new Error(`${path}.reasoningLevel must be off, minimal, low, medium, high, or xhigh`);
	}
	if (value.options !== undefined && !isRecord(value.options)) throw new Error(`${path}.options must be an object`);
}

function validateModelRoutingSpec(value: unknown): asserts value is ModelRoutingSpec {
	if (!isRecord(value)) throw new Error("modelRouting must be an object");
	validateModelAliases(value.aliases);
	validateModelRoutes(value.routes);
	if (value.defaultAlias !== undefined) requireString(value.defaultAlias, "modelRouting.defaultAlias");
	if (value.purposeRules !== undefined) validatePurposeRules(value.purposeRules);
}

function validateModelAliases(value: unknown): void {
	if (value === undefined) return;
	if (!isRecord(value)) throw new Error("modelRouting.aliases must be an object");
	for (const [alias, model] of Object.entries(value)) {
		requireString(alias, "modelRouting.aliases key");
		validateModelSpec(model, `modelRouting.aliases.${alias}`);
	}
}

function validateModelRoutes(value: unknown): void {
	if (value === undefined) return;
	if (!isRecord(value)) throw new Error("modelRouting.routes must be an object");
	for (const [purpose, alias] of Object.entries(value)) {
		if (!isModelPurpose(purpose)) throw new Error(`modelRouting.routes.${purpose} is not a supported model purpose`);
		requireString(alias, `modelRouting.routes.${purpose}`);
	}
}

function validatePurposeRules(value: unknown): void {
	if (!isRecord(value)) throw new Error("modelRouting.purposeRules must be an object");
	if (value.codingTasks !== undefined && typeof value.codingTasks !== "boolean") throw new Error("modelRouting.purposeRules.codingTasks must be a boolean");
	if (value.toolHeavy !== undefined && typeof value.toolHeavy !== "boolean") throw new Error("modelRouting.purposeRules.toolHeavy must be a boolean");
}

function isModelPurpose(value: string): value is ModelPurpose {
	return ["main", "memory-extraction", "summary", "compaction", "verification", "evolution", "coding", "tool-heavy"].includes(value);
}

function requireString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
