import type { MemoryContextRequest, MemoryItem, MemoryScope, StoredMemoryLayer } from "./types.js";

export function effectiveScope(item: MemoryItem): MemoryScope {
	if (item.scope) return item.scope;
	if (item.layer === "episode") return "session";
	if (item.metadata?.topic === "project") return "project";
	return "agent";
}

export function isMemoryInScope(item: MemoryItem, request: MemoryContextRequest): boolean {
	const scope = effectiveScope(item);
	if (scope === "user" || scope === "agent") return true;
	if (scope === "project") return item.metadata?.projectId === undefined || item.metadata.projectId === request.projectId;
	return item.metadata?.sessionId !== undefined && item.metadata.sessionId === request.sessionId;
}

export function isMemoryStale(item: MemoryItem, request: MemoryContextRequest): boolean {
	if (item.status !== "verified") return true;
	if (!isMemoryInScope(item, request)) return true;
	if (item.metadata?.expiresAt !== undefined && item.metadata.expiresAt <= request.now()) return true;
	if (item.metadata?.staleAfterMs !== undefined && item.updatedAt + item.metadata.staleAfterMs <= request.now()) return true;
	return false;
}

export function memoryConflictKey(item: MemoryItem): string {
	if (item.metadata?.key) return `${item.layer}:${item.metadata.key}`;
	const scope = effectiveScope(item);
	const key = `${item.metadata?.topic ?? "general"}:${normalizeKeyContent(item.content)}`;
	return `${scope}:${item.layer}:${key}`;
}

export function compareMemoryPriority(request: MemoryContextRequest, left: MemoryItem, right: MemoryItem): number {
	return numberDelta(right.metadata?.priority ?? 0, left.metadata?.priority ?? 0)
		|| numberDelta(scopeRank(right, request), scopeRank(left, request))
		|| numberDelta(layerRank(left.layer), layerRank(right.layer))
		|| numberDelta(stableRank(right), stableRank(left))
		|| numberDelta(right.confidence, left.confidence)
		|| numberDelta(right.updatedAt, left.updatedAt)
		|| numberDelta(right.createdAt, left.createdAt)
		|| left.id.localeCompare(right.id);
}

export function resolveReadableMemories(items: MemoryItem[], request: MemoryContextRequest): MemoryItem[] {
	const superseded = supersededIds(items, request);
	const winners = new Map<string, MemoryItem>();
	for (const item of items) {
		if (superseded.has(item.id)) continue;
		if (isMemoryStale(item, request)) continue;
		const key = memoryConflictKey(item);
		const winner = winners.get(key);
		if (!winner || compareMemoryPriority(request, item, winner) < 0) winners.set(key, item);
	}
	return [...winners.values()];
}

function supersededIds(items: MemoryItem[], request: MemoryContextRequest): Set<string> {
	const ids = new Set<string>();
	for (const item of items) {
		if (!isMemoryInScope(item, request)) continue;
		for (const id of item.metadata?.supersedes ?? []) ids.add(id);
	}
	return ids;
}

function scopeRank(item: MemoryItem, request: MemoryContextRequest): number {
	const scope = effectiveScope(item);
	if (scope === "session" && item.metadata?.sessionId === request.sessionId) return 4;
	if (scope === "project" && (item.metadata?.projectId === undefined || item.metadata.projectId === request.projectId)) return 3;
	if (scope === "agent") return 2;
	return 1;
}

function layerRank(layer: StoredMemoryLayer): number {
	if (layer === "doctrine") return 0;
	if (layer === "knowledge") return 1;
	return 2;
}

function stableRank(item: MemoryItem): number {
	return item.metadata?.stable === true ? 1 : 0;
}

function numberDelta(left: number, right: number): number {
	return left === right ? 0 : left - right;
}

function normalizeKeyContent(content: string): string {
	return content.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
}
