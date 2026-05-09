import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { SqliteMemoryStore } from "../src/memory/sqlite-memory-store.js";
import type { MemoryItem } from "../src/memory/types.js";

describe("SqliteMemoryStore", () => {
	let stores: SqliteMemoryStore[] = [];

	afterEach(() => {
		for (const store of stores) {
			try { store.close(); } catch { /* ignore */ }
		}
		stores = [];
	});

	async function createStore(): Promise<SqliteMemoryStore> {
		const dir = await mkdtemp(path.join(tmpdir(), "evolving-agent-sqlite-store-"));
		const store = new SqliteMemoryStore(dir);
		stores.push(store);
		return store;
	}

	it("appends and reads verified memories", async () => {
		const store = await createStore();
		await store.append(item("1", "agent", "knowledge", "记住我是 wyq"));

		expect(await store.list("agent", "knowledge")).toHaveLength(1);
		expect(await store.latestVerified("agent")).toMatchObject([{ content: "记住我是 wyq" }]);
	});

	it("keeps quarantined memories out of latestVerified", async () => {
		const store = await createStore();
		await store.append({ ...item("1", "agent", "knowledge", "maybe"), status: "quarantined" });

		// Quarantine writes to quarantine.jsonl in JsonMemoryStore,
		// but in SqliteMemoryStore all statuses go to the same table
		// and latestVerified filters by status='verified'
		expect(await store.latestVerified("agent")).toEqual([]);
	});

	it("returns empty lists for missing agents", async () => {
		const store = await createStore();

		expect(await store.list("missing")).toEqual([]);
	});

	it("records revoked memories by source", async () => {
		const store = await createStore();
		const memory = item("1", "agent", "knowledge", "remember me");
		await store.append(memory);
		await store.revokeBySource("agent", memory.sourceRefs[0]!);

		expect((await store.list("agent", "knowledge")).map((entry) => entry.status)).toEqual(["verified", "revoked"]);
	});

	it("preserves memory scope and extended metadata", async () => {
		const store = await createStore();
		await store.append({
			...item("1", "agent", "knowledge", "scoped"),
			scope: "project",
			metadata: { topic: "project", stable: true, projectId: "p1", key: "project.tech.language", expiresAt: 10, staleAfterMs: 5, priority: 2, supersedes: ["old"] },
		});

		const result = await store.latestVerified("agent");
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			scope: "project",
			metadata: { projectId: "p1", key: "project.tech.language", expiresAt: 10, staleAfterMs: 5, priority: 2, supersedes: ["old"] },
		});
	});

	it("supports FTS5 search", async () => {
		const store = await createStore();
		await store.append(item("1", "agent", "knowledge", "用户喜欢用 TypeScript 编程"));
		await store.append(item("2", "agent", "knowledge", "项目使用 vitest 进行测试"));
		await store.append(item("3", "agent", "knowledge", "数据库使用 SQLite"));

		const results = await store.search("TypeScript 编程", { agentId: "agent" });
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0]!.content).toContain("TypeScript");
	});

	it("FTS5 search filters by scope and layer", async () => {
		const store = await createStore();
		await store.append({ ...item("1", "agent", "knowledge", "remember TypeScript"), scope: "user" });
		await store.append({ ...item("2", "agent", "doctrine", "remember TypeScript rules"), scope: "project" });

		const results = await store.search("TypeScript", { agentId: "agent", layer: "knowledge" });
		expect(results).toHaveLength(1);
		expect(results[0]!.layer).toBe("knowledge");

		const doctrineOnly = await store.search("TypeScript", { agentId: "agent", layer: "doctrine" });
		expect(doctrineOnly).toHaveLength(1);
		expect(doctrineOnly[0]!.layer).toBe("doctrine");
	});

	it("search returns empty for no matches", async () => {
		const store = await createStore();
		await store.append(item("1", "agent", "knowledge", "hello world"));

		const results = await store.search("xyznonexistent", { agentId: "agent" });
		expect(results).toEqual([]);
	});

	it("handles upsert (INSERT OR REPLACE) on duplicate id", async () => {
		const store = await createStore();
		await store.append(item("1", "agent", "knowledge", "original"));
		await store.append(item("1", "agent", "knowledge", "updated"));

		const items = await store.list("agent", "knowledge");
		expect(items).toHaveLength(1);
		expect(items[0]!.content).toBe("updated");
	});

	it("multiple agents are isolated", async () => {
		const store = await createStore();
		await store.append(item("1", "agent-a", "knowledge", "alpha"));
		await store.append(item("2", "agent-b", "knowledge", "beta"));

		expect(await store.list("agent-a")).toHaveLength(1);
		expect(await store.list("agent-b")).toHaveLength(1);
		expect((await store.list("agent-a"))[0]!.content).toBe("alpha");
	});
});

function item(id: string, agentId: string, layer: MemoryItem["layer"], content: string): MemoryItem {
	return {
		id,
		agentId,
		layer,
		content,
		sourceRefs: [{ kind: "message", id: "s:1", sessionId: "s", messageIndex: 1, excerptHash: "hash" }],
		confidence: 1,
		status: "verified",
		createdAt: Number(id),
		updatedAt: Number(id),
		metadata: { topic: "user", stable: true },
	};
}
