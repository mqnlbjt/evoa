import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../src/runtime/session.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";
import { createTuiAutomationToolBundle } from "../src/tools/tui-automation.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { fakeOpenAIClient, nextId } from "./helpers/cli.js";

const workspaceRoot = "/home/wyq/data/pi/evolving-agent";
const agentPath = path.join(workspaceRoot, "test/fixtures/tui-basic-no-memory.json");

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "local", model: "model" },
	prompts: { system: "system" },
	tools: { allowedTools: ["tui_start", "tui_send_input", "tui_snapshot", "tui_resize", "tui_wait", "tui_stop"], permissionMode: "allow", maxToolCalls: 20 },
	runtime: { maxTurns: 1 },
};

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Task",
	prompt: "Use TUI tools",
	scoring: { method: "rubric", config: { contains: [] } },
};

describe("TUI automation tools", () => {
	it("starts a TUI session and returns an initial snapshot", async () => {
		const registry = registryWithTuiTools(fakeOpenAIClient("hi"));
		const start = await execute(registry, "tui_start", { agentPath: "test/fixtures/tui-basic-no-memory.json", width: 80, height: 12 });

		expect(start.status).toBe("success");
		expect(start.output).toMatchObject({ status: "running", size: { width: 80, height: 12 } });
		expect(snapshotPlain(start.output)).toContain("evolving-agent | TUI Basic");
		await registry.close();
	});

	it("sends input and waits for fake model output", async () => {
		const registry = registryWithTuiTools(fakeOpenAIClient("Hello from fake model"));
		const sessionId = outputSessionId((await execute(registry, "tui_start", { agentPath })).output);

		await execute(registry, "tui_send_input", { sessionId, text: "hello", submit: true });
		const wait = await execute(registry, "tui_wait", { sessionId, text: "Hello from fake model", timeoutMs: 2_000 });

		expect(wait.status).toBe("success");
		expect(wait.output).toMatchObject({ matched: true, reason: "text" });
		expect(snapshotPlain(wait.output)).toContain("Hello from fake model");
		await registry.close();
	});

	it("returns optional ansi output, frames, and truncated snapshots", async () => {
		const registry = registryWithTuiTools(fakeOpenAIClient("hi"));
		const sessionId = outputSessionId((await execute(registry, "tui_start", { agentPath })).output);
		const result = await execute(registry, "tui_snapshot", { sessionId, includeAnsi: true, includeFrames: true, maxBytes: 1024 });

		expect(result.status).toBe("success");
		expect(result.output).toMatchObject({ sessionId, truncated: false });
		expect(snapshotPlain(result.output)).toContain("evolving-agent");
		expect((result.output as { ansi?: string }).ansi).toContain("--- clear ---");
		expect((result.output as { frames?: string[] }).frames?.length).toBeGreaterThan(0);
		await registry.close();
	});

	it("resizes sessions and waits for frame changes", async () => {
		const registry = registryWithTuiTools(fakeOpenAIClient("hi"));
		const sessionId = outputSessionId((await execute(registry, "tui_start", { agentPath, width: 80, height: 12 })).output);
		const waitPromise = execute(registry, "tui_wait", { sessionId, frameChanged: true, timeoutMs: 2_000, intervalMs: 20 });
		await execute(registry, "tui_resize", { sessionId, width: 40, height: 10 });
		const wait = await waitPromise;

		expect(wait.output).toMatchObject({ matched: true, reason: "frameChanged" });
		expect(snapshotFrom(wait.output).size).toEqual({ width: 40, height: 10 });
		const resize = await execute(registry, "tui_resize", { sessionId, width: 20, height: 5 });
		expect(snapshotFrom(resize.output).size).toEqual({ width: 20, height: 5 });
		expect(snapshotPlain(resize.output).split("\n").every((line) => line.length <= 20)).toBe(true);
		await registry.close();
	});

	it("stops sessions and reports invalid sessions clearly", async () => {
		const registry = registryWithTuiTools(fakeOpenAIClient("hi"));
		const sessionId = outputSessionId((await execute(registry, "tui_start", { agentPath })).output);
		const stop = await execute(registry, "tui_stop", { sessionId });
		const snapshot = await execute(registry, "tui_snapshot", { sessionId });

		expect(stop.status).toBe("success");
		expect(stop.output).toMatchObject({ status: "disposed" });
		expect(snapshot.status).toBe("error");
		expect(snapshot.errorMessage).toContain("TUI session not found");
		await registry.close();
	});

	it("denies workspace escapes and invalid sizes", async () => {
		const registry = registryWithTuiTools(fakeOpenAIClient("hi"));
		const escaped = await execute(registry, "tui_start", { agentPath: "../outside.json" });
		const invalidSize = await execute(registry, "tui_start", { agentPath, width: 5, height: 12 });

		expect(escaped.status).toBe("error");
		expect(escaped.errorMessage).toContain("agentPath must be inside workspace");
		expect(invalidSize.status).toBe("error");
		expect(invalidSize.errorMessage).toContain("width must be an integer");
		await registry.close();
	});

	it("rejects duplicate session ids and cleans up failed starts", async () => {
		const bundle = createTuiAutomationToolBundle({ workspaceRoot, maxSessions: 1, deps: { openAIClientFactory: () => fakeOpenAIClient("hi"), workspaceRoot, now: () => Date.now(), createId: nextId() } });
		const registry = new ToolRegistry(bundle.tools, { disposables: [bundle.close] });
		const first = await execute(registry, "tui_start", { sessionId: "same", agentPath });
		const duplicate = await execute(registry, "tui_start", { sessionId: "same", agentPath });
		const blocked = await execute(registry, "tui_start", { sessionId: "blocked", agentPath });

		expect(first.status).toBe("success");
		expect(duplicate.status).toBe("error");
		expect(duplicate.errorMessage).toContain("TUI session already exists");
		expect(blocked.status).toBe("error");
		expect(blocked.errorMessage).toContain("too many TUI automation sessions");
		await execute(registry, "tui_stop", { sessionId: "same" });
		const failed = await execute(registry, "tui_start", { sessionId: "bad", agentPath: "missing-agent.json" });
		const afterFailure = await execute(registry, "tui_start", { sessionId: "after", agentPath });

		expect(failed.status).toBe("error");
		expect(afterFailure.status).toBe("success");
		await registry.close();
	});

	it("registry close disposes live sessions", async () => {
		const bundle = createTuiAutomationToolBundle({ workspaceRoot, deps: { openAIClientFactory: () => fakeOpenAIClient("hi"), workspaceRoot, now: () => Date.now(), createId: nextId() } });
		const registry = new ToolRegistry(bundle.tools, { disposables: [bundle.close] });
		const sessionId = outputSessionId((await execute(registry, "tui_start", { agentPath })).output);

		await registry.close();
		const snapshot = await execute(registry, "tui_snapshot", { sessionId });
		expect(snapshot.status).toBe("error");
		expect(snapshot.errorMessage).toContain("TUI session not found");
	});
});

function registryWithTuiTools(client: ReturnType<typeof fakeOpenAIClient>): ToolRegistry {
	const bundle = createTuiAutomationToolBundle({ workspaceRoot, deps: { openAIClientFactory: () => client, workspaceRoot, now: () => Date.now(), createId: nextId() } });
	return new ToolRegistry(bundle.tools, { disposables: [bundle.close] });
}

async function execute(registry: ToolRegistry, name: string, input: unknown) {
	return registry.execute(createAgentSession({ id: "session", agent, task }), { id: name, name, input });
}

function outputSessionId(output: unknown): string {
	const value = output as { sessionId?: string };
	if (!value.sessionId) throw new Error("missing sessionId");
	return value.sessionId;
}

function snapshotPlain(output: unknown): string {
	return snapshotFrom(output).plain;
}

function snapshotFrom(output: unknown): { plain: string; size: { width: number; height: number } } {
	const value = output as { plain?: string; snapshot?: { plain: string; size: { width: number; height: number } } };
	return value.snapshot ?? { plain: value.plain ?? "", size: { width: 0, height: 0 } };
}
