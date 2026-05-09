import { readFile } from "node:fs/promises";
import { createDeterministicCandidateGenerator, type DeterministicCandidateGenerator, type DeterministicCandidateGeneratorOptions, type DeterministicMutation } from "./deterministic-generator.js";

export interface DeterministicCandidateGeneratorSpec extends DeterministicCandidateGeneratorOptions {}

export async function loadDeterministicCandidateGeneratorFromFile(filePath: string): Promise<DeterministicCandidateGenerator> {
	return loadDeterministicCandidateGenerator({ ...JSON.parse(await readFile(filePath, "utf-8")), source: filePath });
}

export function loadDeterministicCandidateGenerator(value: unknown): DeterministicCandidateGenerator {
	return createDeterministicCandidateGenerator(validateDeterministicCandidateGeneratorSpec(value));
}

export function validateDeterministicCandidateGeneratorSpec(value: unknown): DeterministicCandidateGeneratorSpec {
	if (!isRecord(value)) throw new Error("deterministic candidate generator spec must be an object");
	const mutations = value.mutations;
	if (!Array.isArray(mutations) || mutations.length === 0) throw new Error("mutations must be a non-empty array");
	return {
		mutations: mutations.map(validateMutation),
		...(value.candidateIdPrefix === undefined ? {} : { candidateIdPrefix: requireString(value.candidateIdPrefix, "candidateIdPrefix") }),
		...(value.candidateVersion === undefined ? {} : { candidateVersion: requireString(value.candidateVersion, "candidateVersion") }),
		...(value.source === undefined ? {} : { source: requireString(value.source, "source") }),
		...(value.maxCandidates === undefined ? {} : { maxCandidates: requirePositiveInteger(value.maxCandidates, "maxCandidates") }),
	};
}

function validateMutation(value: unknown): DeterministicMutation {
	if (!isRecord(value)) throw new Error("mutation must be an object");
	const id = requireString(value.id, "mutation.id");
	const optional = {
		...(value.description === undefined ? {} : { description: requireString(value.description, "mutation.description") }),
		...(value.metadata === undefined ? {} : { metadata: requireRecord(value.metadata, "mutation.metadata") }),
	};
	const kind = value.kind;
	if (kind === "system-prompt-append" || kind === "system-prompt-replace") return { id, kind, text: requireString(value.text, "mutation.text"), ...optional };
	if (kind === "allowed-tools-add" || kind === "allowed-tools-remove" || kind === "denied-tools-add" || kind === "denied-tools-remove") return { id, kind, tools: requireStringArray(value.tools, "mutation.tools"), ...optional };
	if (kind === "model-options-merge") return { id, kind, options: requireRecord(value.options, "mutation.options"), ...optional };
	if (kind === "set-reasoning-level") return { id, kind, reasoningLevel: requireReasoningLevel(value.reasoningLevel), ...optional };
	if (kind === "set-max-turns") return { id, kind, maxTurns: requirePositiveInteger(value.maxTurns, "mutation.maxTurns"), ...optional };
	if (kind === "set-timeout-ms") return { id, kind, timeoutMs: requirePositiveInteger(value.timeoutMs, "mutation.timeoutMs"), ...optional };
	if (kind === "set-max-tool-calls") return { id, kind, maxToolCalls: requirePositiveInteger(value.maxToolCalls, "mutation.maxToolCalls"), ...optional };
	throw new Error("mutation.kind must be a supported deterministic mutation kind");
}

function requireStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
	return value.map((item) => requireString(item, `${field}[]`));
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
	if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer`);
	return Number(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	return { ...value };
}

function requireReasoningLevel(value: unknown): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
	if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
	throw new Error("mutation.reasoningLevel must be off, minimal, low, medium, high, or xhigh");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
