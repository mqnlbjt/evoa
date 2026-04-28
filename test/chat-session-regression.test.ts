import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { createIO, fakeOpenAIClient, fakeToolOpenAIClient, lines, nextId } from "./helpers/cli.js";

const agentPath = "/home/wyq/data/pi/evolving-agent/examples/agents/basic.json";
const providerArgs = ["--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1"];
const modelArgs = ["--agent", agentPath, ...providerArgs];

describe("chat session regression", () => {
	it("runs a one-shot chat prompt", async () => {
		const io = createIO();
		const code = await main(["chat", "hello", ...modelArgs, "--json"], { ...io, openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, command: "chat", answer: "hi" });
	});

	it("keeps REPL messages across turns", async () => {
		const io = createIO();
		let calls = 0;
		let secondRequest: unknown;
		const code = await main(["chat", ...modelArgs], {
			...io,
			inputLines: lines(["remember", "recall", "/exit"]),
			openAIClientFactory: () => ({ responses: { async create(input) { calls += 1; if (calls === 2) secondRequest = input; return { output_text: calls === 1 ? "stored" : "recalled" }; } } }),
			now: () => 1,
			createId: nextId(),
		});

		expect(code).toBe(0);
		expect(calls).toBe(2);
		expect(secondRequest).toMatchObject({ input: expect.arrayContaining([
			expect.objectContaining({ role: "user", content: "remember" }),
			expect.objectContaining({ role: "assistant", content: "stored" }),
			expect.objectContaining({ role: "user", content: "recall" }),
		]) });
	});

	it("saves and resumes chat session history", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-session-"));
		const first = createIO();
		await main(["chat", "remember", ...modelArgs, "--session", "demo", "--session-dir", root, "--json"], { ...first, openAIClientFactory: () => fakeOpenAIClient("stored"), now: () => 1, createId: nextId() });
		expect(await readSession(root, "demo")).toMatchObject({ startupContext: { agentPath, provider: "local", model: "gpt-5.4-mini", baseURL: "http://localhost:8317/v1", toolProfile: "dangerous" } });

		let resumedRequest: unknown;
		const second = createIO();
		const code = await main(["chat", "recall", "--resume", "demo", "--session-dir", root, "--json"], {
			...second,
			openAIClientFactory: () => ({ responses: { async create(input) { resumedRequest = input; return { output_text: "recalled" }; } } }),
			now: () => 2,
			createId: nextId(),
		});

		expect(code).toBe(0);
		expect(JSON.parse(second.stdoutText())).toMatchObject({ ok: true, sessionId: "demo", answer: "recalled" });
		expect(resumedRequest).toMatchObject({ input: expect.arrayContaining([
			expect.objectContaining({ role: "user", content: "remember" }),
			expect.objectContaining({ role: "assistant", content: "stored" }),
			expect.objectContaining({ role: "user", content: "recall" }),
		]) });
	});

	it("lets explicit resume options update startup context", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-session-"));
		const first = createIO();
		await main(["chat", "remember", ...modelArgs, "--session", "demo", "--session-dir", root, "--json"], { ...first, openAIClientFactory: () => fakeOpenAIClient("stored"), now: () => 1, createId: nextId() });

		let model: unknown;
		const second = createIO();
		const code = await main(["chat", "recall", "--resume", "demo", "--session-dir", root, "--model", "new-model", "--json"], {
			...second,
			openAIClientFactory: () => ({ responses: { async create(input) { model = input.model; return { output_text: "recalled" }; } } }),
			now: () => 2,
			createId: nextId(),
		});

		expect(code).toBe(0);
		expect(model).toBe("new-model");
		expect(await readSession(root, "demo")).toMatchObject({ startupContext: { model: "new-model" } });
	});

	it("inherits the stored tool profile when resuming a chat session", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-session-"));
		const agentFile = path.join(root, "agent.json");
		const traceFile = path.join(root, "trace.json");
		await writeAgent(agentFile, ["write_file"]);
		const first = createIO();
		await main(["chat", "remember", "--agent", agentFile, ...providerArgs, "--session", "demo", "--session-dir", root, "--tool-profile", "read-only", "--json"], {
			...first,
			openAIClientFactory: () => fakeOpenAIClient("stored"),
			workspaceRoot: root,
			now: () => 1,
			createId: nextId(),
		});

		const second = createIO();
		const code = await main(["chat", "write", "--resume", "demo", "--session-dir", root, "--trace", traceFile, "--json"], {
			...second,
			openAIClientFactory: () => fakeToolOpenAIClient("write_file", { path: "note.txt", content: "new" }, "recovered"),
			workspaceRoot: root,
			now: () => 2,
			createId: nextId(),
		});

		expect(code).toBe(0);
		expect(await readSession(root, "demo")).toMatchObject({ startupContext: { toolProfile: "read-only" } });
		expect((await readTrace(traceFile)).trace).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "tool_result", payload: expect.objectContaining({ status: "unknown", errorMessage: "Unknown tool: write_file" }) }),
		]));
		await expectMissing(path.join(root, "note.txt"));
	});

	it("lets an explicit resume tool profile override the stored profile", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-session-"));
		const agentFile = path.join(root, "agent.json");
		const traceFile = path.join(root, "trace.json");
		await writeAgent(agentFile, ["write_file"]);
		const first = createIO();
		await main(["chat", "remember", "--agent", agentFile, ...providerArgs, "--session", "demo", "--session-dir", root, "--tool-profile", "read-only", "--json"], {
			...first,
			openAIClientFactory: () => fakeOpenAIClient("stored"),
			workspaceRoot: root,
			now: () => 1,
			createId: nextId(),
		});

		const second = createIO();
		const code = await main(["chat", "write", "--resume", "demo", "--session-dir", root, "--tool-profile", "coding", "--trace", traceFile, "--json"], {
			...second,
			openAIClientFactory: () => fakeToolOpenAIClient("write_file", { path: "note.txt", content: "new" }, "wrote"),
			workspaceRoot: root,
			now: () => 2,
			createId: nextId(),
		});

		expect(code).toBe(0);
		expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("new");
		expect(await readSession(root, "demo")).toMatchObject({ startupContext: { toolProfile: "coding" } });
		expect((await readTrace(traceFile)).trace).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "tool_result", payload: expect.objectContaining({ status: "success", call: expect.objectContaining({ name: "write_file" }) }) }),
		]));
	});

	it("persists tool messages and restores them into resumed model requests", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-session-"));
		const agentFile = path.join(root, "agent.json");
		await writeFile(path.join(root, "note.txt"), "persisted tool content");
		await writeAgent(agentFile, ["read_file"]);
		const first = createIO();
		await main(["chat", "read", "--agent", agentFile, ...providerArgs, "--session", "demo", "--session-dir", root, "--tool-profile", "read-only", "--json"], {
			...first,
			openAIClientFactory: () => fakeToolOpenAIClient("read_file", { path: "note.txt" }, "stored tool result"),
			workspaceRoot: root,
			now: () => 1,
			createId: nextId(),
		});

		const stored = await readSession(root, "demo") as { messages: Array<{ role?: string; contentBlocks?: Array<Record<string, unknown>> }> };
		expect(stored.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "assistant", contentBlocks: expect.arrayContaining([expect.objectContaining({ type: "tool_call", name: "read_file" })]) }),
			expect.objectContaining({ role: "tool", contentBlocks: expect.arrayContaining([expect.objectContaining({ type: "tool_result", toolName: "read_file" })]) }),
		]));

		let resumedInput: unknown;
		const second = createIO();
		const code = await main(["chat", "recall", "--resume", "demo", "--session-dir", root, "--json"], {
			...second,
			openAIClientFactory: () => ({ responses: { async create(input) { resumedInput = input.input; return { output_text: "recalled" }; } } }),
			workspaceRoot: root,
			now: () => 2,
			createId: nextId(),
		});

		expect(code).toBe(0);
		expect(resumedInput).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "function_call", call_id: "call_1", name: "read_file" }),
			expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
		]));
	});

	it("reports old sessions without startup context when resume args are incomplete", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-session-"));
		await writeSession(root, "legacy", { id: "legacy", agentId: "agent", messages: [], createdAt: 1, updatedAt: 1 });
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, "{}");
		const io = createIO();
		const code = await main(["chat", "recall", "--resume", "legacy", "--session-dir", root, "--config", configPath, "--json"], { ...io, openAIClientFactory: () => fakeOpenAIClient("recalled") });

		expect(code).toBe(1);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: false, error: { code: "RUN_ERROR", message: "session legacy does not include startup context; provide --agent --provider --model --base-url once to upgrade it" } });
	});

	it("upgrades old sessions when complete resume args are provided", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-session-"));
		await writeSession(root, "legacy", { id: "legacy", agentId: "agent", messages: [], createdAt: 1, updatedAt: 1 });
		const io = createIO();
		const code = await main(["chat", "recall", ...modelArgs, "--resume", "legacy", "--session-dir", root, "--json"], { ...io, openAIClientFactory: () => fakeOpenAIClient("recalled"), now: () => 2, createId: nextId() });

		expect(code).toBe(0);
		expect(await readSession(root, "legacy")).toMatchObject({ startupContext: { agentPath, model: "gpt-5.4-mini" } });
	});

	it("rejects conflicting session options", async () => {
		const io = createIO();
		const code = await main(["chat", "hello", ...modelArgs, "--session", "demo", "--resume", "demo", "--json"], io);

		expect(code).toBe(2);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: false, error: { code: "USAGE_ERROR" } });
	});

	it("fails when resuming a missing session", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-session-"));
		const io = createIO();
		const code = await main(["chat", "hello", ...modelArgs, "--resume", "missing", "--session-dir", root, "--json"], { ...io, openAIClientFactory: () => fakeOpenAIClient("hi") });

		expect(code).toBe(1);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: false, error: { code: "RUN_ERROR", message: "session missing not found" } });
	});
});

async function readSession(root: string, id: string): Promise<unknown> {
	return JSON.parse(await readFile(path.join(root, `${id}.json`), "utf8"));
}

async function writeSession(root: string, id: string, value: unknown): Promise<void> {
	await writeFile(path.join(root, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeAgent(filePath: string, allowedTools: string[]): Promise<void> {
	await writeFile(filePath, JSON.stringify({
		id: "chat-session-tool-agent",
		version: "1.0.0",
		name: "Chat Session Tool Agent",
		kind: "baseline",
		model: { provider: "local", model: "gpt-5.4-mini" },
		prompts: { system: "Use tools." },
		tools: { allowedTools, permissionMode: "allow", maxToolCalls: 2 },
		runtime: { maxTurns: 3 },
	}));
}

async function readTrace(filePath: string): Promise<{ trace: unknown[] }> {
	return JSON.parse(await readFile(filePath, "utf8")) as { trace: unknown[] };
}

async function expectMissing(filePath: string): Promise<void> {
	await expect(access(filePath)).rejects.toThrow();
}
