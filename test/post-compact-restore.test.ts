import { describe, expect, it } from "vitest";
import { postCompactRestore } from "../src/runtime/post-compact-restore.js";
import type { SessionEntry } from "../src/runtime/session.js";

describe("postCompactRestore", () => {
	it("returns empty for empty entries", () => {
		const result = postCompactRestore([]);
		expect(result.messages).toEqual([]);
		expect(result.restoredFiles).toEqual([]);
	});

	it("extracts recently read files from tool results", () => {
		const entries: SessionEntry[] = [
			{
				id: "1", kind: "tool_result", createdAt: 1,
				message: { role: "tool", toolCallId: "c1", toolName: "Read", content: "content A" },
				modelVisibleContent: "content A",
				result: { call: { id: "c1", name: "Read", input: { path: "/tmp/a.ts" } }, decision: { decision: "allow", reason: "test" }, status: "success" },
			},
		];
		const result = postCompactRestore(entries);
		expect(result.restoredFiles).toEqual(["/tmp/a.ts"]);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.content).toContain("content A");
		expect(result.messages[0]?.content).toContain("/tmp/a.ts");
	});

	it("deduplicates by path, keeping latest", () => {
		const entries: SessionEntry[] = [
			{
				id: "1", kind: "tool_result", createdAt: 1,
				message: { role: "tool", toolCallId: "c1", toolName: "Read", content: "old" },
				modelVisibleContent: "old",
				result: { call: { id: "c1", name: "Read", input: { path: "/tmp/a.ts" } }, decision: { decision: "allow", reason: "test" }, status: "success" },
			},
			{
				id: "2", kind: "tool_result", createdAt: 2,
				message: { role: "tool", toolCallId: "c2", toolName: "Read", content: "new" },
				modelVisibleContent: "new",
				result: { call: { id: "c2", name: "Read", input: { path: "/tmp/a.ts" } }, decision: { decision: "allow", reason: "test" }, status: "success" },
			},
		];
		const result = postCompactRestore(entries);
		expect(result.restoredFiles).toEqual(["/tmp/a.ts"]);
		expect(result.messages[0]?.content).toContain("new");
	});

	it("respects maxFiles limit", () => {
		const entries: SessionEntry[] = [
			makeReadResult("1", "/tmp/a.ts", "a"),
			makeReadResult("2", "/tmp/b.ts", "b"),
			makeReadResult("3", "/tmp/c.ts", "c"),
			makeReadResult("4", "/tmp/d.ts", "d"),
			makeReadResult("5", "/tmp/e.ts", "e"),
			makeReadResult("6", "/tmp/f.ts", "f"),
		] as SessionEntry[];
		const result = postCompactRestore(entries, { maxFiles: 3, maxTokensPerFile: 5000, maxTotalTokens: 50000 });
		expect(result.restoredFiles).toHaveLength(3);
	});

	it("skips non-restorable tool results (Bash)", () => {
		const entries: SessionEntry[] = [
			{
				id: "1", kind: "tool_result", createdAt: 1,
				message: { role: "tool", toolCallId: "c1", toolName: "Bash", content: "ls output" },
				modelVisibleContent: "ls output",
				result: { call: { id: "c1", name: "Bash", input: { command: "ls" } }, decision: { decision: "allow", reason: "test" }, status: "success" },
			},
		];
		const result = postCompactRestore(entries);
		expect(result.restoredFiles).toEqual([]);
	});

	it("restores Grep results", () => {
		const entries: SessionEntry[] = [
			{
				id: "1", kind: "tool_result", createdAt: 1,
				message: { role: "tool", toolCallId: "c1", toolName: "Grep", content: "found: line 42" },
				modelVisibleContent: "found: line 42",
				result: { call: { id: "c1", name: "Grep", input: { path: "/tmp/a.ts", pattern: "TODO" } }, decision: { decision: "allow", reason: "test" }, status: "success" },
			},
		];
		const result = postCompactRestore(entries);
		expect(result.restoredFiles).toEqual(["/tmp/a.ts"]);
		expect(result.messages[0]?.content).toContain("found: line 42");
		expect(result.messages[0]?.content).toContain("Grep");
	});

	it("restores Glob results", () => {
		const entries: SessionEntry[] = [
			{
				id: "1", kind: "tool_result", createdAt: 1,
				message: { role: "tool", toolCallId: "c1", toolName: "Glob", content: "a.ts\nb.ts" },
				modelVisibleContent: "a.ts\nb.ts",
				result: { call: { id: "c1", name: "Glob", input: { pattern: "**/*.ts" } }, decision: { decision: "allow", reason: "test" }, status: "success" },
			},
		];
		const result = postCompactRestore(entries);
		expect(result.restoredFiles).toEqual(["**/*.ts"]);
		expect(result.messages[0]?.content).toContain("a.ts");
	});

	it("restores WebFetch results", () => {
		const entries: SessionEntry[] = [
			{
				id: "1", kind: "tool_result", createdAt: 1,
				message: { role: "tool", toolCallId: "c1", toolName: "WebFetch", content: "<html>docs</html>" },
				modelVisibleContent: "<html>docs</html>",
				result: { call: { id: "c1", name: "WebFetch", input: { url: "https://example.com/docs" } }, decision: { decision: "allow", reason: "test" }, status: "success" },
			},
		];
		const result = postCompactRestore(entries);
		expect(result.restoredFiles).toEqual(["https://example.com/docs"]);
		expect(result.messages[0]?.content).toContain("<html>docs</html>");
	});

	it("restores most recent user request as task anchor", () => {
		const entries: SessionEntry[] = [
			{
				id: "u1", kind: "user", createdAt: 1,
				message: { role: "user", content: "请修复 context compaction 的 bug" },
			},
			{
				id: "a1", kind: "assistant", createdAt: 2,
				message: { role: "assistant", content: "好的，我来修复这个 bug" },
			},
		] as SessionEntry[];
		const result = postCompactRestore(entries);
		expect(result.messages.length).toBeGreaterThanOrEqual(1);
		expect(result.messages.some((m) => m.content.includes("请修复 context compaction 的 bug"))).toBe(true);
		expect(result.messages.some((m) => m.content.includes("好的，我来修复这个 bug"))).toBe(true);
	});

	it("deduplicates by toolName:path, keeping different tools on same path", () => {
		const entries: SessionEntry[] = [
			{
				id: "1", kind: "tool_result", createdAt: 1,
				message: { role: "tool", toolCallId: "c1", toolName: "Read", content: "read content" },
				modelVisibleContent: "read content",
				result: { call: { id: "c1", name: "Read", input: { path: "/tmp/a.ts" } }, decision: { decision: "allow", reason: "test" }, status: "success" },
			},
			{
				id: "2", kind: "tool_result", createdAt: 2,
				message: { role: "tool", toolCallId: "c2", toolName: "Grep", content: "grep result" },
				modelVisibleContent: "grep result",
				result: { call: { id: "c2", name: "Grep", input: { path: "/tmp/a.ts", pattern: "TODO" } }, decision: { decision: "allow", reason: "test" }, status: "success" },
			},
		];
		const result = postCompactRestore(entries);
		expect(result.restoredFiles).toHaveLength(2);
		expect(result.restoredFiles).toContain("/tmp/a.ts");
		expect(result.messages.some((m) => m.content.includes("read content"))).toBe(true);
		expect(result.messages.some((m) => m.content.includes("grep result"))).toBe(true);
	});
});

function makeReadResult(id: string, path: string, content: string): unknown {
	return {
		id, kind: "tool_result", createdAt: 1,
		message: { role: "tool", toolCallId: id, toolName: "Read", content },
		modelVisibleContent: content,
		result: { call: { id, name: "Read", input: { path } }, decision: { decision: "allow", reason: "test" }, status: "success" },
	};
}
