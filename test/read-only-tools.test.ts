import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReadOnlyToolRegistry } from "../src/tools/read-only.js";
import type { AgentSession } from "../src/runtime/session.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "You are concise." },
	tools: { allowedTools: ["read_file", "list_dir", "find_files", "grep"], permissionMode: "allow", maxToolCalls: 20 },
	runtime: { maxTurns: 1 },
};

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Answer",
	prompt: "Inspect files",
	scoring: { method: "exact" },
};

const session: AgentSession = { id: "session", agent, task, messages: [], trace: [], turnCount: 0, toolCallCount: 0 };

describe("read-only tools", () => {
	it("reads files inside the workspace", async () => {
		const root = await fixtureRoot();
		await writeFile(path.join(root, "README.md"), "hello\nworld\n");
		const registry = createReadOnlyToolRegistry({ workspaceRoot: root });

		const result = await registry.execute(session, { id: "1", name: "read_file", input: { path: "README.md" } });

		expect(result.output).toMatchObject({ path: "README.md", content: "hello\nworld\n", sizeBytes: 12 });
	});

	it("rejects paths outside the workspace", async () => {
		const root = await fixtureRoot();
		const outside = path.join(await fixtureRoot(), "secret.txt");
		await writeFile(outside, "secret");
		const registry = createReadOnlyToolRegistry({ workspaceRoot: root });

		const result = await registry.execute(session, { id: "1", name: "read_file", input: { path: outside } });

		expect(result.errorMessage).toBe("Path is outside workspace root");
	});

	it("rejects symlinks escaping the workspace", async () => {
		const root = await fixtureRoot();
		const outside = path.join(await fixtureRoot(), "secret.txt");
		await writeFile(outside, "secret");
		await symlink(outside, path.join(root, "secret-link"));
		const registry = createReadOnlyToolRegistry({ workspaceRoot: root });

		const result = await registry.execute(session, { id: "1", name: "read_file", input: { path: "secret-link" } });

		expect(result.errorMessage).toBe("Path is outside workspace root");
	});

	it("lists directory entries with stable types", async () => {
		const root = await fixtureRoot();
		await writeFile(path.join(root, "b.txt"), "b");
		await mkdir(path.join(root, "a-dir"));
		const registry = createReadOnlyToolRegistry({ workspaceRoot: root });

		const result = await registry.execute(session, { id: "1", name: "list_dir", input: { path: "." } });

		expect(result.output).toMatchObject({
			path: ".",
			entries: [
				{ name: "a-dir", type: "directory" },
				{ name: "b.txt", type: "file" },
			],
			truncated: false,
		});
	});

	it("finds files by glob and skips ignored directories", async () => {
		const root = await fixtureRoot();
		await mkdir(path.join(root, "src"));
		await mkdir(path.join(root, "node_modules"));
		await writeFile(path.join(root, "src", "app.ts"), "const app = true;");
		await writeFile(path.join(root, "node_modules", "ignored.ts"), "ignored");
		const registry = createReadOnlyToolRegistry({ workspaceRoot: root });

		const result = await registry.execute(session, { id: "1", name: "find_files", input: { pattern: "**/*.ts" } });

		expect(result.output).toMatchObject({ matches: ["src/app.ts"], truncated: false });
	});

	it("greps files and reports line numbers", async () => {
		const root = await fixtureRoot();
		await writeFile(path.join(root, "README.md"), "alpha\nbeta\n");
		const registry = createReadOnlyToolRegistry({ workspaceRoot: root });

		const result = await registry.execute(session, { id: "1", name: "grep", input: { pattern: "beta" } });

		expect(result.output).toMatchObject({ matches: [{ path: "README.md", line: 2, text: "beta" }], truncated: false });
	});

	it("returns invalid regex errors", async () => {
		const root = await fixtureRoot();
		const registry = createReadOnlyToolRegistry({ workspaceRoot: root });

		const result = await registry.execute(session, { id: "1", name: "grep", input: { pattern: "[" } });

		expect(result.errorMessage).toContain("Invalid regular expression");
	});

	it("rejects likely binary files", async () => {
		const root = await fixtureRoot();
		await writeFile(path.join(root, "data.bin"), Buffer.from([0, 1, 2, 3]));
		const registry = createReadOnlyToolRegistry({ workspaceRoot: root });

		const result = await registry.execute(session, { id: "1", name: "read_file", input: { path: "data.bin" } });

		expect(result.status).toBe("error");
		expect(result.errorMessage).toBe("File appears to be binary");
	});
});

async function fixtureRoot(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "evolving-agent-tools-"));
}
