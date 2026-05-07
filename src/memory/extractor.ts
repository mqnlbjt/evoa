import type { ModelMessage } from "../models/types.js";
import type { MemoryCandidate, MemoryExtractor, MemoryScope, MemorySourceRef, StoredMemoryLayer } from "./types.js";

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
		candidates.push(candidate("episode", episodeContent(message.role, content), [sourceRef], input.sessionId, content));
		if (message.role !== "user") continue;
		if (isKnowledge(content)) {
			candidates.push(candidate("knowledge", knowledgeContent(content), [sourceRef], input.sessionId, content, isExplicitMemory(content)));
		}
		if (isDoctrine(content)) {
			candidates.push(candidate("doctrine", doctrineContent(content), [sourceRef], input.sessionId, content, true));
		}
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

function candidate(layer: StoredMemoryLayer, content: string, sourceRefs: MemorySourceRef[], sessionId: string, sourceContent: string, stable = false): MemoryCandidate {
	const topic = topicFor(sourceContent);
	return { layer, scope: scopeFor(layer, topic), content, sourceRefs, metadata: { sessionId, topic, ...(stable ? { stable } : {}), ...metadataKey(sourceContent, topic) } };
}

function messageSource(sessionId: string, index: number, content: string): MemorySourceRef {
	return { kind: "message", id: `${sessionId}:${index}`, sessionId, messageIndex: index, excerptHash: hashText(content) };
}

function episodeContent(role: ModelMessage["role"], content: string): string {
	return `${role}: ${limit(content, 320)}`;
}

function knowledgeContent(content: string): string {
	const normalized = content.replace(/^请使用最高级别的记忆记住\s*/u, "").replace(/^记住[:：\s]*/u, "").trim();
	const identity = /我是\s*([^，。,.\s]+)\s+我是\s*([^，。,.\s]+)(爸爸|父亲)/u.exec(normalized);
	if (identity) return `用户是${identity[1]}。${identity[2]}是用户的孩子。`;
	const parent = /我是\s*([^，。,.\s]+)(爸爸|父亲)/u.exec(normalized);
	if (parent) return `${parent[1]}是用户的孩子。`;
	return limit(normalized, 240);
}

function doctrineContent(content: string): string {
	return limit(content.replace(/^以后[:：\s]*/u, ""), 180);
}

function isKnowledge(content: string): boolean {
	return /记住|我是|我的|偏好|项目|默认|不要|以后|工具|能力/u.test(content);
}

function isDoctrine(content: string): boolean {
	return /以后|默认|永远|不要|必须|规则|原则/u.test(content);
}

function isExplicitMemory(content: string): boolean {
	return /记住|以后|默认|不要|必须/u.test(content);
}

function scopeFor(layer: StoredMemoryLayer, topic: string): MemoryScope {
	if (layer === "episode") return "session";
	if (topic === "user") return "user";
	if (topic === "project") return "project";
	return "agent";
}

function metadataKey(content: string, topic: string): { key?: string } {
	if (/默认中文|中文回答|默认英文|英文回答/u.test(content)) return { key: "user.preference.language" };
	if (/我的名字是|我是/u.test(content) && topic === "user") return { key: "user.identity.name" };
	if (/项目.*(TypeScript|JavaScript|Python|Go|Rust)|采用.*(TypeScript|JavaScript|Python|Go|Rust)/iu.test(content)) return { key: "project.tech.language" };
	if (/不要/u.test(content)) return { key: "agent.doctrine.prohibition" };
	if (/必须/u.test(content)) return { key: "agent.doctrine.requirement" };
	return {};
}

function topicFor(content: string): string {
	if (/我是|我的|偏好/u.test(content)) return "user";
	if (/项目|代码|仓库/u.test(content)) return "project";
	if (/工具|能力|bash|web_fetch/u.test(content)) return "tools";
	if (/默认|不要|必须|规则|原则/u.test(content)) return "doctrine";
	return "general";
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
