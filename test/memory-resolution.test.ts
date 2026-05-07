import { describe, expect, it } from "vitest";
import { effectiveScope, isMemoryInScope, isMemoryStale, resolveReadableMemories } from "../src/memory/resolution.js";
import type { MemoryContextRequest, MemoryItem, MemoryScope } from "../src/memory/types.js";

describe("memory resolution", () => {
	it("infers legacy scopes deterministically", () => {
		expect(effectiveScope(item("1", { layer: "episode" }))).toBe("session");
		expect(effectiveScope(item("2", { metadata: { topic: "project" } }))).toBe("project");
		expect(effectiveScope(item("3", { metadata: { topic: "user" } }))).toBe("agent");
	});

	it("filters memories by scope", () => {
		const request = context({ sessionId: "s1", projectId: "p1" });
		expect(isMemoryInScope(item("1", { scope: "session", metadata: { sessionId: "s1" } }), request)).toBe(true);
		expect(isMemoryInScope(item("2", { scope: "session", metadata: { sessionId: "s2" } }), request)).toBe(false);
		expect(isMemoryInScope(item("3", { scope: "project", metadata: { projectId: "p1" } }), request)).toBe(true);
		expect(isMemoryInScope(item("4", { scope: "project", metadata: { projectId: "p2" } }), request)).toBe(false);
	});

	it("marks expired memories as stale", () => {
		const request = context({ now: () => 10 });
		expect(isMemoryStale(item("1", { metadata: { expiresAt: 10 } }), request)).toBe(true);
		expect(isMemoryStale(item("2", { metadata: { expiresAt: 11 } }), request)).toBe(false);
		expect(isMemoryStale(item("3", { updatedAt: 5, metadata: { staleAfterMs: 5 } }), request)).toBe(true);
	});

	it("keeps only the highest-priority memory for each conflict key", () => {
		const oldLanguage = item("old", { scope: "user", content: "以后默认中文回答", metadata: { key: "user.preference.language", stable: true }, updatedAt: 1 });
		const newLanguage = item("new", { scope: "user", content: "以后默认英文回答", metadata: { key: "user.preference.language", stable: true }, updatedAt: 2 });

		expect(resolveReadableMemories([oldLanguage, newLanguage], context()).map((entry) => entry.id)).toEqual(["new"]);
	});

	it("prefers more specific in-scope memories over broader memories", () => {
		const userMemory = item("user", { scope: "user", content: "默认中文回答", metadata: { key: "user.preference.language", stable: true }, updatedAt: 3 });
		const projectMemory = item("project", { scope: "project", content: "本项目默认英文回答", metadata: { key: "user.preference.language", projectId: "p1", stable: true }, updatedAt: 1 });
		const sessionMemory = item("session", { scope: "session", content: "本轮默认日文回答", metadata: { key: "user.preference.language", sessionId: "s1", stable: true }, updatedAt: 1 });

		expect(resolveReadableMemories([userMemory, projectMemory, sessionMemory], context({ sessionId: "s1", projectId: "p1" })).map((entry) => entry.id)).toEqual(["session"]);
	});

	it("hides memories superseded by in-scope replacement items", () => {
		const oldMemory = item("old", { scope: "user", content: "默认中文回答", metadata: { key: "user.preference.language", stable: true } });
		const newMemory = item("new", { scope: "user", content: "默认英文回答", metadata: { key: "user.preference.language", stable: true, supersedes: ["old"] } });

		expect(resolveReadableMemories([oldMemory, newMemory], context()).map((entry) => entry.id)).toEqual(["new"]);
	});

	it("hides memories superseded by revoked tombstones", () => {
		const oldMemory = item("old", { scope: "user", content: "默认中文回答", metadata: { key: "user.preference.language", stable: true } });
		const tombstone = item("tombstone", { scope: "user", status: "revoked", metadata: { key: "user.preference.language", stable: true, supersedes: ["old"] } });

		expect(resolveReadableMemories([oldMemory, tombstone], context())).toEqual([]);
	});

	it("does not let out-of-scope tombstones hide readable memories", () => {
		const oldMemory = item("old", { scope: "session", metadata: { sessionId: "s1", stable: true } });
		const otherSessionTombstone = item("tombstone", { scope: "session", status: "revoked", metadata: { sessionId: "s2", stable: true, supersedes: ["old"] } });

		expect(resolveReadableMemories([oldMemory, otherSessionTombstone], context({ sessionId: "s1" })).map((entry) => entry.id)).toEqual(["old"]);
	});
});

function context(overrides: Partial<MemoryContextRequest> = {}): MemoryContextRequest {
	return { agentId: "agent", sessionId: "s1", projectId: "p1", prompt: "", now: () => 2, ...overrides };
}

function item(id: string, overrides: Partial<MemoryItem> & { scope?: MemoryScope } = {}): MemoryItem {
	return {
		id,
		agentId: "agent",
		layer: "knowledge",
		content: id,
		sourceRefs: [{ kind: "message", id: "s:1", sessionId: "s", messageIndex: 1, excerptHash: "hash" }],
		confidence: 1,
		status: "verified",
		createdAt: 1,
		updatedAt: 1,
		metadata: { topic: "user", stable: true, ...overrides.metadata },
		...overrides,
	};
}
