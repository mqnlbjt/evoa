import type { ModelMessage } from "../models/types.js";
import { ruleBasedMemoryExtractor } from "./extractor.js";
import { effectiveScope, resolveReadableMemories } from "./resolution.js";
import type { ManualMemoryInput, MemoryCandidate, MemoryContext, MemoryContextItems, MemoryContextRequest, MemoryExtractor, MemoryForgetInput, MemoryForgetResult, MemoryItem, MemoryReadRequest, MemoryReadResult, MemorySearchRequest, MemoryStore, MemoryTurnInput, MemoryUpdateInput, StoredMemoryLayer } from "./types.js";
import { verifyMemoryCandidate } from "./verifier.js";

export class MemoryManager {
	constructor(private readonly store: MemoryStore, private readonly extractor: MemoryExtractor = ruleBasedMemoryExtractor) {}

	async loadContextItems(request: MemoryContextRequest): Promise<MemoryContextItems> {
		const readable = await this.readableItems(request);
		const stable = stableMemoryItems(readable).slice(0, request.maxStableItems ?? 20);
		const dynamic = dynamicMemoryItems(readable, request.prompt, stable).slice(0, request.maxDynamicItems ?? 10);
		return { stable, dynamic };
	}

	async loadContext(request: MemoryContextRequest): Promise<MemoryContext> {
		const items = await this.loadContextItems(request);
		const stable = contextMessage("stable", items.stable);
		const dynamic = contextMessage("dynamic", items.dynamic);
		return {
			...(stable ? { stable } : {}),
			...(dynamic ? { dynamic } : {}),
			stableItemIds: items.stable.map((item) => item.id),
			dynamicItemIds: items.dynamic.map((item) => item.id),
		};
	}

	async search(request: MemorySearchRequest): Promise<MemoryItem[]> {
		const terms = searchTerms(request.query);
		const limit = boundedLimit(request.limit, 10, 50);
		return (await this.readableItems(request))
			.filter((item) => request.scope === undefined || effectiveScope(item) === request.scope)
			.filter((item) => request.layer === undefined || item.layer === request.layer)
			.filter((item) => terms.length === 0 || terms.some((term) => item.content.toLowerCase().includes(term)))
			.sort((left, right) => searchRank(right, terms) - searchRank(left, terms) || right.updatedAt - left.updatedAt || memoryOrder(left, right))
			.slice(0, limit);
	}

	async read(request: MemoryReadRequest): Promise<MemoryReadResult> {
		const ids = new Set(request.ids);
		const found = new Map((await this.readableItems(request)).filter((item) => ids.has(item.id)).map((item) => [item.id, item]));
		return { items: request.ids.flatMap((id) => found.get(id) ?? []), missing: request.ids.filter((id) => !found.has(id)) };
	}

	async recordManualMemory(input: ManualMemoryInput): Promise<MemoryItem> {
		return this.recordCandidate({ layer: input.layer, scope: input.scope, content: input.content, sourceRefs: [input.sourceRef], metadata: manualMetadata(input) }, input.agentId, input.now(), input.createId, input.projectId);
	}

	async updateMemory(input: MemoryUpdateInput): Promise<MemoryItem | undefined> {
		const previous = (await this.read({ ...input, ids: [input.id] })).items[0];
		if (!previous) return undefined;
		const item = await this.recordCandidate({
			layer: previous.layer,
			scope: effectiveScope(previous),
			content: input.content,
			sourceRefs: [input.sourceRef],
			metadata: { ...previous.metadata, ...(input.topic ? { topic: input.topic } : {}), ...(input.key ? { key: input.key } : {}), ...(input.stable !== undefined ? { stable: input.stable } : {}), reason: input.reason, supersedes: [...(previous.metadata?.supersedes ?? []), previous.id] },
		}, input.agentId, input.now(), input.createId);
		return item;
	}

	async forgetMemories(input: MemoryForgetInput): Promise<MemoryForgetResult> {
		const readable = await this.read({ ...input, ids: input.ids });
		for (const item of readable.items) {
			await this.store.append({ ...item, id: input.createId(), status: "revoked", sourceRefs: [input.sourceRef], updatedAt: input.now(), metadata: { ...item.metadata, reason: input.reason, supersedes: [...(item.metadata?.supersedes ?? []), item.id] } });
		}
		return { revoked: readable.items.map((item) => item.id), missing: readable.missing };
	}

	async recordTurn(input: MemoryTurnInput): Promise<MemoryItem[]> {
		const candidates = await this.extractor.extract(input);
		const items: MemoryItem[] = [];
		for (const candidate of candidates) {
			items.push(await this.recordCandidate(candidate, input.agentId, input.now(), input.createId, input.projectId));
		}
		return items;
	}

	private async readableItems(request: MemoryContextRequest): Promise<MemoryItem[]> {
		return resolveReadableMemories(await this.store.list(request.agentId), request);
	}

