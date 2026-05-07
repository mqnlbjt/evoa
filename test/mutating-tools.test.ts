import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BashExecuteOptions, BashExecutor } from "../src/tools/bash-executor.js";
import { createToolRegistryForProfile } from "../src/tools/profiles.js";
import type { AgentSession } from "../src/runtime/session.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "You are concise." },
	tools: { allowedTools: ["write_file", "edit_file", "bash"], permissionMode: "allow", maxToolCalls: 20 },
	runtime: { maxTurns: 1 },
};

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Mutate files",
	prompt: "Mutate files",
	scoring: { method: "exact" },
};

describe("mutating tools", () => {
	it("creates files inside the workspace", async () => {
		const root = await fixtureRoot();
		const registry = createToolRegistryForProfile({ profile: "coding", workspaceRoot: root });
		const session = createSession();

		const result = await registry.execute(session, { id: "1", name: "write_file", input: { path: "note.txt", content: "hello" } });

		expect(result.output).toMatchObject({ path: "note.txt", bytesWritten: 5, created: true });
		expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("hello");
	});

	it("overwrites existing files", async () => {
		const root = await fixtureRoot();
		await writeFile(path.join(root, "note.txt"), "old");
		const registry = createToolRegistryForProfile({ profile: "coding", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "write_file", input: { path: "note.txt", content: "new" } });

		expect(result.output).toMatchObject({ path: "note.txt", bytesWritten: 3, created: false });
		expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("new");
	});

	it("rejects writes outside the workspace", async () => {
		const root = await fixtureRoot();
		const outside = path.join(await fixtureRoot(), "secret.txt");
		const registry = createToolRegistryForProfile({ profile: "coding", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "write_file", input: { path: outside, content: "secret" } });

		expect(result.status).toBe("error");
		expect(result.errorMessage).toBe("Path is outside workspace root");
	});

	it("rejects writes through symlinks", async () => {
		const root = await fixtureRoot();
		const outside = path.join(await fixtureRoot(), "secret.txt");
		await writeFile(outside, "secret");
		await symlink(outside, path.join(root, "secret-link"));
		const registry = createToolRegistryForProfile({ profile: "coding", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "write_file", input: { path: "secret-link", content: "changed" } });

		expect(result.errorMessage).toBe("Path is a symlink");
		expect(await readFile(outside, "utf8")).toBe("secret");
	});

	it("applies exact edits", async () => {
		const root = await fixtureRoot();
		await writeFile(path.join(root, "note.txt"), "hello world");
		const registry = createToolRegistryForProfile({ profile: "coding", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "edit_file", input: { path: "note.txt", edits: [{ oldText: "world", newText: "agent" }] } });

		expect(result.output).toMatchObject({ path: "note.txt", editsApplied: 1, bytesWritten: 11 });
		expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("hello agent");
	});

	it("rejects missing edits without modifying the file", async () => {
		const root = await fixtureRoot();
		const file = path.join(root, "note.txt");
		await writeFile(file, "hello world");
		const registry = createToolRegistryForProfile({ profile: "coding", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "edit_file", input: { path: "note.txt", edits: [{ oldText: "missing", newText: "agent" }] } });

		expect(result.errorMessage).toBe("oldText not found");
		expect(await readFile(file, "utf8")).toBe("hello world");
	});

	it("rejects ambiguous edits without replaceAll", async () => {
		const root = await fixtureRoot();
		const file = path.join(root, "note.txt");
		await writeFile(file, "one one");
		const registry = createToolRegistryForProfile({ profile: "coding", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "edit_file", input: { path: "note.txt", edits: [{ oldText: "one", newText: "two" }] } });

		expect(result.errorMessage).toBe("oldText must occur exactly once");
		expect(await readFile(file, "utf8")).toBe("one one");
	});

	it("supports replaceAll edits", async () => {
		const root = await fixtureRoot();
		const file = path.join(root, "note.txt");
		await writeFile(file, "one one");
		const registry = createToolRegistryForProfile({ profile: "coding", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "edit_file", input: { path: "note.txt", edits: [{ oldText: "one", newText: "two", replaceAll: true }] } });

		expect(result.output).toMatchObject({ editsApplied: 2 });
		expect(await readFile(file, "utf8")).toBe("two two");
	});

	it("applies multiple edits all-or-nothing", async () => {
		const root = await fixtureRoot();
		const file = path.join(root, "note.txt");
		await writeFile(file, "alpha beta");
		const registry = createToolRegistryForProfile({ profile: "coding", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "edit_file", input: { path: "note.txt", edits: [{ oldText: "alpha", newText: "gamma" }, { oldText: "missing", newText: "delta" }] } });

		expect(result.errorMessage).toBe("oldText not found");
		expect(await readFile(file, "utf8")).toBe("alpha beta");
	});

	it("rejects binary files", async () => {
		const root = await fixtureRoot();
		await writeFile(path.join(root, "data.bin"), Buffer.from([0, 1, 2, 3]));
		const registry = createToolRegistryForProfile({ profile: "coding", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "edit_file", input: { path: "data.bin", edits: [{ oldText: "x", newText: "y" }] } });

		expect(result.errorMessage).toBe("File appears to be binary");
	});
});

