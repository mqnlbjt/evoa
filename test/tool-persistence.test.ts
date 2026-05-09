import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { persistLargeToolOutput } from "../src/runtime/tool-persistence.js";

describe("persistLargeToolOutput", () => {
	const sessionId = "test-session-1";
	const toolCallId = "call-abc123";

	function tmpDir() {
		return mkdtempSync(path.join(tmpdir(), "tool-persistence-test-"));
	}

	function largeOutput(len: number) {
		return "x".repeat(len);
	}

	it("returns output unchanged when below threshold", async () => {
		const dir = tmpDir();
		const output = largeOutput(1000);
		const result = await persistLargeToolOutput(output, toolCallId, "Bash", dir, sessionId);
		expect(result.content).toBe(output);
		expect(result.persistedPath).toBeUndefined();
	});

	it("persists large output to disk and returns preview", async () => {
		const dir = tmpDir();
		const output = largeOutput(40_000); // > 32KB
		const result = await persistLargeToolOutput(output, toolCallId, "Bash", dir, sessionId);
		expect(result.persistedPath).toBeDefined();
		expect(result.content).not.toBe(output);
		expect(result.content).toContain("<tool-result-preview>");
		expect(result.content).toContain("40000 bytes");
		expect(result.content).toContain(result.persistedPath!);

		// Verify disk file has full content
		expect(existsSync(result.persistedPath!)).toBe(true);
		const diskContent = await readFile(result.persistedPath!, "utf8");
		expect(diskContent).toBe(output);
	});

	it("does not persist Read tool outputs", async () => {
		const dir = tmpDir();
		const output = largeOutput(40_000);
		const result = await persistLargeToolOutput(output, toolCallId, "Read", dir, sessionId);
		expect(result.content).toBe(output);
		expect(result.persistedPath).toBeUndefined();
	});

	it("does not persist read_file tool outputs", async () => {
		const dir = tmpDir();
		const output = largeOutput(40_000);
		const result = await persistLargeToolOutput(output, toolCallId, "read_file", dir, sessionId);
		expect(result.content).toBe(output);
		expect(result.persistedPath).toBeUndefined();
	});

	it("respects custom minBytes threshold", async () => {
		const dir = tmpDir();
		const output = largeOutput(5_000);
		const result = await persistLargeToolOutput(output, toolCallId, "Bash", dir, sessionId, 4_000);
		expect(result.persistedPath).toBeDefined();
		expect(result.content).toContain("<tool-result-preview>");

		const result2 = await persistLargeToolOutput(output, toolCallId, "Bash", dir, sessionId, 10_000);
		expect(result2.persistedPath).toBeUndefined();
	});

	it("returns original output when storage path cannot be created", async () => {
		const dir = tmpDir();
		const blockedPath = path.join(dir, "blocked");
		await writeFile(blockedPath, "not a directory");
		const output = largeOutput(40_000);
		const result = await persistLargeToolOutput(output, toolCallId, "Bash", blockedPath, sessionId);
		expect(result.content).toBe(output);
		expect(result.persistedPath).toBeUndefined();
	});

	it("preview is truncated to 2000 bytes", async () => {
		const dir = tmpDir();
		const output = "A".repeat(256) + "B".repeat(40_000);
		const result = await persistLargeToolOutput(output, toolCallId, "Bash", dir, sessionId);
		expect(result.persistedPath).toBeDefined();

		const previewStart = result.content.indexOf("A".repeat(256));
		expect(previewStart).toBeGreaterThan(0);
	});
});
