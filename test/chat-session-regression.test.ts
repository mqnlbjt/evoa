import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { createIO, fakeOpenAIClient, fakeToolOpenAIClient, lines, nextId } from "./helpers/cli.js";

const agentPath = "/home/wyq/data/pi/evolving-agent/examples/agents/basic.json";
const providerArgs = ["--provider", "local", "--model", "gpt-5.5", "--base-url", "http://localhost:8317/v1"];
const modelArgs = ["--agent", agentPath, ...providerArgs];

describe("chat session regression", { timeout: 10_000 }, () => {
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
			openAIClientFactory: () => ({ responses: { async create(input) { if (isMemoryExtractionRequest(input)) return invalidMemoryExtraction(); calls += 1; if (calls === 2) secondRequest = input; return { output_text: calls === 1 ? "stored" : "recalled" }; } } }),
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
		expect(await readSession(root, "demo")).toMatchObject({ startupContext: { agentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", toolProfile: "dangerous" } });

		let resumedRequest: unknown;
		const second = createIO();
		const code = await main(["chat", "recall", "--resume", "demo", "--session-dir", root, "--json"], {
			...second,
			openAIClientFactory: () => ({ responses: { async create(input) { if (isMemoryExtractionRequest(input)) return invalidMemoryExtraction(); resumedRequest = input; return { output_text: "recalled" }; } } }),
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
			openAIClientFactory: () => ({ responses: { async create(input) { if (isMemoryExtractionRequest(input)) return invalidMemoryExtraction(); model = input.model; return { output_text: "recalled" }; } } }),
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
			openAIClientFactory: () => ({ responses: { async create(input) { if (isMemoryExtractionRequest(input)) return invalidMemoryExtraction(); resumedInput = input.input; return { output_text: "recalled" }; } } }),
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

	it("uses current agent memory policy when resuming old sessions", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-session-"));
		const agentFile = path.join(root, "agent.json");
		await writeAgent(agentFile, [], "long-term");
		await writeSession(root, "old", {
			id: "old",
			agentId: "chat-session-tool-agent",
			messages: [{ role: "system", content: "old prompt" }, { role: "user", content: "hello" }, { role: "assistant", content: "Hello." }],
			startupContext: { agentPath: agentFile, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous" },
			createdAt: 1,
			updatedAt: 1,
		});
		const first = createIO();
		await main(["chat", "请记住 我是wyq 我是黄金山爸爸", "--agent", agentFile, ...providerArgs, "--session", "source", "--session-dir", root, "--json"], {
			...first,
			openAIClientFactory: () => fakeChatAndMemoryClient("记住了。", { memories: [{ layer: "knowledge", content: "用户是wyq。黄金山是用户的孩子。", topic: "user", scope: "user", stable: true, key: "user.identity.name", suitability: "long_term", safety: "safe", sourceMessageIndexes: [1] }] }),
			now: () => 2,
			createId: nextId(),
		});

		let resumedInput: unknown;
		const second = createIO();
		await main(["chat", "黄金山是谁", "--resume", "old", "--session-dir", root, "--json"], {
			...second,
			openAIClientFactory: () => ({ responses: { async create(input) { if (isMemoryExtractionRequest(input)) return invalidMemoryExtraction(); resumedInput = input.input; return { output_text: "黄金山是你的孩子。" }; } } }),
			now: () => 3,
			createId: nextId(),
		});

		expect(resumedInput).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "user", content: expect.stringContaining("黄金山是用户的孩子") }),
		]));
		expect((resumedInput as Array<{ role?: string; content?: string }>).slice(-2)).toEqual([
			expect.objectContaining({ role: "user", content: expect.stringContaining("Long-term memory stable bootstrap context") }),
			expect.objectContaining({ role: "user", content: "黄金山是谁" }),
		]);
		expect(await readSession(root, "old")).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ content: "Use tools." })]) });
	});

	it("shares long-term memory across chat sessions without persisting injected context", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-session-"));
		const agentFile = path.join(root, "agent.json");
		await writeAgent(agentFile, [], "long-term");
		const first = createIO();
		await main(["chat", "记住我是 wyq，以后默认中文回答", "--agent", agentFile, ...providerArgs, "--session", "a", "--session-dir", root, "--json"], {
			...first,
			openAIClientFactory: () => fakeChatAndMemoryClient("stored", { memories: [{ layer: "knowledge", content: "记住我是 wyq，以后默认中文回答", topic: "user", scope: "user", stable: true, key: "user.identity.name", suitability: "long_term", safety: "safe", sourceMessageIndexes: [1] }] }),
			now: () => 1,
			createId: nextId(),
		});

		let secondInput: unknown;
		const second = createIO();
		const code = await main(["chat", "我是谁", "--agent", agentFile, ...providerArgs, "--session", "b", "--session-dir", root, "--json"], {
			...second,
			openAIClientFactory: () => ({ responses: { async create(input) { if (isMemoryExtractionRequest(input)) return invalidMemoryExtraction(); secondInput = input.input; return { output_text: "recalled" }; } } }),
			now: () => 2,
			createId: nextId(),
		});

		expect(code).toBe(0);
		expect(secondInput).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "user", content: expect.stringContaining("Long-term memory stable bootstrap context") }),
			expect.objectContaining({ role: "user", content: "我是谁" }),
		]));
		expect(JSON.stringify(await readSession(root, "b"))).not.toContain("Long-term memory stable bootstrap context");
	});

	it("injects only the winning memory when preferences conflict", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-session-"));
		const agentFile = path.join(root, "agent.json");
		await writeAgent(agentFile, [], "long-term", "conflict-agent");
		await main(["chat", "以后默认中文回答", "--agent", agentFile, ...providerArgs, "--session", "a", "--session-dir", root, "--json"], {
			...createIO(),
			openAIClientFactory: () => fakeChatAndMemoryClient("stored", { memories: [{ layer: "knowledge", content: "默认中文回答", topic: "user", scope: "user", stable: true, key: "user.preference.language", suitability: "long_term", safety: "safe", sourceMessageIndexes: [1] }] }),
			now: () => 1,
			createId: nextId(),
		});
		await main(["chat", "以后默认英文回答", "--agent", agentFile, ...providerArgs, "--session", "b", "--session-dir", root, "--json"], {
			...createIO(),
			openAIClientFactory: () => fakeChatAndMemoryClient("stored", { memories: [{ layer: "knowledge", content: "默认英文回答", topic: "user", scope: "user", stable: true, key: "user.preference.language", suitability: "long_term", safety: "safe", sourceMessageIndexes: [1] }] }),
			now: () => 2,
			createId: nextId(),
		});

		let input: unknown;
		const code = await main(["chat", "默认用什么语言", "--agent", agentFile, ...providerArgs, "--session", "c", "--session-dir", root, "--json"], {
			...createIO(),
			openAIClientFactory: () => ({ responses: { async create(request) { if (isMemoryExtractionRequest(request)) return invalidMemoryExtraction(); input = request.input; return { output_text: "English" }; } } }),
			now: () => 3,
			createId: nextId(),
		});

		expect(code).toBe(0);
		expect(JSON.stringify(input)).toContain("默认英文回答");
		expect(JSON.stringify(input)).not.toContain("默认中文回答");
	}, 10_000);

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
		expect(await readSession(root, "legacy")).toMatchObject({ startupContext: { agentPath, model: "gpt-5.5" } });
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