describe("bash tool", () => {
	it("runs commands from the workspace cwd", async () => {
		const root = await fixtureRoot();
		await writeFile(path.join(root, "note.txt"), "hello");
		const registry = createToolRegistryForProfile({ profile: "benchmark-sandbox", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "bash", input: { command: "node -e \"console.log(process.cwd().endsWith('" + path.basename(root) + "'))\"" } });

		expect(result.output).toMatchObject({ cwd: ".", exitCode: 0, stdout: "true\n", truncated: false });
	});

	it("rejects outside cwd", async () => {
		const root = await fixtureRoot();
		const outside = await fixtureRoot();
		const registry = createToolRegistryForProfile({ profile: "benchmark-sandbox", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "bash", input: { command: "node -e \"console.log('x')\"", cwd: outside } });

		expect(result.errorMessage).toBe("Path is outside workspace root");
	});

	it("returns non-zero exit codes as output", async () => {
		const root = await fixtureRoot();
		const registry = createToolRegistryForProfile({ profile: "benchmark-sandbox", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "bash", input: { command: "node -e \"process.exit(7)\"" } });

		expect(result.status).toBe("success");
		expect(result.output).toMatchObject({ exitCode: 7 });
	});

	it("times out commands", async () => {
		const root = await fixtureRoot();
		const registry = createToolRegistryForProfile({ profile: "benchmark-sandbox", workspaceRoot: root, bashTimeoutMs: 50, bashMaxTimeoutMs: 100 });

		const result = await registry.execute(createSession(), { id: "1", name: "bash", input: { command: "node -e \"setTimeout(() => {}, 1000)\"" } });

		expect(result.output).toMatchObject({ timedOut: true });
	});

	it("truncates large output", async () => {
		const root = await fixtureRoot();
		const registry = createToolRegistryForProfile({ profile: "benchmark-sandbox", workspaceRoot: root, bashMaxOutputBytes: 10 });

		const result = await registry.execute(createSession(), { id: "1", name: "bash", input: { command: "node -e \"console.log('xxxxxxxxxxxxxxxxxxxx')\"" } });

		expect(result.output).toMatchObject({ truncated: true });
		expect((result.output as { stdout: string }).stdout.length).toBeLessThanOrEqual(10);
	});

	it("denies network bash commands in benchmark-sandbox", async () => {
		const root = await fixtureRoot();
		const registry = createToolRegistryForProfile({ profile: "benchmark-sandbox", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "bash", input: { command: "curl https://example.com" } });

		expect(result).toMatchObject({ status: "denied", metadata: { sandboxDecision: "deny", sandboxMode: "workspace" } });
	});

	it("uses injected bash executor", async () => {
		const root = await fixtureRoot();
		const calls: BashExecuteOptions[] = [];
		const bashExecutor: BashExecutor = { async execute(options) { calls.push(options); return { command: options.command, cwd: "fake", exitCode: 0, signal: null, stdout: "fake\n", stderr: "", truncated: false, timedOut: false, durationMs: 1 }; } };
		const registry = createToolRegistryForProfile({ profile: "benchmark-sandbox", workspaceRoot: root, bashExecutor });

		const result = await registry.execute(createSession(), { id: "1", name: "bash", input: { command: "node -e \"console.log('ok')\"" } });

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ command: "node -e \"console.log('ok')\"", cwd: root, workspaceRoot: root });
		expect(result.output).toMatchObject({ cwd: "fake", stdout: "fake\n" });
	});

	it("denies sandbox violations before injected executor runs", async () => {
		const root = await fixtureRoot();
		let executed = false;
		const bashExecutor: BashExecutor = { async execute(options) { executed = true; return { command: options.command, cwd: ".", exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: 1 }; } };
		const registry = createToolRegistryForProfile({ profile: "benchmark-sandbox", workspaceRoot: root, bashExecutor });

		const result = await registry.execute(createSession(), { id: "1", name: "bash", input: { command: "curl https://example.com" } });

		expect(result.status).toBe("denied");
		expect(executed).toBe(false);
	});

	it("keeps dangerous profile compatible without sandbox denial", async () => {
		const root = await fixtureRoot();
		const registry = createToolRegistryForProfile({ profile: "dangerous", workspaceRoot: root });

		const result = await registry.execute(createSession(), { id: "1", name: "bash", input: { command: "node -e \"console.log('ok')\"" } });

		expect(result).toMatchObject({ status: "success", output: { exitCode: 0, stdout: "ok\n" } });
	});
});

describe("tool profiles", () => {
	it("exposes read-only tools by default", async () => {
		const root = await fixtureRoot();
		const registry = createToolRegistryForProfile({ workspaceRoot: root });

		expect(registry.list().map((tool) => tool.name)).toEqual(["read_file", "list_dir", "find_files", "grep", "web_fetch"]);
	});

	it("exposes coding tools without bash", async () => {
		const root = await fixtureRoot();
		const registry = createToolRegistryForProfile({ profile: "coding", workspaceRoot: root });

		expect(registry.list().map((tool) => tool.name)).toEqual(["read_file", "list_dir", "find_files", "grep", "web_fetch", "write_file", "edit_file"]);
	});

	it("denies web_fetch in benchmark-sandbox", async () => {
		const root = await fixtureRoot();
		const registry = createToolRegistryForProfile({ profile: "benchmark-sandbox", workspaceRoot: root });
		const session = createSession();
		session.agent.tools.allowedTools = ["web_fetch"];

		const result = await registry.execute(session, { id: "1", name: "web_fetch", input: { url: "https://example.com" } });

		expect(result).toMatchObject({ status: "denied", metadata: { sandboxDecision: "deny", sandboxMode: "workspace" } });
	});
});

async function fixtureRoot(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "evolving-agent-mutating-"));
}

function createSession(): AgentSession {
	return { id: "session", agent, task, messages: [], trace: [], turnCount: 0, toolCallCount: 0 };
}
