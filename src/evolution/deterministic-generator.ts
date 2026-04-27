import { validateAgentSpec } from "../agents/validation.js";
import type { AgentSpec } from "../specs.js";
import type { CandidateGenerator, CandidateKind, EvolutionCandidate } from "./types.js";

export type DeterministicMutation =
	| { id: string; kind: "system-prompt-append" | "system-prompt-replace"; text: string; description?: string; metadata?: Record<string, unknown> }
	| { id: string; kind: "allowed-tools-add" | "allowed-tools-remove"; tools: string[]; description?: string; metadata?: Record<string, unknown> }
	| { id: string; kind: "model-options-merge"; options: Record<string, unknown>; description?: string; metadata?: Record<string, unknown> }
	| { id: string; kind: "set-reasoning-level"; reasoningLevel: NonNullable<AgentSpec["model"]["reasoningLevel"]>; description?: string; metadata?: Record<string, unknown> };

export interface DeterministicCandidateGeneratorOptions {
	mutations: DeterministicMutation[];
	candidateIdPrefix?: string;
	candidateVersion?: string;
	source?: string;
	maxCandidates?: number;
}

interface AppliedMutation {
	kind: CandidateKind;
	patch: string;
}

export class DeterministicCandidateGenerator implements CandidateGenerator {
	private readonly options: DeterministicCandidateGeneratorOptions;

	constructor(options: DeterministicCandidateGeneratorOptions) {
		this.options = normalizeOptions(options);
	}

	async generate(parent: AgentSpec): Promise<EvolutionCandidate[]> {
		return this.options.mutations.slice(0, this.options.maxCandidates ?? this.options.mutations.length).map((mutation, index) => this.createCandidate(parent, mutation, index));
	}

	private createCandidate(parent: AgentSpec, mutation: DeterministicMutation, index: number): EvolutionCandidate {
		const candidateAgent = cloneAgent(parent);
		const candidateId = candidateIdFor(parent, mutation, this.options.candidateIdPrefix);
		const applied = applyMutation(candidateAgent, mutation);
		candidateAgent.id = candidateId;
		candidateAgent.kind = "candidate";
		candidateAgent.name = `${parent.name} candidate: ${mutation.id}`;
		candidateAgent.version = this.options.candidateVersion ?? parent.version;
		candidateAgent.metadata = candidateAgentMetadata(parent, mutation, index, this.options.source);
		const agent = validateAgentSpec(candidateAgent);
		return {
			id: candidateId,
			kind: applied.kind,
			parentAgentId: parent.id,
			agent,
			description: mutation.description ?? `Apply deterministic mutation ${mutation.id}`,
			patch: applied.patch,
			metadata: candidateMetadata(parent, mutation, index, this.options.source),
		};
	}
}

export function createDeterministicCandidateGenerator(options: DeterministicCandidateGeneratorOptions): DeterministicCandidateGenerator {
	return new DeterministicCandidateGenerator(options);
}

function applyMutation(agent: AgentSpec, mutation: DeterministicMutation): AppliedMutation {
	switch (mutation.kind) {
		case "system-prompt-append":
			agent.prompts.system = `${agent.prompts.system}\n\n${mutation.text}`;
			return { kind: "prompt", patch: `prompts.system += ${JSON.stringify(mutation.text)}` };
		case "system-prompt-replace":
			agent.prompts.system = mutation.text;
			return { kind: "prompt", patch: `prompts.system = ${JSON.stringify(mutation.text)}` };
		case "allowed-tools-add":
			setTools(agent, uniqueSorted([...agent.tools.allowedTools, ...mutation.tools]), withoutTools(agent.tools.deniedTools ?? [], mutation.tools));
			return { kind: "tool", patch: `tools.allowedTools += [${mutation.tools.join(", ")}]` };
		case "allowed-tools-remove":
			setTools(agent, withoutTools(agent.tools.allowedTools, mutation.tools), agent.tools.deniedTools ?? []);
			return { kind: "tool", patch: `tools.allowedTools -= [${mutation.tools.join(", ")}]` };
		case "model-options-merge":
			agent.model = { ...agent.model, options: { ...(agent.model.options ?? {}), ...mutation.options } };
			return { kind: "runtime", patch: `model.options merge keys: ${Object.keys(mutation.options).sort().join(", ")}` };
		case "set-reasoning-level":
			agent.model = { ...agent.model, reasoningLevel: mutation.reasoningLevel };
			return { kind: "runtime", patch: `model.reasoningLevel = ${mutation.reasoningLevel}` };
	}
}

