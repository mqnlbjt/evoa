import type { MemoryDiffSummary, MemoryItem } from "./types.js";

export function diffMemory(left: MemoryItem[], right: MemoryItem[]): MemoryDiffSummary {
	const leftByKey = keyMap(left);
	const rightByKey = keyMap(right);
	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];
	const missingSourceRefs: string[] = [];
	const confidenceDrops: string[] = [];
	const doctrineChanges: string[] = [];

	for (const [key, rightItem] of rightByKey) {
		const leftItem = leftByKey.get(key);
		if (!leftItem) {
			added.push(key);
			if (rightItem.sourceRefs.length === 0) missingSourceRefs.push(key);
			if (rightItem.layer === "doctrine") doctrineChanges.push(key);
			continue;
		}
		if (leftItem.content !== rightItem.content || leftItem.status !== rightItem.status) changed.push(key);
		if (rightItem.sourceRefs.length === 0) missingSourceRefs.push(key);
		if (rightItem.confidence < leftItem.confidence) confidenceDrops.push(key);
		if (rightItem.layer === "doctrine" && (leftItem.content !== rightItem.content || leftItem.status !== rightItem.status)) doctrineChanges.push(key);
	}
	for (const key of leftByKey.keys()) {
		if (!rightByKey.has(key)) removed.push(key);
	}
	return { added, removed, changed, missingSourceRefs, confidenceDrops, doctrineChanges };
}

function keyMap(items: MemoryItem[]): Map<string, MemoryItem> {
	return new Map(items.map((item) => [memoryKey(item), item]));
}

function memoryKey(item: MemoryItem): string {
	return `${item.layer}:${item.metadata?.topic ?? "general"}:${item.content}`;
}
