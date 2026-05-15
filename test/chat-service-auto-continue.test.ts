import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAutoContinueFollowUpProvider } from "../src/cli/auto-continue.js";
import { createChatServiceContext, runChatTurn } from "../src/cli/chat-service.js";
import type { ChatCommand } from "../src/cli/args.js";
import type { ModelResponse } from "../src/models/types.js";
import { createAgentSession, type AgentSession } from "../src/runtime/session.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const providerArgs = {
	provider: "local",
	model: "gpt-5.5",
	baseURL: "http://localhost:8317/v1",
	providerFormat: "openai-responses" as const,
	toolProfile: "dangerous" as const,
};

function testAgent(overrides: Partial<AgentSpec["runtime"]> = {}): AgentSpec {
	return {
		id: "test-agent",
		version: "1.0.0",
		name: "Test Agent",
		kind: "baseline",
		model: { provider: "local", model: "gpt-5.5" },
		prompts: { system: "" },
		tools: { allowedTools: [], permissionMode: "allow" },
		runtime: { maxTurns: 8, memoryPolicy: "none", ...overrides },
	};
}

function testSession(overrides: Partial<AgentSpec["runtime"]> = {}, messages: { role: "user" | "assistant"; content: string }[] = []): AgentSession {
	const agent = testAgent(overrides);
	return createAgentSession({
		id: "s1",
		agent,
		task: { id: "t1", type: "general", title: "Test", prompt: "test", scoring: { method: "rubric", config: { contains: [] } } },
		entries: messages.map((m, i) => ({
			id: `e${i}`,
			kind: m.role === "user" ? "user" as const : "assistant" as const,
			createdAt: 1,
			message: { role: m.role, content: m.content, contentBlocks: [{ type: "text" as const, text: m.content }] },
		})),
		messages: messages.map((m) => ({ role: m.role, content: m.content, contentBlocks: [{ type: "text" as const, text: m.content }] })),
	});
}

function response(text: string, metadata?: ModelResponse["metadata"]): ModelResponse {
	return { text, ...(metadata ? { metadata } : {}) };
}

const provider = createAutoContinueFollowUpProvider();

describe("auto-continue provider unit tests", () => {
	it("triggers on truncated response (finish_reason=length)", async () => {
		const session = testSession();
		const result = await provider(session, response("some text", { finishReason: "length" }));
		expect(result).toHaveLength(1);
	});

	it("triggers on truncated response (stop_reason=max_tokens)", async () => {
		const session = testSession();
		const result = await provider(session, response("some text", { stopReason: "max_tokens" }));
		expect(result).toHaveLength(1);
	});

	it("triggers on empty output (no text, no tool calls)", async () => {
		const session = testSession();
		const result = await provider(session, response(""));
		expect(result).toHaveLength(1);
	});

	it("triggers on structured continue signal in metadata", async () => {
		const session = testSession();
		const result = await provider(session, response("checking...", { autoContinue: true }));
		expect(result).toHaveLength(1);
	});

	it("triggers on hard constraint autoContinue=true", async () => {
		const session = testSession({ autoContinue: true });
		const result = await provider(session, response("normal text"));
		expect(result).toHaveLength(1);
	});

	it("does not continue on normal text response", async () => {
		const session = testSession();
		const result = await provider(session, response("任务已完成。"));
		expect(result).toHaveLength(0);
	});

	it("respects maxFollowUps limit", async () => {
		const session = testSession(
			{ autoContinue: { maxFollowUps: 1 } },
			[{ role: "user", content: "Continue the task if it is not complete." }],
		);
		// Already 1 follow-up sent, maxFollowUps=1 → no more
		const result = await provider(session, response("normal text"));
		expect(result).toHaveLength(0);
	});

	it("autoContinue=false disables all triggers", async () => {
		const session = testSession({ autoContinue: false });
		const result = await provider(session, response("", { finishReason: "length" }));
		expect(result).toHaveLength(0);
	});

	it("does not count non-follow-up user messages against maxFollowUps", async () => {
		const session = testSession(
			{ autoContinue: true },
			[
				{ role: "user", content: "original question" },
				{ role: "assistant", content: "ok" },
			],
		);
		const result = await provider(session, response("still going"));
		expect(result).toHaveLength(1);
	});
});

