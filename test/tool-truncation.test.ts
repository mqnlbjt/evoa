import { describe, expect, it } from "vitest";
import { normalizeToolResultForModel, type ToolResult } from "../src/tools/registry.js";
import { byteLength, truncateToolOutput, truncateUtf8Head, truncateUtf8Tail } from "../src/tools/truncation.js";

const baseResult: Omit<ToolResult, "output"> = {
	call: { id: "call-1", name: "echo" },
	decision: { decision: "allow", reason: "allowed" },
	status: "success",
};

describe("tool output truncation", () => {
	it("keeps small output unchanged with metadata", () => {
		const normalized = normalizeToolResultForModel({ ...baseResult, output: { value: "ok" } }, { maxBytes: 1000 });

		expect(normalized.content).toBe(JSON.stringify({ value: "ok" }));
		expect(normalized.metadata).toMatchObject({ truncated: false, strategy: "none" });
	});

	it("keeps head and tail for large output", () => {
		const large = `${"a".repeat(100)}MIDDLE${"z".repeat(100)}`;
		const normalized = normalizeToolResultForModel({ ...baseResult, output: { value: large } }, { maxBytes: 160, headBytes: 30, tailBytes: 30 });
		const parsed = JSON.parse(normalized.content) as { truncated: boolean; strategy: string; head: string; tail: string; omittedBytes: number };

		expect(parsed).toMatchObject({ truncated: true, strategy: "head-tail" });
		expect(parsed.head).toContain("aaa");
		expect(parsed.tail).toContain("zzz");
		expect(parsed.head).not.toContain("MIDDLE");
		expect(parsed.tail).not.toContain("MIDDLE");
		expect(parsed.omittedBytes).toBeGreaterThan(0);
		expect(byteLength(normalized.content)).toBeLessThanOrEqual(160);
	});

	it("does not split utf-8 characters", () => {
		const output = truncateToolOutput("你好".repeat(50), { maxBytes: 140, headBytes: 9, tailBytes: 9 });
		const parsed = JSON.parse(output.content) as { head: string; tail: string };

		expect(parsed.head).toBe("你好你");
		expect(parsed.tail).toBe("好你好");
		expect(byteLength(output.content)).toBeLessThanOrEqual(140);
	});

	it("respects maxBytes with includeMetadata true and head-tail strategy", () => {
		const output = truncateToolOutput("x".repeat(500), { maxBytes: 200, strategy: "head-tail", includeMetadata: true });

		expect(byteLength(output.content)).toBeLessThanOrEqual(200);
		expect(output.metadata.truncated).toBe(true);
		expect(output.metadata.headBytes).toBeGreaterThan(0);
		expect(output.metadata.tailBytes).toBeGreaterThan(0);
	});

	it("respects maxBytes with includeMetadata true and head-only strategy", () => {
		const output = truncateToolOutput("x".repeat(500), { maxBytes: 200, strategy: "head-only", includeMetadata: true });

		expect(byteLength(output.content)).toBeLessThanOrEqual(200);
		expect(output.metadata.truncated).toBe(true);
		expect(output.metadata.headBytes).toBeGreaterThan(0);
	});

	it("respects maxBytes with includeMetadata false", () => {
		const output = truncateToolOutput("x".repeat(100), { maxBytes: 20, strategy: "head-only", includeMetadata: false });

		expect(byteLength(output.content)).toBeLessThanOrEqual(20);
	});

	it("returns error fallback when maxBytes too small for JSON wrapper (head-only)", () => {
		const output = truncateToolOutput("x".repeat(500), { maxBytes: 30, strategy: "head-only", includeMetadata: true });

		expect(byteLength(output.content)).toBeLessThanOrEqual(30);
		expect(output.metadata.truncated).toBe(true);
	});

	it("returns error fallback when maxBytes too small for JSON wrapper (head-tail)", () => {
		const output = truncateToolOutput("x".repeat(500), { maxBytes: 30, strategy: "head-tail", includeMetadata: true });

		expect(byteLength(output.content)).toBeLessThanOrEqual(30);
		expect(output.metadata.truncated).toBe(true);
	});

	it("truncateUtf8Head respects byte boundaries", () => {
		expect(truncateUtf8Head("abc", 10)).toBe("abc");
		expect(truncateUtf8Head("abc", 2)).toBe("ab");
		expect(truncateUtf8Head("abc", 0)).toBe("");
		expect(truncateUtf8Head("你好", 3)).toBe("你");
	});

	it("truncateUtf8Tail respects byte boundaries", () => {
		expect(truncateUtf8Tail("abc", 10)).toBe("abc");
		expect(truncateUtf8Tail("abc", 2)).toBe("bc");
		expect(truncateUtf8Tail("abc", 0)).toBe("");
		expect(truncateUtf8Tail("你好", 3)).toBe("好");
	});
});