function isMemoryExtractionRequest(input: { instructions?: unknown; input?: unknown }): boolean {
	return input.instructions === "Extract structured long-term memory candidates as strict JSON.";
}

function invalidMemoryExtraction(): { output_text: string } {
	return { output_text: "not json" };
}

function fakeChatAndMemoryClient(answer: string, memory: unknown) {
	return {
		responses: {
			async create(input: { instructions?: unknown }) {
				return isMemoryExtractionRequest(input) ? { output_text: JSON.stringify(memory) } : { output_text: answer };
			},
		},
	};
}

async function readSession(root: string, id: string): Promise<unknown> {
	return JSON.parse(await readFile(path.join(root, `${id}.json`), "utf8"));
}

async function writeSession(root: string, id: string, value: unknown): Promise<void> {
	await writeFile(path.join(root, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeAgent(filePath: string, allowedTools: string[], memoryPolicy: "none" | "session" | "long-term" = "none", id = "chat-session-tool-agent"): Promise<void> {
	await writeFile(filePath, JSON.stringify({
		id,
		version: "1.0.0",
		name: "Chat Session Tool Agent",
		kind: "baseline",
		model: { provider: "local", model: "gpt-5.5" },
		prompts: { system: "Use tools." },
		tools: { allowedTools, permissionMode: "allow", maxToolCalls: 2 },
		runtime: { maxTurns: 3, memoryPolicy },
	}));
}

async function readTrace(filePath: string): Promise<{ trace: unknown[] }> {
	return JSON.parse(await readFile(filePath, "utf8")) as { trace: unknown[] };
}

async function expectMissing(filePath: string): Promise<void> {
	await expect(access(filePath)).rejects.toThrow();
}