describe("chat service auto-continue integration", () => {
	it("does not auto-continue on normal text after tool use", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-auto-continue-"));
		const agentPath = path.join(root, "agent.json");
		await writeAgent(agentPath, ["echo"]);
		let calls = 0;
		const context = await createChatServiceContext(command(agentPath, root), {
			toolRegistry: echoRegistry(),
			openAIClientFactory: () => ({
				responses: {
					async create() {
						calls += 1;
						return calls === 1
							? { output_text: "", output: [{ type: "function_call", call_id: "call_1", name: "echo", arguments: JSON.stringify("ok") }] }
							: { output_text: "任务已完成。" };
					},
				},
			}),
			createId: nextId(),
			now: () => 1,
		});

		try {
			const output = await runChatTurn(context, "检查状态");
			expect(output.answer).toBe("任务已完成。");
			expect(calls).toBe(2);
			expect(output.trace.map((e) => e.type)).not.toContain("follow_up");
		} finally {
			await context.runtime.close();
		}
	});

	it("auto-continues on empty output in full chat flow", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-auto-continue-"));
		const agentPath = path.join(root, "agent.json");
		await writeAgent(agentPath, []);
		let calls = 0;
		const context = await createChatServiceContext(command(agentPath, root), {
			toolRegistry: new ToolRegistry([]),
			openAIClientFactory: () => ({
				responses: {
					async create() {
						calls += 1;
						return calls === 1 ? { output_text: "" } : { output_text: "任务已完成。" };
					},
				},
			}),
			createId: nextId(),
			now: () => 1,
		});

		try {
			const output = await runChatTurn(context, "检查状态");
			expect(output.answer).toBe("任务已完成。");
			expect(calls).toBe(2);
			expect(output.trace.map((e) => e.type)).toContain("follow_up");
		} finally {
			await context.runtime.close();
		}
	});

	it("does not auto-continue on normal text in full chat flow", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-auto-continue-"));
		const agentPath = path.join(root, "agent.json");
		await writeAgent(agentPath, []);
		const context = await createChatServiceContext(command(agentPath, root), {
			toolRegistry: new ToolRegistry([]),
			openAIClientFactory: () => ({
				responses: { async create() { return { output_text: "任务已完成。" }; } },
			}),
			createId: nextId(),
			now: () => 1,
		});

		try {
			const output = await runChatTurn(context, "检查状态");
			expect(output.answer).toBe("任务已完成。");
			expect(output.trace.map((e) => e.type)).not.toContain("follow_up");
		} finally {
			await context.runtime.close();
		}
	});
});

function command(agentPath: string, sessionDir: string): ChatCommand {
	return {
		kind: "chat",
		format: "json",
		agentPath,
		...providerArgs,
		sessionDir,
		providedFlags: { agentPath: true, provider: true, model: true, baseURL: true, providerFormat: true, toolProfile: true, sessionDir: true },
	};
}

async function writeAgent(filePath: string, allowedTools: string[], runtimeOverrides?: Record<string, unknown>): Promise<void> {
	await writeFile(filePath, JSON.stringify({
		id: "auto-continue-agent",
		version: "1.0.0",
		name: "Auto Continue Agent",
		kind: "baseline",
		model: { provider: "local", model: "gpt-5.5" },
		prompts: { system: "Use tools when needed." },
		tools: { allowedTools, permissionMode: "allow", maxToolCalls: 2 },
		runtime: { maxTurns: 8, memoryPolicy: "none", ...runtimeOverrides },
	}));
}

function echoRegistry(): ToolRegistry {
	return new ToolRegistry([{ name: "echo", description: "Echo input", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", async execute(input) { return input; } }]);
}

function nextId(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}
