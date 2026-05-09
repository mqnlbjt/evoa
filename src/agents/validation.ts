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
	const maxTurns = agent.runtime.maxTurns;
	if (maxTurns !== undefined && maxTurns !== null && (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1)) {
		throw new Error("runtime.maxTurns must be a positive integer when set");
	}
	const timeoutMs = agent.runtime.timeoutMs;
	if (timeoutMs !== undefined && timeoutMs !== null && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1)) {
		throw new Error("runtime.timeoutMs must be a positive integer");
	}
	const contextCompression = agent.runtime.contextCompression;
	if (contextCompression !== undefined && contextCompression !== null && !["off", "auto"].includes(String(contextCompression))) {
		throw new Error("runtime.contextCompression must be off or auto");
	}
	if (agent.runtime.contextBudget !== undefined) validateContextBudget(agent.runtime.contextBudget);
	if (agent.runtime.toolOutputBudget !== undefined) validateToolOutputBudget(agent.runtime.toolOutputBudget, "runtime.toolOutputBudget");
	const memoryPolicy = agent.runtime.memoryPolicy;
	if (memoryPolicy !== undefined && memoryPolicy !== null && !["none", "session", "long-term"].includes(String(memoryPolicy))) {
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

function validateContextBudget(value: unknown): void {
	if (!isRecord(value)) throw new Error("runtime.contextBudget must be an object");
	validatePositiveInteger(value.maxInputTokens, "runtime.contextBudget.maxInputTokens");
	validatePositiveInteger(value.reserveTokens, "runtime.contextBudget.reserveTokens");
	validatePositiveInteger(value.keepRecentTokens, "runtime.contextBudget.keepRecentTokens");
	validatePositiveInteger(value.summaryMaxTokens, "runtime.contextBudget.summaryMaxTokens");
	validatePositiveInteger(value.maxCompactionsPerRun, "runtime.contextBudget.maxCompactionsPerRun");
	validatePositiveInteger(value.maxConsecutiveCompactionFailures, "runtime.contextBudget.maxConsecutiveCompactionFailures");
	if (value.triggerRatio !== undefined && (typeof value.triggerRatio !== "number" || value.triggerRatio <= 0 || value.triggerRatio > 1)) {
		throw new Error("runtime.contextBudget.triggerRatio must be > 0 and <= 1");
	}
	if (value.failureMode !== undefined && !["continue", "error"].includes(String(value.failureMode))) {
		throw new Error("runtime.contextBudget.failureMode must be continue or error");
	}
	if (value.microCompact !== undefined) validateMicroCompact(value.microCompact);
}

function validateMicroCompact(value: unknown): void {
	if (!isRecord(value)) throw new Error("runtime.contextBudget.microCompact must be an object");
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		throw new Error("runtime.contextBudget.microCompact.enabled must be a boolean");
	}
	if (value.compactableToolNames !== undefined) {
		if (!Array.isArray(value.compactableToolNames)) throw new Error("runtime.contextBudget.microCompact.compactableToolNames must be an array");
		for (const name of value.compactableToolNames) {
			if (typeof name !== "string" || name.length === 0) throw new Error("runtime.contextBudget.microCompact.compactableToolNames must contain non-empty strings");
		}
	}
	if (value.keepRecentTools !== undefined) {
		const krt = value.keepRecentTools;
		if (krt !== null && (typeof krt !== "number" || !Number.isInteger(krt) || krt < 0)) {
			throw new Error("runtime.contextBudget.microCompact.keepRecentTools must be a non-negative integer");
		}
	}
}

function validateToolOutputBudget(value: unknown, path: string): void {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	validatePositiveInteger(value.maxBytes, `${path}.maxBytes`);
	validatePositiveInteger(value.headBytes, `${path}.headBytes`);
	validatePositiveInteger(value.tailBytes, `${path}.tailBytes`);
	if (value.strategy !== undefined && !["head-tail", "head-only"].includes(String(value.strategy))) {
		throw new Error(`${path}.strategy must be head-tail or head-only`);
	}
	if (value.includeMetadata !== undefined && typeof value.includeMetadata !== "boolean") {
		throw new Error(`${path}.includeMetadata must be a boolean`);
	}
	if (typeof value.headBytes === "number" && typeof value.tailBytes === "number" && typeof value.maxBytes === "number" && value.headBytes + value.tailBytes > value.maxBytes) {
		throw new Error(`${path}.headBytes + tailBytes must be <= maxBytes`);
	}
	if (value.perTool !== undefined) {
		if (!isRecord(value.perTool)) throw new Error(`${path}.perTool must be an object`);
		for (const [toolName, budget] of Object.entries(value.perTool)) {
			requireString(toolName, `${path}.perTool key`);
			validateToolOutputBudget(budget, `${path}.perTool.${toolName}`);
		}
	}
}

function validatePositiveInteger(value: unknown, field: string): void {
	if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1)) throw new Error(`${field} must be a positive integer`);
}

function requireString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
