import type { ModelMessage } from "../models/types.js";
import type { MemoryCandidate, MemoryExtractor, MemorySourceRef } from "./types.js";

export function extractMemoryCandidates(input: { agentId: string; sessionId: string; messages: ModelMessage[]; startMessageIndex: number }): MemoryCandidate[] {
	const candidates: MemoryCandidate[] = [];
	const messages = input.messages.slice(input.startMessageIndex);
	for (let offset = 0; offset < messages.length; offset += 1) {
		const index = input.startMessageIndex + offset;
		const message = messages[offset]!;
		if (message.role === "tool") continue;
		const content = normalizeContent(message.content);
		if (!content) continue;
		const sourceRef = messageSource(input.sessionId, index, content);
		candidates.push(episodeCandidate(message.role, content, sourceRef, input.sessionId));
	}
	return dedupeCandidates(candidates);
}

export const ruleBasedMemoryExtractor: MemoryExtractor = {
	async extract(input) {
		return extractMemoryCandidates(input);
	},
};

export function hashText(value: string): string {
	let hash = 2166136261;
	for (const char of value) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function episodeCandidate(role: ModelMessage["role"], content: string, sourceRef: MemorySourceRef, sessionId: string): MemoryCandidate {
	return {
		layer: "episode",
		scope: "session",
		content: `${role}: ${limit(content, 320)}`,
		sourceRefs: [sourceRef],
		metadata: { sessionId, topic: "general" },
	};
}

function messageSource(sessionId: string, index: number, content: string): MemorySourceRef {
	return { kind: "message", id: `${sessionId}:${index}`, sessionId, messageIndex: index, excerptHash: hashText(content) };
}

function normalizeContent(content: string): string {
	return content.replace(/\s+/g, " ").trim();
}

function limit(content: string, max: number): string {
	return content.length > max ? content.slice(0, max).trimEnd() : content;
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = `${candidate.layer}:${candidate.content}:${candidate.sourceRefs.map((ref) => ref.id).join(",")}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