	private async recordCandidate(candidate: MemoryCandidate, agentId: string, timestamp: number, createId: () => string, projectId?: string): Promise<MemoryItem> {
		const verification = verifyMemoryCandidate(candidate);
		const sessionId = candidate.scope === "session" && candidate.metadata?.sessionId === undefined ? candidate.sourceRefs[0]?.sessionId : undefined;
		const item: MemoryItem = {
			id: createId(),
			agentId,
			layer: candidate.layer,
			...(candidate.scope ? { scope: candidate.scope } : {}),
			content: candidate.content,
			sourceRefs: candidate.sourceRefs,
			confidence: verification.confidence,
			status: verification.status,
			createdAt: timestamp,
			updatedAt: timestamp,
			metadata: { ...safeMetadata(candidate.metadata), ...(candidate.scope === "project" && projectId ? { projectId } : {}), ...(sessionId ? { sessionId } : {}), ...(verification.issues.length > 0 ? { reason: verification.issues.join("; ") } : {}) },
		};
		await this.store.append(item);
		return item;
	}
}

function stableMemoryItems(items: MemoryItem[]): MemoryItem[] {
	return items
		.filter((item) => item.layer === "doctrine" || (item.layer === "knowledge" && item.metadata?.stable === true))
		.sort(memoryOrder)
		.slice(0, 20);
}

function dynamicMemoryItems(items: MemoryItem[], prompt: string, stableItems: MemoryItem[]): MemoryItem[] {
	const stableIds = new Set(stableItems.map((item) => item.id));
	const terms = searchTerms(prompt);
	return items
		.filter((item) => !stableIds.has(item.id))
		.filter((item) => terms.length === 0 || terms.some((term) => item.content.toLowerCase().includes(term)))
		.sort((left, right) => right.updatedAt - left.updatedAt || memoryOrder(left, right))
		.slice(0, 10);
}

function contextMessage(kind: "stable" | "dynamic", items: MemoryItem[]): ModelMessage | undefined {
	if (items.length === 0) return undefined;
	const content = [`Long-term memory ${kind} bootstrap context. Prefer memory tools for fresh lookup or edits; treat these verified, in-scope, non-stale memories as user-provided facts for this conversation:`, ...items.map((item) => `- [${effectiveScope(item)}/${item.layer}:${item.id}] ${item.content}`)].join("\n");
	return {
		role: "user",
		content,
		contentBlocks: [{ type: "text", text: content }],
	};
}

function memoryOrder(left: MemoryItem, right: MemoryItem): number {
	const layerDelta = layerRank(left.layer) - layerRank(right.layer);
	if (layerDelta !== 0) return layerDelta;
	const topicDelta = (left.metadata?.topic ?? "").localeCompare(right.metadata?.topic ?? "");
	if (topicDelta !== 0) return topicDelta;
	return left.content.localeCompare(right.content) || left.id.localeCompare(right.id);
}

function layerRank(layer: StoredMemoryLayer): number {
	if (layer === "doctrine") return 0;
	if (layer === "knowledge") return 1;
	return 2;
}

function searchTerms(prompt: string): string[] {
	return prompt.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2).slice(0, 8);
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 1) return fallback;
	return Math.min(Math.floor(value), max);
}

function searchRank(item: MemoryItem, terms: string[]): number {
	const content = item.content.toLowerCase();
	return terms.reduce((score, term) => score + (content.includes(term) ? 1 : 0), 0);
}

function manualMetadata(input: ManualMemoryInput): NonNullable<MemoryItem["metadata"]> {
	return {
		...(input.topic ? { topic: input.topic } : {}),
		...(input.key ? { key: input.key } : {}),
		...(input.stable !== undefined ? { stable: input.stable } : {}),
		...(input.reason ? { reason: input.reason } : {}),
		...(input.supersedes?.length ? { supersedes: input.supersedes } : {}),
		...(input.scope === "project" && input.projectId ? { projectId: input.projectId } : {}),
		...(input.scope === "session" && input.sessionId ? { sessionId: input.sessionId } : {}),
	};
}

function safeMetadata(metadata: MemoryCandidate["metadata"]): MemoryItem["metadata"] {
	return {
		...(metadata?.topic ? { topic: metadata.topic } : {}),
		...(metadata?.sessionId ? { sessionId: metadata.sessionId } : {}),
		...(metadata?.stable !== undefined ? { stable: metadata.stable } : {}),
		...(metadata?.reason ? { reason: metadata.reason } : {}),
		...(metadata?.key ? { key: metadata.key } : {}),
		...(metadata?.projectId ? { projectId: metadata.projectId } : {}),
		...(metadata?.expiresAt !== undefined ? { expiresAt: metadata.expiresAt } : {}),
		...(metadata?.staleAfterMs !== undefined ? { staleAfterMs: metadata.staleAfterMs } : {}),
		...(metadata?.priority !== undefined ? { priority: metadata.priority } : {}),
		...(metadata?.supersedes?.length ? { supersedes: metadata.supersedes } : {}),
	};
}
