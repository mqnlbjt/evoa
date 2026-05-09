import { describe, expect, it } from "vitest";
import { CacheBreakDetector, computeContentHash, computeToolHash } from "../src/runtime/cache-break.js";
import type { ModelToolDefinition } from "../src/models/types.js";

const sampleTools: ModelToolDefinition[] = [
	{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
	{ name: "write", description: "Write a file", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
];

describe("computeContentHash", () => {
	it("produces consistent hashes", () => {
		expect(computeContentHash("hello")).toBe(computeContentHash("hello"));
	});

	it("produces different hashes for different content", () => {
		expect(computeContentHash("hello")).not.toBe(computeContentHash("world"));
	});

	it("handles empty string", () => {
		expect(computeContentHash("")).toBe(computeContentHash(""));
	});
});

describe("computeToolHash", () => {
	it("produces consistent hashes", () => {
		expect(computeToolHash(sampleTools)).toBe(computeToolHash(sampleTools));
	});

	it("returns no-tools for empty array", () => {
		expect(computeToolHash([])).toBe("no-tools");
	});

	it("order-independent", () => {
		const reversed = [...sampleTools].reverse();
		expect(computeToolHash(sampleTools)).toBe(computeToolHash(reversed));
	});
});

describe("CacheBreakDetector", () => {
	it("first call never triggers break", () => {
		const detector = new CacheBreakDetector();
		const result = detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 1000 });
		expect(result.broken).toBe(false);
		expect(result.reason).toBe("none");
	});

	it("detects content change from system prompt hash", () => {
		const detector = new CacheBreakDetector();
		detector.detect({ systemContent: "sys v1", toolDefinitions: sampleTools, cacheReadTokens: 1000 });
		const result = detector.detect({ systemContent: "sys v2", toolDefinitions: sampleTools, cacheReadTokens: 500 });
		expect(result.broken).toBe(true);
		expect(result.reason).toBe("content_changed");
	});

	it("detects content change from tool hash", () => {
		const detector = new CacheBreakDetector();
		detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 1000 });
		const differentTools: ModelToolDefinition[] = [
			{ name: "search", description: "Search", inputSchema: {} },
		];
		const result = detector.detect({ systemContent: "sys", toolDefinitions: differentTools, cacheReadTokens: 500 });
		expect(result.broken).toBe(true);
		expect(result.reason).toBe("content_changed");
	});

	it("detects cache eviction when read tokens drop below 50%", () => {
		const detector = new CacheBreakDetector();
		detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 2000 });
		const result = detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 500 });
		expect(result.broken).toBe(true);
		expect(result.reason).toBe("cache_evicted");
	});

	it("no break when cache read tokens increase", () => {
		const detector = new CacheBreakDetector();
		detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 500 });
		const result = detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 2000 });
		expect(result.broken).toBe(false);
	});

	it("no break when cache read tokens stay similar", () => {
		const detector = new CacheBreakDetector();
		detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 1000 });
		const result = detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 900 });
		expect(result.broken).toBe(false);
	});

	it("reset clears state", () => {
		const detector = new CacheBreakDetector();
		detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 1000 });
		detector.reset();
		const result = detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 100 });
		expect(result.broken).toBe(false);
	});

	it("includes previous and current hashes in result", () => {
		const detector = new CacheBreakDetector();
		detector.detect({ systemContent: "sys v1", toolDefinitions: sampleTools, cacheReadTokens: 1000 });
		const result = detector.detect({ systemContent: "sys v2", toolDefinitions: sampleTools, cacheReadTokens: 500 });
		expect(result.previousSystemHash).toBeTruthy();
		expect(result.currentSystemHash).toBeTruthy();
		expect(result.previousSystemHash).not.toBe(result.currentSystemHash);
	});

	it("no eviction when previous cache tokens is 0", () => {
		const detector = new CacheBreakDetector();
		detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 0 });
		const result = detector.detect({ systemContent: "sys", toolDefinitions: sampleTools, cacheReadTokens: 0 });
		expect(result.broken).toBe(false);
	});
});
