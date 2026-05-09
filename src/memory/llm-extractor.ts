import type { ModelClient, ModelMessage, ModelRequest } from "../models/types.js";
import type { AgentSpec, TaskSpec } from "../specs.js";
import { hashText, ruleBasedMemoryExtractor } from "./extractor.js";
import type { MemoryCandidate, MemoryExtractor, MemoryScope, MemorySourceRef, MemoryTurnInput, StoredMemoryLayer } from "./types.js";

interface SemanticMemoryOutput {
	memories?: unknown;
}

interface SemanticMemoryCandidate {
	layer?: unknown;
	content?: unknown;
	topic?: unknown;
	scope?: unknown;
	stable?: unknown;
	key?: unknown;
	suitability?: unknown;
	safety?: unknown;
	reason?: unknown;
	sourceMessageIndexes?: unknown;
}

export class LlmMemoryExtractor implements MemoryExtractor {
	constructor(
		private readonly modelClient: ModelClient,
		private readonly baseAgent: AgentSpec,
		private readonly fallback: MemoryExtractor = ruleBasedMemoryExtractor,
		private readonly extractInterval: number = 10,
	) {}

	private turnCount = 0;

	async extract(input: MemoryTurnInput): Promise<MemoryCandidate[]> {
		const episodeCandidates = (await this.fallback.extract(input)).filter((candidate) => candidate.layer === "episode");
		this.turnCount += 1;
		if (!input.force && this.turnCount > 1 && this.turnCount % this.extractInterval !== 0) return episodeCandidates;
		try {
			const response = await this.modelClient.complete(memoryRequest(input, this.baseAgent));
			const semanticCandidates = parseSemanticCandidates(response.text ?? "", input);
			return [...episodeCandidates, ...semanticCandidates];
		} catch {
			return episodeCandidates;
		}
	}
}

function memoryRequest(input: MemoryTurnInput, baseAgent: AgentSpec): ModelRequest {
	const prompt = [
		"Extract durable long-term memories from the new conversation messages.",
		"Return strict JSON only: {\"memories\":[...]}. Do not include markdown.",
		"Save stable user identity, preferences, important person facts, project constraints, project structure (key modules, file locations, architecture), feedback, and external references.",
		"Do not save temporary task state, assistant acknowledgements, git history, or unverified third-party sensitive health/cognitive/disability/diagnostic labels.",
		"If a requested memory is unsafe, stigmatizing, or sensitive, include it only with suitability=\"quarantine\" and safety=\"unsafe_or_sensitive\".",
		"Each memory must include: layer knowledge|doctrine, content, scope user|project|agent|session, topic, stable, key when useful, suitability long_term|quarantine, safety safe|unsafe_or_sensitive, reason, sourceMessageIndexes.",
		"New messages:",
		...input.messages.slice(input.startMessageIndex).map((message, offset) => `${input.startMessageIndex + offset}: ${message.role}: ${message.content}`),
	].join("\n");
	return {
		agent: extractorAgent(input.agentId, baseAgent),
		task: extractorTask(prompt),
		messages: [{ role: "user", content: prompt }],
		turn: 0,
		purpose: "memory-extraction",
	};
}

function extractorAgent(agentId: string, baseAgent: AgentSpec): AgentSpec {
	return {
		...baseAgent,
		id: `${agentId}-memory-extractor`,
		name: "Memory Extractor",
		prompts: { system: "Extract structured long-term memory candidates as strict JSON." },
		tools: { allowedTools: [], permissionMode: "deny", maxToolCalls: 0 },
		runtime: { maxTurns: 1, memoryPolicy: "none" },
	};
}

function extractorTask(prompt: string): TaskSpec {
	return {
		id: "memory-extraction",
		type: "general",
		title: "Extract memory",
		prompt,
		scoring: { method: "custom" },
	};
}

function parseSemanticCandidates(text: string, input: MemoryTurnInput): MemoryCandidate[] {
	const parsed = JSON.parse(text) as SemanticMemoryOutput;
	if (!Array.isArray(parsed.memories)) return [];
	return parsed.memories.flatMap((value) => candidateFromSemantic(value as SemanticMemoryCandidate, input));
}

function candidateFromSemantic(value: SemanticMemoryCandidate, input: MemoryTurnInput): MemoryCandidate[] {
	const layer = validLayer(value.layer);
	const content = stringValue(value.content, 240);
	const scope = validScope(value.scope);
	const sourceRefs = sourceRefsFor(value.sourceMessageIndexes, input);
	if (!layer || !content || sourceRefs.length === 0) return [];
	const topic = stringValue(value.topic, 64);
	const key = stringValue(value.key, 120);
	const suitability = validSuitability(value.suitability);
	const safety = validSafety(value.safety);
	const reason = stringValue(value.reason, 240);
	return [{
		layer,
		...(scope ? { scope } : {}),
		content,
		sourceRefs,
		metadata: {
			sessionId: input.sessionId,
			...(topic ? { topic } : {}),
			...(typeof value.stable === "boolean" ? { stable: value.stable } : {}),
			...(key ? { key } : {}),
			...(suitability ? { suitability } : {}),
			...(safety ? { safety } : {}),
			...(reason ? { reason } : {}),
		},
	}];
}

function sourceRefsFor(value: unknown, input: MemoryTurnInput): MemorySourceRef[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((index) => {
		if (!Number.isInteger(index)) return [];
		const message = input.messages[index];
		if (!message || index < input.startMessageIndex) return [];
		return [{ kind: "message", id: `${input.sessionId}:${index}`, sessionId: input.sessionId, messageIndex: index, excerptHash: hashText(message.content) }];
	});
}

function validLayer(value: unknown): StoredMemoryLayer | undefined {
	return value === "knowledge" || value === "doctrine" ? value : undefined;
}

function validScope(value: unknown): MemoryScope | undefined {
	return value === "user" || value === "project" || value === "agent" || value === "session" ? value : undefined;
}

function validSuitability(value: unknown): "long_term" | "quarantine" | undefined {
	return value === "long_term" || value === "quarantine" ? value : undefined;
}

function validSafety(value: unknown): "safe" | "unsafe_or_sensitive" | undefined {
	return value === "safe" || value === "unsafe_or_sensitive" ? value : undefined;
}

function stringValue(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > 0 ? trimmed.slice(0, max).trimEnd() : undefined;
}
