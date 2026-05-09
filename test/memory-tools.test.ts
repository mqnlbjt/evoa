import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonMemoryStore } from "../src/memory/json-memory-store.js";
import { MemoryManager } from "../src/memory/manager.js";
import { createMemoryTools } from "../src/memory/tools.js";
import { createAgentSession } from "../src/runtime/session.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { EvolvingAgentTool } from "../src/tools/types.js";
import type { MemoryItem } from "../src/memory/types.js";

describe("memory tools", () => {
	it("returns memory context items", async () => {
		const store = new JsonMemoryStore(await root());
		await store.append(memory("stable", "默认中文回答", { stable: true }));
		await store.append(memory("dynamic", "项目使用 TypeScript", { stable: false }));
		const registry = registryFor(store);
		const result = await execute(registry, "memory_context", { query: "默认 TypeScript" });

		expect(result.status).toBe("success");
		expect(result.output).toMatchObject({ stableItemIds: ["stable"], dynamicItemIds: ["dynamic"] });
	});

	it("searches and reads only verified in-scope memories", async () => {
		const store = new JsonMemoryStore(await root());
		await store.append(memory("visible", "默认中文回答", { stable: true }));
		await store.append(memory("quarantined", "中文敏感事实", { stable: true }, { status: "quarantined" }));
		await store.append(memory("other-project", "中文项目事实", { stable: true, projectId: "other" }, { scope: "project" }));
		const registry = registryFor(store);

		const search = await execute(registry, "memory_search", { query: "中文", limit: 5 });
		expect(search.output).toMatchObject({ items: [expect.objectContaining({ id: "visible" })] });

		const read = await execute(registry, "memory_read", { ids: ["visible", "quarantined", "other-project"] });
		expect(read.output).toMatchObject({ items: [expect.objectContaining({ id: "visible" })], missing: ["quarantined", "other-project"] });
	});

	it("remembers, updates, and forgets through append-only tool calls", async () => {
		const store = new JsonMemoryStore(await root());
		const registry = registryFor(store);
		const remember = await execute(registry, "memory_remember", { content: "默认中文回答", layer: "knowledge", scope: "user", stable: true, key: "user.preference.language" });
		const firstId = itemId(remember.output);

		expect(remember.status).toBe("success");
		expect(remember.output).toMatchObject({ item: expect.objectContaining({ status: "verified", sourceRefs: [expect.objectContaining({ kind: "trace_event" })] }) });

		const update = await execute(registry, "memory_update", { id: firstId, content: "默认英文回答", reason: "用户纠正" });
		const secondId = itemId(update.output);
		expect(update.output).toMatchObject({ previousId: firstId, item: expect.objectContaining({ metadata: expect.objectContaining({ supersedes: [firstId] }) }) });

		const search = await execute(registry, "memory_search", { query: "默认" });
		expect(search.output).toMatchObject({ items: [expect.objectContaining({ id: secondId })] });

		const forget = await execute(registry, "memory_forget", { ids: [secondId], reason: "用户要求删除" });
		expect(forget.output).toMatchObject({ revoked: [secondId], missing: [] });
		expect((await execute(registry, "memory_read", { ids: [secondId] })).output).toMatchObject({ items: [], missing: [secondId] });
	});

	it("uses low parallel-safe policies for reads and medium sequential policies for writes", async () => {
		const registry = registryFor(new JsonMemoryStore(await root()));
		for (const name of ["memory_context", "memory_search", "memory_read"]) {
			expect(registry.get(name)).toMatchObject({ concurrency: "parallel-safe", permission: { defaultDecision: "allow", riskLevel: "low" } });
		}
		for (const name of ["memory_remember", "memory_update", "memory_forget"]) {
			expect(registry.get(name)).toMatchObject({ concurrency: "sequential", permission: { defaultDecision: "allow", riskLevel: "medium" } });
		}
	});
});

async function root(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "evolving-agent-memory-tools-"));
}

function registryFor(store: JsonMemoryStore): ToolRegistry {
	const manager = new MemoryManager(store);
	return new ToolRegistry(createMemoryTools({ manager, projectId: "project", now: () => 2, createId: ids() }));
}

async function execute(registry: ToolRegistry, name: string, input: unknown) {
	return registry.execute(createAgentSession({ id: "s1", agent, task }), { id: `${name}-call`, name, input });
}

function ids(): () => string {
	let index = 0;
	return () => `id-${++index}`;
}

function itemId(output: unknown): string {
	if (typeof output !== "object" || output === null || !("item" in output)) throw new Error("missing item output");
	const item = (output as { item?: { id?: unknown } }).item;
	if (!item || typeof item.id !== "string") throw new Error("missing item id");
	return item.id;
}

function memory(id: string, content: string, metadata: NonNullable<MemoryItem["metadata"]>, overrides: Partial<MemoryItem> = {}): MemoryItem {
	return {
		id,
		agentId: "agent",
		layer: "knowledge",
		scope: "user",
		content,
		sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }],
		confidence: 1,
		status: "verified",
		createdAt: 1,
		updatedAt: 1,
		metadata,
		...overrides,
	};
}

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "local", model: "test" },
	prompts: { system: "Use memory." },
	tools: { allowedTools: ["memory_context", "memory_search", "memory_read", "memory_remember", "memory_update", "memory_forget"], permissionMode: "allow" },
	runtime: { maxTurns: 3, memoryPolicy: "long-term" },
};

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Task",
	prompt: "默认",
	scoring: { method: "rubric", config: { contains: [] } },
};
