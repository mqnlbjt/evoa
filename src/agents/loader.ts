import { readFile } from "node:fs/promises";
import type { AgentSpec, SubagentSpec } from "../specs.js";
import { validateAgentSpec, validateSubagentSpec } from "./validation.js";

export interface AgentDefinitionBundle {
	agents: AgentSpec[];
	subagents: SubagentSpec[];
}

export async function loadAgentSpecFromFile(filePath: string): Promise<AgentSpec> {
	return validateAgentSpec(JSON.parse(await readFile(filePath, "utf-8")));
}

export async function loadAgentDefinitionsFromFile(filePath: string): Promise<AgentDefinitionBundle> {
	const parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
	return loadAgentDefinitions(parsed);
}

export function loadAgentDefinitions(value: unknown): AgentDefinitionBundle {
	if (Array.isArray(value)) {
		return { agents: mergeAgents(value.map(validateAgentSpec)), subagents: [] };
	}

	if (!isRecord(value)) {
		throw new Error("agent definitions must be an object or array");
	}

	const agents = Array.isArray(value.agents) ? value.agents.map(validateAgentSpec) : [];
	const subagents = Array.isArray(value.subagents) ? value.subagents.map(validateSubagentSpec) : [];
	if (agents.length === 0 && subagents.length === 0) {
		return { agents: [validateAgentSpec(value)], subagents: [] };
	}

	return { agents: mergeAgents(agents), subagents };
}

function mergeAgents(agents: AgentSpec[]): AgentSpec[] {
	const merged = new Map<string, AgentSpec>();
	for (const agent of agents) {
		merged.set(agent.id, agent);
	}
	return Array.from(merged.values());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
