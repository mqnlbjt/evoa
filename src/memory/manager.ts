import type { ModelMessage } from "../models/types.js";
import { estimateTextTokens } from "../runtime/budget.js";
import { ruleBasedMemoryExtractor } from "./extractor.js";
import { effectiveScope, resolveReadableMemories } from "./resolution.js";
import type { ManualMemoryInput, MemoryCandidate, MemoryContext, MemoryContextItems, MemoryContextRequest, MemoryExtractor, MemoryForgetInput, MemoryForgetResult, MemoryItem, MemoryReadRequest, MemoryReadResult, MemorySearchRequest, MemoryStore, MemoryTurnInput, MemoryUpdateInput, StoredMemoryLayer } from "./types.js";
import { verifyMemoryCandidate } from "./verifier.js";

export class MemoryManager {
	constructor(private readonly store: MemoryStore, private readonly extractor: MemoryExtractor = ruleBasedMemoryExtractor) {}

	async loadContextItems(request: MemoryContextRequest): Promise<MemoryContextItems> {
		const readable = await this.readableItems(request);
		const terms = searchTerms(request.prompt);
		const corpus = buildMemoryCorpus(readable);
		const budgets = contextBudgets(request);
		const stable = selectMemoryItems(stableMemoryItems(readable, terms, corpus), budgets.maxStableItems, budgets.maxStableTokens);
		const stableTokens = memoryItemsTokens(stable);
		const dynamicTokenBudget = Math.max(0, Math.min(budgets.maxDynamicTokens, budgets.maxContextTokens - stableTokens));
		const dynamic = selectMemoryItems(dynamicMemoryItems(readable, terms, stable, corpus), budgets.maxDynamicItems, dynamicTokenBudget);
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
		const items = (await this.readableItems(request))
			.filter((item) => request.scope === undefined || effectiveScope(item) === request.scope)
			.filter((item) => request.layer === undefined || item.layer === request.layer);
		const corpus = buildMemoryCorpus(items);
		return items
			.filter((item) => terms.length === 0 || searchRank(item, terms, corpus) > 0)
			.sort((left, right) => searchRank(right, terms, corpus) - searchRank(left, terms, corpus) || right.updatedAt - left.updatedAt || memoryOrder(left, right))
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

function stableMemoryItems(items: MemoryItem[], terms: string[], corpus: MemoryCorpus): MemoryItem[] {
	return items
		.filter(isStableMemoryItem)
		.filter((item) => item.layer === "doctrine" || terms.length === 0 || searchRank(item, terms, corpus) > 0)
		.sort((left, right) => stableRank(right, terms, corpus) - stableRank(left, terms, corpus) || memoryOrder(left, right));
}

function dynamicMemoryItems(items: MemoryItem[], terms: string[], stableItems: MemoryItem[], corpus: MemoryCorpus): MemoryItem[] {
	const stableIds = new Set(stableItems.map((item) => item.id));
	return items
		.filter((item) => !stableIds.has(item.id) && !isStableMemoryItem(item))
		.filter((item) => terms.length === 0 || searchRank(item, terms, corpus) > 0)
		.sort((left, right) => searchRank(right, terms, corpus) - searchRank(left, terms, corpus) || right.updatedAt - left.updatedAt || memoryOrder(left, right));
}

function isStableMemoryItem(item: MemoryItem): boolean {
	return item.layer === "doctrine" || (item.layer === "knowledge" && item.metadata?.stable === true);
}

interface MemoryContextBudgets {
	maxStableItems: number;
	maxDynamicItems: number;
	maxStableTokens: number;
	maxDynamicTokens: number;
	maxContextTokens: number;
}

function contextBudgets(request: MemoryContextRequest): MemoryContextBudgets {
	const maxContextTokens = boundedLimit(request.maxContextTokens, 2_000, 16_000);
	const maxStableTokens = Math.min(boundedLimit(request.maxStableTokens, 1_200, 16_000), maxContextTokens);
	return {
		maxStableItems: boundedLimit(request.maxStableItems, 20, 100),
		maxDynamicItems: boundedLimit(request.maxDynamicItems, 10, 100),
		maxStableTokens,
		maxDynamicTokens: Math.min(boundedLimit(request.maxDynamicTokens, 800, 16_000), maxContextTokens),
		maxContextTokens,
	};
}

function selectMemoryItems(items: MemoryItem[], maxItems: number, maxTokens: number): MemoryItem[] {
	const selected: MemoryItem[] = [];
	let usedTokens = contextHeaderTokens;
	for (const item of items) {
		if (selected.length >= maxItems) break;
		const itemTokens = memoryItemTokens(item);
		if (usedTokens + itemTokens > maxTokens) continue;
		selected.push(item);
		usedTokens += itemTokens;
	}
	return selected;
}

function memoryItemsTokens(items: MemoryItem[]): number {
	return items.reduce((total, item) => total + memoryItemTokens(item), items.length > 0 ? contextHeaderTokens : 0);
}

function memoryItemTokens(item: MemoryItem): number {
	return estimateTextTokens(memoryLine(item));
}

function stableRank(item: MemoryItem, terms: string[], corpus: MemoryCorpus): number {
	return searchRank(item, terms, corpus) + (item.layer === "doctrine" ? 1_000 : 0) + (item.metadata?.priority ?? 0);
}

const contextHeaderTokens = 32;

function contextMessage(kind: "stable" | "dynamic", items: MemoryItem[]): ModelMessage | undefined {
	if (items.length === 0) return undefined;
	const content = [`Long-term memory ${kind} bootstrap context. Prefer memory tools for fresh lookup or edits; treat these verified, in-scope, non-stale memories as user-provided facts for this conversation:`, ...items.map(memoryLine)].join("\n");
	return {
		role: "user",
		content,
		contentBlocks: [{ type: "text", text: content }],
	};
}

function memoryLine(item: MemoryItem): string {
	return `- [${effectiveScope(item)}/${item.layer}:${item.id}] ${item.content}`;
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
	return memoryTerms(prompt).slice(0, 8);
}

function memoryTerms(text: string): string[] {
	const terms: string[] = [];
	for (const term of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
		if (term.length < 2) continue;
		terms.push(term);
		if (/\p{Script=Han}/u.test(term)) {
			for (let index = 0; index < term.length - 1; index += 1) terms.push(term.slice(index, index + 2));
		}
	}
	return [...new Set(terms)];
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 1) return fallback;
	return Math.min(Math.floor(value), max);
}

interface MemoryCorpus {
	documents: Map<string, MemoryDocumentStats>;
	documentFrequency: Map<string, number>;
	documentCount: number;
	averageLength: number;
}

interface MemoryDocumentStats {
	termFrequency: Map<string, number>;
	length: number;
}

function buildMemoryCorpus(items: MemoryItem[]): MemoryCorpus {
	const documents = new Map<string, MemoryDocumentStats>();
	const documentFrequency = new Map<string, number>();
	let totalLength = 0;
	for (const item of items) {
		const terms = memoryTerms(item.content);
		const termFrequency = termCounts(terms);
		documents.set(item.id, { termFrequency, length: terms.length });
		totalLength += terms.length;
		for (const term of termFrequency.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
	}
	return {
		documents,
		documentFrequency,
		documentCount: items.length,
		averageLength: items.length === 0 ? 1 : Math.max(1, totalLength / items.length),
	};
}

function termCounts(terms: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
	return counts;
}

function searchRank(item: MemoryItem, terms: string[], corpus: MemoryCorpus): number {
	if (terms.length === 0) return 0;
	const document = corpus.documents.get(item.id);
	if (!document || document.length === 0 || corpus.documentCount === 0) return 0;
	const k1 = 1.2;
	const b = 0.75;
	return terms.reduce((score, term) => {
		const frequency = document.termFrequency.get(term) ?? 0;
		if (frequency === 0) return score;
		const documentsWithTerm = corpus.documentFrequency.get(term) ?? 0;
		const idf = Math.log(1 + (corpus.documentCount - documentsWithTerm + 0.5) / (documentsWithTerm + 0.5));
		const normalizedLength = k1 * (1 - b + b * (document.length / corpus.averageLength));
		return score + idf * ((frequency * (k1 + 1)) / (frequency + normalizedLength));
	}, 0);
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
