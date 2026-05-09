import { describe, expect, it } from "vitest";
import { LlmMemoryExtractor } from "../src/memory/llm-extractor.js";
import type { MemoryExtractor } from "../src/memory/types.js";
import type { ModelClient, ModelRequest } from "../src/models/types.js";
import type { AgentSpec } from "../src/specs.js";

describe("LlmMemoryExtractor", () => {
	it("extracts structured semantic memories with local source refs", async () => {
		const extractor = new LlmMemoryExtractor(fakeModel(JSON.stringify({ memories: [{
			layer: "knowledge",
			content: "Alice likes to play tennis.",
			topic: "person",
			scope: "user",
			stable: true,
			key: "person.alice.hobby",
			suitability: "long_term",
			safety: "safe",
			reason: "durable preference",
			sourceMessageIndexes: [1],
		}] })), agent(), undefined, 1);

		const candidates = await extractor.extract(input("Alice likes to play tennis"));

		expect(candidates).toEqual(expect.arrayContaining([
			expect.objectContaining({
				layer: "knowledge",
				content: "Alice likes to play tennis.",
				scope: "user",
				metadata: expect.objectContaining({ key: "person.alice.hobby", suitability: "long_term", safety: "safe" }),
				sourceRefs: [expect.objectContaining({ id: "s1:1", messageIndex: 1 })],
			}),
		]));
	});

	it("marks memory extraction requests with a dedicated purpose", async () => {
		let seenRequest: ModelRequest | undefined;
		const extractor = new LlmMemoryExtractor({ async complete(request) { seenRequest = request; return { text: "{\"memories\":[]}" }; } }, agent(), undefined, 1);

		await extractor.extract(input("remember this"));

		expect(seenRequest?.purpose).toBe("memory-extraction");
		expect(seenRequest?.agent.id).toBe("agent-memory-extractor");
	});

	it("falls back when semantic JSON is invalid", async () => {
		const extractor = new LlmMemoryExtractor(fakeModel("not json"), agent(), episodeFallback(), 1);

		const candidates = await extractor.extract(input("hello"));

		expect(candidates).toEqual([expect.objectContaining({ layer: "episode", content: "user: hello" })]);
	});
});

function input(content: string) {
	return {
		agentId: "agent",
		sessionId: "s1",
		messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content }],
		trace: [],
		startMessageIndex: 1,
		now: () => 1,
		createId: () => "id",
	};
}

function agent(): AgentSpec {
	return {
		id: "agent",
		version: "1.0.0",
		name: "Agent",
		kind: "baseline",
		model: { provider: "local", model: "test-model" },
		prompts: { system: "sys" },
		tools: { allowedTools: [] },
		runtime: { maxTurns: 1, memoryPolicy: "long-term" },
	};
}

function fakeModel(text: string): ModelClient {
	return { async complete() { return { text }; } };
}

function episodeFallback(): MemoryExtractor {
	return { async extract(input) { return [{ layer: "episode", scope: "session", content: "user: hello", sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }], metadata: { sessionId: input.sessionId, topic: "general" } }]; } };
}
