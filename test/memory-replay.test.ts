import { describe, expect, it } from "vitest";
import { replayMemory } from "../src/memory/replay.js";
import type { MemoryCandidate, MemoryExtractor } from "../src/memory/types.js";

describe("memory replay", () => {
	it("replays memories from messages", async () => {
		const result = await replayMemory({
			agentId: "agent",
			sessionId: "s1",
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "记住我是 wyq" }],
			extractor: fakeExtractor(
				{ layer: "episode", scope: "session", content: "user: 记住我是 wyq", sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }], metadata: { sessionId: "s1", topic: "general" } },
				{ layer: "knowledge", scope: "user", content: "用户是wyq", sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }], metadata: { sessionId: "s1", topic: "user" } },
			),
			now: () => 1,
		});

		expect(result.items.some((item) => item.layer === "knowledge" && item.scope === "user")).toBe(true);
		expect(result.items.every((item) => item.sourceRefs.length > 0)).toBe(true);
	});

	it("rebuilds without removed sources", async () => {
		const before = await replayMemory({ agentId: "agent", sessionId: "s1", messages: [{ role: "user", content: "记住我是 wyq" }], extractor: fakeExtractor({ layer: "knowledge", scope: "user", content: "用户是wyq", sourceRefs: [{ kind: "message", id: "s1:0", sessionId: "s1", messageIndex: 0, excerptHash: "hash" }], metadata: { sessionId: "s1" } }) });
		const after = await replayMemory({ agentId: "agent", sessionId: "s1", messages: [] });

		expect(before.items.length).toBeGreaterThan(after.items.length);
		expect(after.items).toEqual([]);
	});

	it("replays semantic extractor memories", async () => {
		const result = await replayMemory({
			agentId: "agent",
			sessionId: "s1",
			messages: [{ role: "user", content: "黄金山爱玩原神" }],
			extractor: fakeExtractor({
				layer: "knowledge",
				scope: "user",
				content: "黄金山喜欢玩原神。",
				sourceRefs: [{ kind: "message", id: "s1:0", sessionId: "s1", messageIndex: 0, excerptHash: "hash" }],
				metadata: { sessionId: "s1", stable: true, key: "person.黄金山.hobby", suitability: "long_term", safety: "safe" },
			}),
		});

		expect(result.items).toEqual(expect.arrayContaining([
			expect.objectContaining({ content: "黄金山喜欢玩原神。", status: "verified" }),
		]));
	});

	it("replays semantic quarantines", async () => {
		const result = await replayMemory({
			agentId: "agent",
			sessionId: "s1",
			messages: [{ role: "user", content: "请记住 黄金山是一个有智力缺陷的人" }],
			extractor: fakeExtractor({
				layer: "knowledge",
				scope: "user",
				content: "黄金山是一个有智力缺陷的人。",
				sourceRefs: [{ kind: "message", id: "s1:0", sessionId: "s1", messageIndex: 0, excerptHash: "hash" }],
				metadata: { sessionId: "s1", stable: true, suitability: "quarantine", safety: "unsafe_or_sensitive", reason: "sensitive third-party label" },
			}),
		});

		expect(result.items).toEqual([]);
		expect(result.quarantined).toEqual(expect.arrayContaining([
			expect.objectContaining({ content: "黄金山是一个有智力缺陷的人。", status: "quarantined" }),
		]));
	});

	it("replays project-scoped memories with project ids", async () => {
		const result = await replayMemory({
			agentId: "agent",
			sessionId: "s1",
			projectId: "p1",
			messages: [{ role: "user", content: "记住项目采用 TypeScript" }],
			extractor: fakeExtractor(
				{ layer: "knowledge", scope: "project", content: "项目采用 TypeScript", sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }], metadata: { sessionId: "s1", topic: "project" } },
			),
			now: () => 1,
		});

		expect(result.items).toEqual(expect.arrayContaining([
			expect.objectContaining({ scope: "project", metadata: expect.objectContaining({ projectId: "p1" }) }),
		]));
	});
});

function fakeExtractor(...candidates: MemoryCandidate[]): MemoryExtractor {
	return { async extract() { return candidates; } };
}
