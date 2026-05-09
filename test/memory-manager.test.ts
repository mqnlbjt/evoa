import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonMemoryStore } from "../src/memory/json-memory-store.js";
import { MemoryManager } from "../src/memory/manager.js";
import type { MemoryCandidate, MemoryExtractor } from "../src/memory/types.js";

describe("MemoryManager", () => {
	it("records verified memories with source refs", async () => {
		const extractor = fakeExtractor(
			{ layer: "episode", scope: "session", content: "user: 记住我是 wyq，以后默认中文回答", sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }], metadata: { sessionId: "s1", topic: "general" } },
			{ layer: "knowledge", scope: "user", content: "用户是wyq", sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }], metadata: { sessionId: "s1", topic: "user" } },
			{ layer: "doctrine", scope: "user", content: "默认中文回答", sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }], metadata: { sessionId: "s1", topic: "doctrine" } },
		);
		const manager = new MemoryManager(new JsonMemoryStore(await root()), extractor);
		const items = await manager.recordTurn({
			agentId: "agent",
			sessionId: "s1",
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "记住我是 wyq，以后默认中文回答" }],
			trace: [],
			startMessageIndex: 1,
			now: () => 1,
			createId: ids(),
		});

		expect(items.some((item) => item.layer === "episode" && item.scope === "session")).toBe(true);
		expect(items.some((item) => item.layer === "knowledge" && item.scope === "user" && item.status === "verified")).toBe(true);
		expect(items.some((item) => item.layer === "doctrine" && item.scope === "user" && item.status === "verified")).toBe(true);
		expect(items.every((item) => item.sourceRefs.length > 0)).toBe(true);
	});

	it("normalizes parent identity memories into answerable facts", async () => {
		const extractor = fakeExtractor(
			{ layer: "knowledge", scope: "user", content: "用户是wyq。黄金山是用户的孩子。", sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }], metadata: { sessionId: "s1", topic: "user", stable: true } },
		);
		const manager = new MemoryManager(new JsonMemoryStore(await root()), extractor);
		await manager.recordTurn({
			agentId: "agent",
			sessionId: "s1",
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "请使用最高级别的记忆记住 我是wyq 我是黄金山爸爸" }],
			trace: [],
			startMessageIndex: 1,
			now: () => 1,
			createId: ids(),
		});

		const context = await manager.loadContext({ agentId: "agent", sessionId: "s1", prompt: "黄金山是谁", now: () => 2 });
		expect(context.stable?.content).toContain("[user/knowledge:");
		expect(context.stable?.content).toContain("用户是wyq");
		expect(context.stable?.content).toContain("黄金山是用户的孩子");
	});

	it("builds stable context with deterministic ordering", async () => {
		const extractor = fakeExtractor(
			{ layer: "doctrine", scope: "user", content: "默认中文回答", sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }], metadata: { sessionId: "s1", topic: "doctrine" } },
			{ layer: "knowledge", scope: "user", content: "用户的名字是 wyq", sourceRefs: [{ kind: "message", id: "s1:2", sessionId: "s1", messageIndex: 2, excerptHash: "hash2" }], metadata: { sessionId: "s1", topic: "user" } },
		);
		const manager = new MemoryManager(new JsonMemoryStore(await root()), extractor);
		await manager.recordTurn({
			agentId: "agent",
			sessionId: "s1",
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "以后默认中文回答" }, { role: "user", content: "记住我的名字是 wyq" }],
			trace: [],
			startMessageIndex: 1,
			now: () => 1,
			createId: ids(),
		});

		const first = await manager.loadContext({ agentId: "agent", sessionId: "s1", prompt: "我是谁", now: () => 2 });
		const second = await manager.loadContext({ agentId: "agent", sessionId: "s1", prompt: "我是谁", now: () => 2 });
		expect(first.stable?.content).toBe(second.stable?.content);
		expect(first.stable?.content).toContain("Long-term memory stable bootstrap context");
	});

	it("keeps dynamic context separate from stable context", async () => {
		const manager = new MemoryManager(new JsonMemoryStore(await root()));
		await manager.recordTurn({
			agentId: "agent",
			sessionId: "s1",
			messages: [{ role: "system", content: "sys" }, { role: "assistant", content: "项目采用 TypeScript" }],
			trace: [],
			startMessageIndex: 1,
			now: () => 1,
			createId: ids(),
		});

		const context = await manager.loadContext({ agentId: "agent", sessionId: "s1", prompt: "TypeScript 项目", now: () => 2 });
		expect(context.dynamic?.content).toContain("TypeScript");
	});

	it("records semantic person hobbies as answerable memories", async () => {
		const manager = new MemoryManager(new JsonMemoryStore(await root()), fakeExtractor({
			layer: "knowledge",
			scope: "user",
			content: "黄金山喜欢玩原神。",
			sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }],
			metadata: { sessionId: "s1", topic: "person", stable: true, key: "person.黄金山.hobby", suitability: "long_term", safety: "safe" },
		}));
		const items = await manager.recordTurn({
			agentId: "agent",
			sessionId: "s1",
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "黄金山爱玩原神" }],
			trace: [],
			startMessageIndex: 1,
			now: () => 1,
			createId: ids(),
		});

		expect(items).toEqual(expect.arrayContaining([
			expect.objectContaining({ layer: "knowledge", status: "verified", content: "黄金山喜欢玩原神。", metadata: expect.objectContaining({ key: "person.黄金山.hobby" }) }),
		]));
		const context = await manager.loadContext({ agentId: "agent", sessionId: "s1", prompt: "黄金山爱好是什么", now: () => 2 });
		expect(context.stable?.content).toContain("黄金山喜欢玩原神");
	});

	it("quarantines semantic sensitive labels", async () => {
		const manager = new MemoryManager(new JsonMemoryStore(await root()), fakeExtractor({
			layer: "knowledge",
			scope: "user",
			content: "黄金山是一个有智力缺陷的人。",
			sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }],
			metadata: { sessionId: "s1", topic: "person", stable: true, key: "person.黄金山.health", suitability: "quarantine", safety: "unsafe_or_sensitive", reason: "sensitive third-party label" },
		}));
		const items = await manager.recordTurn({
			agentId: "agent",
			sessionId: "s1",
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "请记住 黄金山是一个有智力缺陷的人" }],
			trace: [],
			startMessageIndex: 1,
			now: () => 1,
			createId: ids(),
		});

		expect(items).toEqual(expect.arrayContaining([
			expect.objectContaining({ layer: "knowledge", status: "quarantined", metadata: expect.objectContaining({ reason: expect.stringContaining("sensitive") }) }),
		]));
		const context = await manager.loadContext({ agentId: "agent", sessionId: "s1", prompt: "黄金山智力怎么样", now: () => 2 });
		expect(context.stable?.content ?? "").not.toContain("智力缺陷");
		expect(context.dynamic?.content ?? "").not.toContain("智力缺陷");
	});

	it("does not inject stale or shadowed memories", async () => {
		const store = new JsonMemoryStore(await root());
		const manager = new MemoryManager(store);
		await store.append(memory("old", "默认中文回答", { key: "user.preference.language", stable: true }, { updatedAt: 1 }));
		await store.append(memory("new", "默认英文回答", { key: "user.preference.language", stable: true }, { updatedAt: 2 }));
		await store.append(memory("stale", "过期事实", { stable: true, expiresAt: 3 }, { updatedAt: 2 }));

		const context = await manager.loadContext({ agentId: "agent", sessionId: "s1", prompt: "默认", now: () => 3 });
		expect(context.stable?.content).toContain("默认英文回答");
		expect(context.stable?.content).not.toContain("默认中文回答");
		expect(context.stable?.content).not.toContain("过期事实");
		expect(context.stableItemIds).toEqual(["new"]);
	});

	it("exposes structured context items", async () => {
		const store = new JsonMemoryStore(await root());
		const manager = new MemoryManager(store);
		await store.append(memory("stable", "默认中文回答", { stable: true }));
		await store.append(memory("dynamic", "项目使用 TypeScript", { stable: false }));

		const items = await manager.loadContextItems({ agentId: "agent", sessionId: "s1", prompt: "默认 TypeScript", now: () => 2 });
		expect(items.stable.map((item) => item.id)).toEqual(["stable"]);
		expect(items.dynamic.map((item) => item.id)).toEqual(["dynamic"]);
	});

	it("limits stable memory by token budget without leaking skipped stable items", async () => {
		const store = new JsonMemoryStore(await root());
		const manager = new MemoryManager(store);
		await store.append(memory("important", "a", { stable: true, priority: 10 }));
		await store.append(memory("verbose", "b".repeat(120), { stable: true, priority: 1 }));

		const items = await manager.loadContextItems({ agentId: "agent", sessionId: "s1", prompt: "", now: () => 2, maxStableTokens: 42, maxDynamicTokens: 1_000, maxContextTokens: 1_000 });
		expect(items.stable.map((item) => item.id)).toEqual(["important"]);
		expect(items.dynamic.map((item) => item.id)).not.toContain("verbose");
	});

	it("only injects prompt-relevant stable knowledge", async () => {
		const store = new JsonMemoryStore(await root());
		const manager = new MemoryManager(store);
		await store.append(memory("project", "项目使用 Python", { stable: true }));
		await store.append(memory("hobby", "黄金山喜欢玩原神", { stable: true }));

		const items = await manager.loadContextItems({ agentId: "agent", sessionId: "s1", prompt: "原神", now: () => 2 });
		expect(items.stable.map((item) => item.id)).toEqual(["hobby"]);
	});

	it("keeps doctrine available even when it is not prompt-relevant", async () => {
		const store = new JsonMemoryStore(await root());
		const manager = new MemoryManager(store);
		await store.append(memory("doctrine", "默认中文回答", {}, { layer: "doctrine" }));
		await store.append(memory("stable", "项目使用 Python", { stable: true }));

		const items = await manager.loadContextItems({ agentId: "agent", sessionId: "s1", prompt: "原神", now: () => 2 });
		expect(items.stable.map((item) => item.id)).toEqual(["doctrine"]);
	});

	it("caps dynamic memory by the remaining total memory budget", async () => {
		const store = new JsonMemoryStore(await root());
		const manager = new MemoryManager(store);
		await store.append(memory("stable", "anchor", { stable: true, priority: 10 }));
		await store.append(memory("dynamic", "TypeScript dynamic fact", { stable: false }));

		const items = await manager.loadContextItems({ agentId: "agent", sessionId: "s1", prompt: "anchor TypeScript", now: () => 2, maxStableTokens: 42, maxDynamicTokens: 1_000, maxContextTokens: 42 });
		expect(items.stable.map((item) => item.id)).toEqual(["stable"]);
		expect(items.dynamic).toEqual([]);
	});

	it("ranks rare memory terms above common terms with BM25", async () => {
		const store = new JsonMemoryStore(await root());
		const manager = new MemoryManager(store);
		await store.append(memory("common", "项目 使用 通用 配置", { stable: false }, { updatedAt: 3 }));
		await store.append(memory("rare", "项目 使用 zeta-token", { stable: false }, { updatedAt: 1 }));

		const result = await manager.search({ agentId: "agent", sessionId: "s1", prompt: "", query: "项目 zeta-token", now: () => 2 });
		expect(result.map((item) => item.id).slice(0, 2)).toEqual(["rare", "common"]);
	});

	it("ranks short precise BM25 matches above long incidental matches", async () => {
		const store = new JsonMemoryStore(await root());
		const manager = new MemoryManager(store);
		await store.append(memory("long", `原神 ${"噪声 ".repeat(80)}`, { stable: false }, { updatedAt: 3 }));
		await store.append(memory("short", "原神", { stable: false }, { updatedAt: 1 }));

		const result = await manager.search({ agentId: "agent", sessionId: "s1", prompt: "", query: "原神", now: () => 2 });
		expect(result.map((item) => item.id).slice(0, 2)).toEqual(["short", "long"]);
	});

	it("uses Chinese bigrams for BM25 matching", async () => {
		const store = new JsonMemoryStore(await root());
		const manager = new MemoryManager(store);
		await store.append(memory("hobby", "黄金山喜欢玩原神", { stable: true }));
		await store.append(memory("project", "项目使用 Python", { stable: true }));

		const items = await manager.loadContextItems({ agentId: "agent", sessionId: "s1", prompt: "黄金山爱好", now: () => 2 });
		expect(items.stable.map((item) => item.id)).toEqual(["hobby"]);
	});

	it("keeps deterministic ordering when BM25 has no query terms", async () => {
		const store = new JsonMemoryStore(await root());
		const manager = new MemoryManager(store);
		await store.append(memory("b", "beta", { stable: false }, { updatedAt: 2 }));
		await store.append(memory("a", "alpha", { stable: false }, { updatedAt: 1 }));

		const first = await manager.search({ agentId: "agent", sessionId: "s1", prompt: "", query: "", now: () => 2 });
		const second = await manager.search({ agentId: "agent", sessionId: "s1", prompt: "", query: "", now: () => 2 });
		expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
		expect(first.map((item) => item.id)).toEqual(["b", "a"]);
	});

	it("searches, reads, updates, and forgets manual memories append-only", async () => {
		const manager = new MemoryManager(new JsonMemoryStore(await root()));
		const createId = ids();
		const sourceRef = { kind: "trace_event" as const, id: "s1:call", sessionId: "s1", traceEventId: "call", excerptHash: "hash" };
		const first = await manager.recordManualMemory({ agentId: "agent", sessionId: "s1", prompt: "", now: () => 1, createId, content: "默认中文回答", layer: "knowledge", scope: "user", stable: true, key: "user.preference.language", sourceRef });

		expect((await manager.search({ agentId: "agent", sessionId: "s1", prompt: "", now: () => 2, query: "中文" })).map((item) => item.id)).toEqual([first.id]);
		expect((await manager.read({ agentId: "agent", sessionId: "s1", prompt: "", now: () => 2, ids: [first.id, "missing"] })).missing).toEqual(["missing"]);

		const second = await manager.updateMemory({ agentId: "agent", sessionId: "s1", prompt: "", now: () => 3, createId, id: first.id, content: "默认英文回答", reason: "用户纠正", sourceRef });
		expect(second?.metadata?.supersedes).toContain(first.id);
		expect((await manager.search({ agentId: "agent", sessionId: "s1", prompt: "", now: () => 4, query: "默认" })).map((item) => item.id)).toEqual([second?.id]);

		const result = await manager.forgetMemories({ agentId: "agent", sessionId: "s1", prompt: "", now: () => 5, createId, ids: [second!.id], reason: "用户要求删除", sourceRef });
		expect(result.revoked).toEqual([second!.id]);
		expect(await manager.search({ agentId: "agent", sessionId: "s1", prompt: "", now: () => 6, query: "默认" })).toEqual([]);
	});
});

async function root(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "evolving-agent-memory-manager-"));
}

function fakeExtractor(...candidates: MemoryCandidate[]): MemoryExtractor {
	return { async extract() { return candidates; } };
}

function ids(): () => string {
	let index = 0;
	return () => `id-${++index}`;
}

function memory(id: string, content: string, metadata: NonNullable<import("../src/memory/types.js").MemoryItem["metadata"]>, overrides: Partial<import("../src/memory/types.js").MemoryItem> = {}): import("../src/memory/types.js").MemoryItem {
	return {
		id,
		agentId: "agent",
		layer: "knowledge",
		scope: "user",
		content,
		sourceRefs: [{ kind: "message", id: "s:1", sessionId: "s", messageIndex: 1, excerptHash: "hash" }],
		confidence: 1,
		status: "verified",
		createdAt: 1,
		updatedAt: 1,
		metadata: { topic: "user", ...metadata },
		...overrides,
	};
}
