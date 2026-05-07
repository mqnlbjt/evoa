import { describe, expect, it } from "vitest";
import { diffMemory } from "../src/memory/diff.js";
import type { MemoryItem } from "../src/memory/types.js";

describe("memory diff", () => {
	it("detects added removed and changed memories", () => {
		const left = [item("1", "knowledge", "a", 0.9)];
		const right = [item("1", "knowledge", "b", 0.8), item("2", "episode", "c", 1)];

		const diff = diffMemory(left, right);

		expect(diff.added).toContain("knowledge:user:b");
		expect(diff.removed).toContain("knowledge:user:a");
	});

	it("flags missing source refs confidence drops and doctrine changes", () => {
		const left = [item("1", "doctrine", "默认中文", 1)];
		const right = [{ ...item("1", "doctrine", "默认英文", 0.5), sourceRefs: [] }];

		const diff = diffMemory(left, right);

		expect(diff.missingSourceRefs).toContain("doctrine:user:默认英文");
		expect(diff.doctrineChanges).toContain("doctrine:user:默认英文");
	});
});

function item(id: string, layer: MemoryItem["layer"], content: string, confidence: number): MemoryItem {
	return {
		id,
		agentId: "agent",
		layer,
		content,
		sourceRefs: [{ kind: "message", id: "s:1", excerptHash: "hash" }],
		confidence,
		status: "verified",
		createdAt: 1,
		updatedAt: 1,
		metadata: { topic: "user" },
	};
}
