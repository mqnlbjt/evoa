import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonMemoryStore } from "../src/memory/json-memory-store.js";
import type { MemoryItem } from "../src/memory/types.js";

describe("JsonMemoryStore", () => {
	it("appends and reads verified memories", async () => {
		const store = new JsonMemoryStore(await root());
		await store.append(item("1", "agent", "knowledge", "记住我是 wyq"));

		expect(await store.list("agent", "knowledge")).toHaveLength(1);
		expect(await store.latestVerified("agent")).toMatchObject([{ content: "记住我是 wyq" }]);
	});

	it("keeps quarantined memories out of latestVerified", async () => {
		const store = new JsonMemoryStore(await root());
		await store.append({ ...item("1", "agent", "knowledge", "maybe"), status: "quarantined" });

		expect(await store.list("agent", "knowledge")).toEqual([]);
		expect(await store.latestVerified("agent")).toEqual([]);
	});

	it("returns empty lists for missing files", async () => {
		const store = new JsonMemoryStore(await root());

		expect(await store.list("missing")).toEqual([]);
	});

	it("records revoked memories by source", async () => {
		const store = new JsonMemoryStore(await root());
		const memory = item("1", "agent", "knowledge", "remember me");
		await store.append(memory);
		await store.revokeBySource("agent", memory.sourceRefs[0]!);

		expect((await store.list("agent", "knowledge")).map((entry) => entry.status)).toEqual(["verified", "revoked"]);
	});

	it("sanitizes agent ids", async () => {
		const store = new JsonMemoryStore(await root());
		await store.append(item("1", "../agent", "knowledge", "safe"));

		expect(await store.latestVerified("../agent")).toHaveLength(1);
	});

	it("preserves memory scope and extended metadata", async () => {
		const store = new JsonMemoryStore(await root());
		await store.append({ ...item("1", "agent", "knowledge", "scoped"), scope: "project", metadata: { topic: "project", stable: true, projectId: "p1", key: "project.tech.language", expiresAt: 10, staleAfterMs: 5, priority: 2, supersedes: ["old"] } });

		expect(await store.latestVerified("agent")).toMatchObject([{ scope: "project", metadata: { projectId: "p1", key: "project.tech.language", expiresAt: 10, staleAfterMs: 5, priority: 2, supersedes: ["old"] } }]);
	});
});

async function root(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "evolving-agent-memory-store-"));
}

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
