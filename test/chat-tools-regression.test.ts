import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { createIO, fakeToolOpenAIClient, nextId } from "./helpers/cli.js";

const modelArgs = ["--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1"];

describe("chat tool regression", () => {
	it("records read-only tool success in chat trace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-tools-"));
		const agentFile = path.join(root, "agent.json");
		const traceFile = path.join(root, "trace.json");
		await writeFile(path.join(root, "note.txt"), "tool content");
		await writeAgent(agentFile, ["read_file"]);
		const io = createIO();
		const code = await main(["chat", "read note", "--agent", agentFile, ...modelArgs, "--trace", traceFile, "--json"], {
			...io,
			openAIClientFactory: () => fakeToolOpenAIClient("read_file", { path: "note.txt" }, "saw tool"),
			workspaceRoot: root,
			now: () => 1,
			createId: nextId(),
		});

		expect(code).toBe(0);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, answer: "saw tool" });
		const trace = await readTrace(traceFile);
		expect(trace.trace).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "tool_call", payload: expect.objectContaining({ call: expect.objectContaining({ name: "read_file" }) }) }),
			expect.objectContaining({ type: "tool_result", payload: expect.objectContaining({ status: "success", call: expect.objectContaining({ name: "read_file" }) }) }),
		]));
	});

	it("records denied registered tools in chat trace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-tools-"));
		const agentFile = path.join(root, "agent.json");
		const traceFile = path.join(root, "trace.json");
		await writeAgent(agentFile, ["read_file"], ["write_file"]);
		const io = createIO();
		const code = await main(["chat", "write note", "--agent", agentFile, ...modelArgs, "--tool-profile", "coding", "--trace", traceFile, "--json"], {
			...io,
			openAIClientFactory: () => fakeToolOpenAIClient("write_file", { path: "note.txt", content: "new" }, "done"),
			workspaceRoot: root,
			now: () => 1,
			createId: nextId(),
		});

		expect(code).toBe(0);
		const trace = await readTrace(traceFile);
		expect(trace.trace).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "tool_result", payload: expect.objectContaining({ status: "denied", call: expect.objectContaining({ name: "write_file" }) }) }),
		]));
		const retryRequest = trace.trace.find((event) => isTraceEvent(event, "model_request") && event.payload.messages.some((message) => message.role === "tool"));
		expect(retryRequest).toMatchObject({ payload: { messages: expect.arrayContaining([
			expect.objectContaining({ role: "tool", contentBlocks: expect.arrayContaining([expect.objectContaining({ type: "tool_result", isError: true })]) }),
		]) } });
	});

	it("records unknown unavailable tools in chat trace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-chat-tools-"));
		const agentFile = path.join(root, "agent.json");
		const traceFile = path.join(root, "trace.json");
		await writeAgent(agentFile, ["write_file"]);
		const io = createIO();
		const code = await main(["chat", "write note", "--agent", agentFile, ...modelArgs, "--trace", traceFile, "--json"], {
			...io,
			openAIClientFactory: () => fakeToolOpenAIClient("write_file", { path: "note.txt", content: "new" }, "done"),
			workspaceRoot: root,
			now: () => 1,
			createId: nextId(),
		});

		expect(code).toBe(0);
		const trace = await readTrace(traceFile);
		expect(trace.trace).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "tool_result", payload: expect.objectContaining({ status: "unknown", errorMessage: "Unknown tool: write_file" }) }),
		]));
	});
});

async function writeAgent(filePath: string, allowedTools: string[], deniedTools?: string[]): Promise<void> {
	await writeFile(filePath, JSON.stringify({
		id: "chat-tool-agent",
		version: "1.0.0",
		name: "Chat Tool Agent",
		kind: "baseline",
		model: { provider: "local", model: "gpt-5.4-mini" },
		prompts: { system: "Use tools." },
		tools: { allowedTools, ...(deniedTools ? { deniedTools } : {}), permissionMode: "allow", maxToolCalls: 2 },
		runtime: { maxTurns: 3 },
	}));
}

interface TestTraceEvent {
	type: string;
	payload: { messages: Array<{ role?: string; contentBlocks?: unknown[] }> };
}

async function readTrace(filePath: string): Promise<{ trace: unknown[] }> {
	return JSON.parse(await readFile(filePath, "utf8")) as { trace: unknown[] };
}

function isTraceEvent(event: unknown, type: string): event is TestTraceEvent {
	return typeof event === "object" && event !== null && "type" in event && event.type === type && "payload" in event && typeof event.payload === "object" && event.payload !== null && "messages" in event.payload && Array.isArray(event.payload.messages);
}