function normalizeOptions(options: DeterministicCandidateGeneratorOptions): DeterministicCandidateGeneratorOptions {
	if (!Array.isArray(options.mutations) || options.mutations.length === 0) throw new Error("mutations must be a non-empty array");
	if (options.maxCandidates !== undefined && (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1)) {
		throw new Error("maxCandidates must be a positive integer");
	}
	return {
		mutations: options.mutations.map(normalizeMutation),
		...(options.candidateIdPrefix === undefined ? {} : { candidateIdPrefix: requireNonEmptyString(options.candidateIdPrefix, "candidateIdPrefix") }),
		...(options.candidateVersion === undefined ? {} : { candidateVersion: requireNonEmptyString(options.candidateVersion, "candidateVersion") }),
		...(options.source === undefined ? {} : { source: requireNonEmptyString(options.source, "source") }),
		...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }),
	};
}

function normalizeMutation(mutation: DeterministicMutation): DeterministicMutation {
	requireNonEmptyString(mutation.id, "mutation.id");
	const base = { id: mutation.id, kind: mutation.kind, ...(mutation.description === undefined ? {} : { description: requireNonEmptyString(mutation.description, "mutation.description") }), ...(mutation.metadata === undefined ? {} : { metadata: cloneRecord(mutation.metadata, "mutation.metadata") }) };
	if (mutation.kind === "system-prompt-append" || mutation.kind === "system-prompt-replace") return { ...base, kind: mutation.kind, text: requireNonEmptyString(mutation.text, "mutation.text") };
	if (mutation.kind === "allowed-tools-add" || mutation.kind === "allowed-tools-remove") return { ...base, kind: mutation.kind, tools: normalizeStringArray(mutation.tools, "mutation.tools") };
	if (mutation.kind === "model-options-merge") return { ...base, kind: mutation.kind, options: cloneRecord(mutation.options, "mutation.options") };
	if (mutation.kind === "set-reasoning-level") return { ...base, kind: mutation.kind, reasoningLevel: requireReasoningLevel(mutation.reasoningLevel) };
	throw new Error("mutation.kind must be a supported deterministic mutation kind");
}

function cloneAgent(agent: AgentSpec): AgentSpec {
	return {
		...agent,
		model: { ...agent.model, ...(agent.model.options === undefined ? {} : { options: { ...agent.model.options } }) },
		prompts: { ...agent.prompts },
		tools: { ...agent.tools, allowedTools: [...agent.tools.allowedTools], ...(agent.tools.deniedTools === undefined ? {} : { deniedTools: [...agent.tools.deniedTools] }) },
		runtime: { ...agent.runtime },
		...(agent.metadata === undefined ? {} : { metadata: { ...agent.metadata } }),
	};
}

function setTools(agent: AgentSpec, allowedTools: string[], deniedTools: string[]): void {
	agent.tools = {
		allowedTools: uniqueSorted(allowedTools),
		...(deniedTools.length > 0 ? { deniedTools: uniqueSorted(deniedTools) } : {}),
		...(agent.tools.permissionMode === undefined ? {} : { permissionMode: agent.tools.permissionMode }),
		...(agent.tools.maxToolCalls === undefined ? {} : { maxToolCalls: agent.tools.maxToolCalls }),
	};
}

function candidateIdFor(parent: AgentSpec, mutation: DeterministicMutation, prefix: string | undefined): string {
	return `${slug(prefix ?? parent.id)}-candidate-${slug(mutation.id)}`;
}

function candidateAgentMetadata(parent: AgentSpec, mutation: DeterministicMutation, index: number, source: string | undefined): Record<string, unknown> {
	return { ...(parent.metadata ?? {}), deterministicCandidate: candidateMetadata(parent, mutation, index, source) };
}

function candidateMetadata(parent: AgentSpec, mutation: DeterministicMutation, index: number, source: string | undefined): Record<string, unknown> {
	return {
		generator: "deterministic",
		parentAgentId: parent.id,
		mutationId: mutation.id,
		mutationKind: mutation.kind,
		candidateIndex: index,
		...(source === undefined ? {} : { source }),
		...(mutation.metadata === undefined ? {} : { mutationMetadata: mutation.metadata }),
	};
}

function withoutTools(current: string[], removed: string[]): string[] {
	const removedSet = new Set(removed);
	return uniqueSorted(current.filter((tool) => !removedSet.has(tool)));
}

function uniqueSorted(values: string[]): string[] {
	return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizeStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
	return uniqueSorted(value.map((item) => requireNonEmptyString(item, `${field}[]`)));
}

function cloneRecord(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
	return { ...value };
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function requireReasoningLevel(value: unknown): NonNullable<AgentSpec["model"]["reasoningLevel"]> {
	if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
	throw new Error("mutation.reasoningLevel must be off, minimal, low, medium, high, or xhigh");
}

function slug(value: string): string {
	const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	if (normalized.length === 0) throw new Error("candidate id parts must contain at least one alphanumeric character");
	return normalized;
}
