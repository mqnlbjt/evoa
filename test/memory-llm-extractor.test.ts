import { describe, expect, it } from "vitest";
import { LlmMemoryExtractor } from "../src/memory/llm-extractor.js";
import type { MemoryExtractor } from "../src/memory/types.js";
import type { ModelClient } from "../src/models/types.js";
import type { AgentSpec } from "../src/specs.js";

describe("LlmMemoryExtractor", () => {
	it("extracts structured semantic memories with local source refs", async () => {
		const extractor = new LlmMemoryExtractor(fakeModel(JSON.stringify({ memories: [{
			layer: "knowledge",
			content: "黄金山喜欢玩原神。",
			topic: "person",
			scope: "user",
			stable: true,
			key: "person.黄金山.hobby",
			suitability: "long_term",
			safety: "safe",
			reason: "durable preference",
			sourceMessageIndexes: [1],
		}] })), agent());

		const candidates = await extractor.extract(input("黄金山爱玩原神"));

		expect(candidates).toEqual(expect.arrayContaining([
			expect.objectContaining({
				layer: "knowledge",
				content: "黄金山喜欢玩原神。",
				scope: "user",
				metadata: expect.objectContaining({ key: "person.黄金山.hobby", suitability: "long_term", safety: "safe" }),
				sourceRefs: [expect.objectContaining({ id: "s1:1", messageIndex: 1 })],
			}),
		]));
	});

	it("falls back when semantic JSON is invalid", async () => {
		const extractor = new LlmMemoryExtractor(fakeModel("not json"), agent(), fakeFallback());

		const candidates = await extractor.extract(input("hello"));

		expect(candidates).toEqual([expect.objectContaining({ content: "fallback" })]);
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

function fakeFallback(): MemoryExtractor {
	return { async extract() { return [{ layer: "knowledge", content: "fallback", sourceRefs: [{ kind: "message", id: "s1:1", sessionId: "s1", messageIndex: 1, excerptHash: "hash" }] }]; } };
}
