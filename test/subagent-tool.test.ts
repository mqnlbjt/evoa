import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { appendUserMessage, createAgentSession } from "../src/runtime/session.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ModelClient, ModelRequest } from "../src/models/types.js";
import type { AgentSpec, SubagentSpec, TaskSpec } from "../src/specs.js";
import type { SubagentToolOutput } from "../src/tools/subagent.js";

const mainAgent: AgentSpec = {
	id: "main",
	version: "1.0.0",
	name: "Main",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "main" },
	tools: { allowedTools: ["subagent"], permissionMode: "allow", maxToolCalls: 1 },
	runtime: { maxTurns: 3 },
};

const workerAgent: AgentSpec = {
	id: "worker-agent",
	version: "1.0.0",
	name: "Worker",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "worker" },
	tools: { allowedTools: ["echo"], permissionMode: "allow", maxToolCalls: 1 },
	runtime: { maxTurns: 3 },
};

const subagent: SubagentSpec = { id: "worker", role: "tool-specialist", agent: workerAgent };

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Main task",
	prompt: "delegate",
	scoring: { method: "custom" },
};

describe("subagent tool", () => {
	it("runs a bundle-defined subagent with independent tools and trace linkage", async () => {
		const requests: ModelRequest[] = [];
		const modelClient: ModelClient = {
			async complete(request) {
				requests.push(request);
				if (request.agent.id === "main" && request.turn === 1) {
					return { toolCalls: [{ id: "main-call", name: "subagent", input: { subagentId: "worker", task: "use echo" } }] };
				}
				if (request.agent.id === "worker-agent" && request.turn === 1) {
					return { toolCalls: [{ id: "worker-call", name: "echo", input: "sub-answer" }] };
				}
				if (request.agent.id === "worker-agent") return { text: "sub-answer" };
				return { text: "done" };
			},
		};

		const runtime = new AgentRuntime({
			modelClient,
			toolRegistry: new ToolRegistry(),
			createToolRegistryForAgent: () => new ToolRegistry([{ name: "echo", description: "Echo", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", async execute(input) { return input; } }]),
			subagents: [subagent],
			createId: createIds(),
			now: () => 1,
		});

		const output = await runtime.runTask(mainAgent, task);
		const subagentResult = output.trace?.find((event) => event.type === "tool_result" && (event.payload as { call?: { name?: string } })?.call?.name === "subagent")?.payload as { visibleContentPreview?: string; output?: unknown } | undefined;
		const preview = subagentResult?.visibleContentPreview ?? "";
		const structuredOutput = subagentResult?.output as { subagentId?: string; agentId?: string; answer?: string; status?: string; parentSessionId?: string; parentToolCallId?: string } | undefined;

		expect(output.answer).toBe("done");
		expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["subagent"]);
		expect(requests.find((request) => request.agent.id === "worker-agent")?.tools?.map((tool) => tool.name)).toEqual(["echo"]);
		expect(preview).toContain('"subagentId":"worker"');
		expect(preview).toContain('"agentId":"worker-agent"');
		expect(preview).toContain('"status":"completed"');
		expect(preview).toContain('"answer":"sub-answer"');
		expect(preview).toContain('"parentSessionId":"id-1"');
		expect(preview).toContain('"parentToolCallId":"main-call"');
		expect(structuredOutput).toMatchObject({ subagentId: "worker", agentId: "worker-agent", answer: "sub-answer", status: "completed" });
		expect(structuredOutput?.parentSessionId).toBe("id-1");
		expect(structuredOutput?.parentToolCallId).toBe("main-call");
		expect(preview).not.toContain('"trace":');
	});

	it("returns a tool error for unknown subagents", async () => {
		const modelClient: ModelClient = {
			async complete(request) {
				if (request.turn === 1) return { toolCalls: [{ id: "main-call", name: "subagent", input: { subagentId: "missing", task: "work" } }] };
				return { text: "done" };
			},
		};
		const runtime = new AgentRuntime({ modelClient, toolRegistry: new ToolRegistry(), subagents: [subagent], createToolRegistryForAgent: () => new ToolRegistry(), createId: createIds(), now: () => 1 });

		const output = await runtime.runTask(mainAgent, task);
		const result = output.trace?.find((event) => event.type === "tool_result")?.payload as { status?: string; errorMessage?: string } | undefined;

		expect(result).toMatchObject({ status: "error", errorMessage: "Unknown subagent: missing" });
	});

	it("propagates parent abort from subagent execution", async () => {
		const controller = new AbortController();
		const modelClient: ModelClient = {
			async complete(request, signal) {
				if (request.agent.id === "main") return { toolCalls: [{ id: "main-call", name: "subagent", input: { subagentId: "worker", task: "work" } }] };
				controller.abort(new Error("User interrupted"));
				throw signal?.reason;
			},
		};
		const runtime = new AgentRuntime({
			modelClient,
			toolRegistry: new ToolRegistry(),
			createToolRegistryForAgent: () => new ToolRegistry([{ name: "echo", description: "Echo", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", async execute(input) { return input; } }]),
			subagents: [subagent],
			createId: createIds(),
			now: () => 1,
		});
		const session = createAgentSession({ id: "parent-session", agent: mainAgent, task });
		appendUserMessage(session, task.prompt);

		await expect(runtime.runSession(session, controller.signal)).rejects.toThrow("User interrupted");
		expect(session.trace.map((event) => event.type)).toContain("tool_call");
		expect(session.trace.map((event) => event.type)).toContain("model_request");
		expect(session.trace.map((event) => event.type)).not.toContain("tool_result");
	});

	it("passes tool result storage to subagent loops", async () => {
		const outputText = "x".repeat(40_000);
		const storageDir = mkdtempSync(path.join(tmpdir(), "subagent-persistence-"));
		const modelClient: ModelClient = {
			async complete(request) {
				if (request.agent.id === "main" && request.turn === 1) {
					return { toolCalls: [{ id: "main-call", name: "subagent", input: { subagentId: "worker", task: "use echo" } }] };
				}
				if (request.agent.id === "worker-agent" && request.turn === 1) {
					return { toolCalls: [{ id: "worker-call", name: "echo", input: "large" }] };
				}
				if (request.agent.id === "worker-agent") return { text: "sub-answer" };
				return { text: "done" };
			},
		};

		const saved: Array<{ trace: Array<{ type: string; payload?: unknown }> }> = [];
		const runtime = new AgentRuntime({
			modelClient,
			toolRegistry: new ToolRegistry(),
			createToolRegistryForAgent: () => new ToolRegistry([{ name: "echo", description: "Echo", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", async execute() { return outputText; } }]),
			subagents: [subagent],
			subagentTranscriptStore: { async saveTranscript(data) { saved.push(data as typeof saved[number]); } },
			toolResultStorageDir: storageDir,
			createId: createIds(),
			now: () => 1,
		});

		await runtime.runTask(mainAgent, task);
		expect(saved.length).toBe(1);
		const echoResult = saved[0]?.trace.find((event) => event.type === "tool_result" && (event.payload as { call?: { name?: string } })?.call?.name === "echo")?.payload as { output?: string } | undefined;
		const persistedPath = echoResult?.output?.match(/saved to:\n(.+)\nPreview/)?.[1];

		expect(echoResult?.output).toContain("<tool-result-preview>");
		expect(persistedPath).toBeDefined();
		expect(await readFile(persistedPath!, "utf8")).toBe(outputText);
	});

	it("keeps subagent trace separate from parent session trace", async () => {
		const modelClient: ModelClient = {
			async complete(request) {
				if (request.agent.id === "main" && request.turn === 1) {
					return { toolCalls: [{ id: "main-call", name: "subagent", input: { subagentId: "worker", task: "use echo" } }] };
				}
				if (request.agent.id === "worker-agent" && request.turn === 1) {
					return { toolCalls: [{ id: "worker-call", name: "echo", input: "sub-answer" }] };
				}
				if (request.agent.id === "worker-agent") return { text: "sub-answer" };
				return { text: "done" };
			},
		};

		const runtime = new AgentRuntime({
			modelClient,
			toolRegistry: new ToolRegistry(),
			createToolRegistryForAgent: () => new ToolRegistry([{ name: "echo", description: "Echo", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", async execute(input) { return input; } }]),
			subagents: [subagent],
			createId: createIds(),
			now: () => 1,
		});

		const output = await runtime.runTask(mainAgent, task);
		const parentSubagentEvents = output.trace?.filter((event) => (event as { subagentId?: string }).subagentId === "worker") ?? [];
		expect(parentSubagentEvents.length).toBe(0);
	});

	it("narrows subagent tool pool to agent.tools.allowedTools", async () => {
		const requests: ModelRequest[] = [];
		const modelClient: ModelClient = {
			async complete(request) {
				requests.push(request);
				if (request.agent.id === "main" && request.turn === 1) {
					return { toolCalls: [{ id: "call", name: "subagent", input: { subagentId: "worker", task: "work" } }] };
				}
				return { text: "done" };
			},
		};

		const runtime = new AgentRuntime({
			modelClient,
			toolRegistry: new ToolRegistry(),
			createToolRegistryForAgent: () => new ToolRegistry([
				{ name: "echo", description: "Echo", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", async execute(input) { return input; } },
				{ name: "bash", description: "Bash", permission: { defaultDecision: "allow", riskLevel: "high" }, concurrency: "sequential", async execute(input) { return input; } },
			]),
			subagents: [subagent],
			createId: createIds(),
			now: () => 1,
		});

		await runtime.runTask(mainAgent, task);
		const workerRequest = requests.find((request) => request.agent.id === "worker-agent");
		const toolNames = workerRequest?.tools?.map((tool) => tool.name) ?? [];
		expect(toolNames).toEqual(["echo"]);
		expect(toolNames).not.toContain("bash");
	});

	it("reports subagent usage stats in traceSummary", async () => {
		const modelClient: ModelClient = {
			async complete(request) {
				if (request.agent.id === "main" && request.turn === 1) {
					return { toolCalls: [{ id: "main-call", name: "subagent", input: { subagentId: "worker", task: "use echo" } }] };
				}
				if (request.agent.id === "worker-agent" && request.turn === 1) {
					return { toolCalls: [{ id: "worker-call", name: "echo", input: "sub-answer" }] };
				}
				if (request.agent.id === "worker-agent") return { text: "sub-answer" };
				return { text: "done" };
			},
		};

		const runtime = new AgentRuntime({
			modelClient,
			toolRegistry: new ToolRegistry(),
			createToolRegistryForAgent: () => new ToolRegistry([{ name: "echo", description: "Echo", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", async execute(input) { return input; } }]),
			subagents: [subagent],
			createId: createIds(),
			now: () => 1,
		});

		const output = await runtime.runTask(mainAgent, task);
		const subagentResult = output.trace?.find((event) => event.type === "tool_result" && (event.payload as { call?: { name?: string } })?.call?.name === "subagent")?.payload as { output?: { traceSummary?: { turnCount?: number; totalDurationMs?: number; eventCount?: number; modelRequestCount?: number; toolCallCount?: number; toolResultCount?: number } } } | undefined;
		const summary = subagentResult?.output?.traceSummary;

		expect(summary).toBeDefined();
		expect(summary!.turnCount).toBeGreaterThan(0);
		expect(summary!.eventCount).toBeGreaterThan(0);
		expect(summary!.modelRequestCount).toBeGreaterThan(0);
		expect(summary!.toolCallCount).toBeGreaterThan(0);
		expect(summary!.toolResultCount).toBeGreaterThan(0);
		expect(typeof summary!.totalDurationMs).toBe("number");
	});

	it("saves subagent transcript via transcriptStore", async () => {
		const modelClient: ModelClient = {
			async complete(request) {
				if (request.agent.id === "main" && request.turn === 1) {
					return { toolCalls: [{ id: "main-call", name: "subagent", input: { subagentId: "worker", task: "use echo" } }] };
				}
				if (request.agent.id === "worker-agent" && request.turn === 1) {
					return { toolCalls: [{ id: "worker-call", name: "echo", input: "sub-answer" }] };
				}
				if (request.agent.id === "worker-agent") return { text: "sub-answer" };
				return { text: "done" };
			},
		};

		const saved: Array<{ sessionId: string; parentSessionId: string; parentToolCallId: string; subagentId: string; agentId: string; taskId: string; trace: unknown[]; summary: unknown; createdAt: number }> = [];
		const transcriptStore = {
			async saveTranscript(data: typeof saved[number]) {
				saved.push(data);
			},
		};

		const runtime = new AgentRuntime({
			modelClient,
			toolRegistry: new ToolRegistry(),
			createToolRegistryForAgent: () => new ToolRegistry([{ name: "echo", description: "Echo", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", async execute(input) { return input; } }]),
			subagents: [subagent],
			subagentTranscriptStore: transcriptStore,
			createId: createIds(),
			now: () => 1,
		});

		await runtime.runTask(mainAgent, task);
		expect(saved.length).toBe(1);
		expect(saved[0]?.subagentId).toBe("worker");
		expect(saved[0]?.agentId).toBe("worker-agent");
		expect(saved[0]?.parentSessionId).toBe("id-1");
		expect(saved[0]?.parentToolCallId).toBe("main-call");
		expect(saved[0]?.trace.length).toBeGreaterThan(0);
		expect(saved[0]?.createdAt).toBe(1);
	});

	describe("batch subagent tasks", () => {
		const worker2Spec: SubagentSpec = { id: "worker2", role: "tool-specialist", agent: { ...workerAgent, id: "worker-agent-2", name: "Worker2" } };

		it("runs multiple subagents in parallel via tasks array", async () => {
			const requests: ModelRequest[] = [];
			const modelClient: ModelClient = {
				async complete(request) {
					requests.push(request);
					if (request.agent.id === "main" && request.turn === 1) {
						return { toolCalls: [{ id: "main-call", name: "subagent", input: { tasks: [{ subagentId: "worker", task: "task-a" }, { subagentId: "worker2", task: "task-b" }] } }] };
					}
					if (request.agent.id === "worker-agent" && request.turn === 1) return { text: "answer-a" };
					if (request.agent.id === "worker-agent-2" && request.turn === 1) return { text: "answer-b" };
					return { text: "done" };
				},
			};

			const runtime = new AgentRuntime({
				modelClient,
				toolRegistry: new ToolRegistry(),
				createToolRegistryForAgent: () => new ToolRegistry(),
				subagents: [subagent, worker2Spec],
				createId: createIds(),
				now: () => 1,
			});

			const output = await runtime.runTask(mainAgent, task);
			const toolResult = output.trace?.find((event) => event.type === "tool_result")?.payload as { output?: SubagentToolOutput[] } | undefined;
			const results = toolResult?.output;

			expect(output.answer).toBe("done");
			expect(Array.isArray(results)).toBe(true);
			expect(results).toHaveLength(2);
			expect(results![0]?.status).toBe("completed");
			expect(results![0]?.answer).toBe("answer-a");
			expect(results![0]?.subagentId).toBe("worker");
			expect(results![1]?.status).toBe("completed");
			expect(results![1]?.answer).toBe("answer-b");
			expect(results![1]?.subagentId).toBe("worker2");
		});

		it("single subagent failure does not affect other batch tasks", async () => {
			const modelClient: ModelClient = {
				async complete(request) {
					if (request.agent.id === "main" && request.turn === 1) {
						return { toolCalls: [{ id: "main-call", name: "subagent", input: { tasks: [{ subagentId: "worker", task: "task-a" }, { subagentId: "missing-sub", task: "fail" }] } }] };
					}
					if (request.agent.id === "worker-agent" && request.turn === 1) return { text: "answer-a" };
					return { text: "done" };
				},
			};

			const runtime = new AgentRuntime({
				modelClient,
				toolRegistry: new ToolRegistry(),
				createToolRegistryForAgent: () => new ToolRegistry(),
				subagents: [subagent],
				createId: createIds(),
				now: () => 1,
			});

			const output = await runtime.runTask(mainAgent, task);
			const toolResult = output.trace?.find((event) => event.type === "tool_result")?.payload as { output?: SubagentToolOutput[] } | undefined;
			const results = toolResult?.output;

			expect(Array.isArray(results)).toBe(true);
			expect(results).toHaveLength(2);
			expect(results![0]?.status).toBe("completed");
			expect(results![0]?.answer).toBe("answer-a");
			expect(results![1]?.status).toBe("errored");
			expect(results![1]?.errorMessage).toContain("Unknown subagent");
		});

		it("single-mode backward compatibility is preserved", async () => {
			const modelClient: ModelClient = {
				async complete(request) {
					if (request.agent.id === "main" && request.turn === 1) {
						return { toolCalls: [{ id: "main-call", name: "subagent", input: { subagentId: "worker", task: "use echo" } }] };
					}
					if (request.agent.id === "worker-agent" && request.turn === 1) {
						return { toolCalls: [{ id: "worker-call", name: "echo", input: "sub-answer" }] };
					}
					if (request.agent.id === "worker-agent") return { text: "sub-answer" };
					return { text: "done" };
				},
			};

			const runtime = new AgentRuntime({
				modelClient,
				toolRegistry: new ToolRegistry(),
				createToolRegistryForAgent: () => new ToolRegistry([{ name: "echo", description: "Echo", permission: { defaultDecision: "allow", riskLevel: "low" }, concurrency: "parallel-safe", async execute(input) { return input; } }]),
				subagents: [subagent],
				createId: createIds(),
				now: () => 1,
			});

			const output = await runtime.runTask(mainAgent, task);
			const toolResult = output.trace?.find((event) => event.type === "tool_result")?.payload as { output?: SubagentToolOutput; visibleContentPreview?: string } | undefined;

			expect(toolResult?.output?.status).toBe("completed");
			expect(toolResult?.output?.answer).toBe("sub-answer");
			expect(toolResult?.visibleContentPreview).toContain('"subagentId":"worker"');
		});

		it("rejects when neither tasks nor subagentId+task are provided", async () => {
			const modelClient: ModelClient = {
				async complete(request) {
					if (request.turn === 1) return { toolCalls: [{ id: "main-call", name: "subagent", input: {} }] };
					return { text: "done" };
				},
			};
			const runtime = new AgentRuntime({ modelClient, toolRegistry: new ToolRegistry(), subagents: [subagent], createToolRegistryForAgent: () => new ToolRegistry(), createId: createIds(), now: () => 1 });

			const output = await runtime.runTask(mainAgent, task);
			const result = output.trace?.find((event) => event.type === "tool_result")?.payload as { status?: string; errorMessage?: string } | undefined;
			expect(result?.status).toBe("error");
			expect(result?.errorMessage).toContain("subagentId must be a non-empty string");
		});
	});
});

function createIds(): () => string {
	let next = 0;
	return () => `id-${++next}`;
}
