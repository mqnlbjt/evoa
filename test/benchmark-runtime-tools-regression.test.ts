import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MinimalTaskGrader } from "../src/benchmark/grader.js";
import { BenchmarkRunner } from "../src/benchmark/runner.js";
import type { AgentTaskRunResult, BenchmarkSuite } from "../src/benchmark/types.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/models/types.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { TraceEvent } from "../src/runtime/events.js";
import { MemoryRunStore } from "../src/sessions/run-store.js";
import type { AgentSpec, SubagentSpec, TaskSpec } from "../src/specs.js";
import { createToolRegistryForProfile, type ToolProfile } from "../src/tools/profiles.js";

describe("benchmark runtime tool regression", () => {
	it("runs benchmark tasks through real runtime, tool policy, trace, and grader paths", async () => {
		const workspaceRoot = await mkdtemp(path.join(tmpdir(), "evolving-agent-benchmark-tools-"));
		await writeFile(path.join(workspaceRoot, "note.txt"), "tool content");
		const store = new MemoryRunStore();
		const ids = createIds();
		const model = scriptedModelClient(scriptedResponse);
		const agent = baseAgent({ allowedTools: ["read_file", "write_file", "missing_tool"] });
		const suite: BenchmarkSuite = {
			id: "tool-paths",
			name: "Tool path regression",
			tasks: [
				toolTask("tool-success", ["read_file"], "saw tool content"),
				toolTask("task-narrowing", ["read_file"], "task policy recovered"),
				toolTask("tool-unknown", ["missing_tool"], "recovered after unknown"),
			],
		};
		const runner = createRunner({ agent, model: model.client, profile: "coding", workspaceRoot, store, ids });

		const result = await runner.runSuite(agent, suite);

		expect(result.summary).toMatchObject({ totalTasks: 3, passedTasks: 3, failedTasks: 0, erroredTasks: 0, timeoutTasks: 0 });
		expect(result.summary.byTaskType.tool).toMatchObject({ totalTasks: 3, passedTasks: 3, passRate: 1 });
		expect(store.taskRuns).toHaveLength(3);
		expect(store.suiteRuns).toHaveLength(1);

		const success = runByTask(result.runs, "tool-success");
		expect(success.status).toBe("passed");
		expect(eventTypes(success)).toEqual(expect.arrayContaining(["run_start", "model_request", "model_response", "tool_call", "tool_result", "score", "run_end"]));
		expect(toolResults(success)).toEqual([expect.objectContaining({ status: "success", call: expect.objectContaining({ name: "read_file" }) })]);
		expect(model.requestsFor("tool-success")[0]?.tools?.map((tool) => tool.name)).toEqual(["read_file"]);
		expect(model.requestsFor("tool-success")[1]?.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "assistant", contentBlocks: expect.arrayContaining([expect.objectContaining({ type: "tool_call", name: "read_file" })]) }),
			expect.objectContaining({ role: "tool", contentBlocks: expect.arrayContaining([expect.objectContaining({ type: "tool_result", toolName: "read_file" })]) }),
		]));

		const narrowed = runByTask(result.runs, "task-narrowing");
		expect(narrowed.status).toBe("passed");
		expect(model.requestsFor("task-narrowing")[0]?.tools?.map((tool) => tool.name)).toEqual(["read_file"]);
		expect(toolResults(narrowed)).toEqual([expect.objectContaining({ status: "denied", call: expect.objectContaining({ name: "write_file" }) })]);
		await expectMissing(path.join(workspaceRoot, "narrowed.txt"));

		const unknown = runByTask(result.runs, "tool-unknown");
		expect(unknown.status).toBe("passed");
		expect(toolResults(unknown)).toEqual([expect.objectContaining({ status: "unknown", errorMessage: "Unknown tool: missing_tool" })]);
		expect(model.requestsFor("tool-unknown")[1]?.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "tool", contentBlocks: expect.arrayContaining([expect.objectContaining({ type: "tool_result", isError: true })]) }),
		]));

		for (const run of result.runs) {
			expect(eventsOfType(run, "tool_call")).toHaveLength(eventsOfType(run, "tool_result").length);
			expect(eventTypes(run)).toEqual(expect.arrayContaining(["score", "run_end"]));
		}
	});

	it("does not expose mutating tools from the read-only profile", async () => {
		const workspaceRoot = await mkdtemp(path.join(tmpdir(), "evolving-agent-benchmark-read-only-"));
		const ids = createIds();
		const model = scriptedModelClient((request) => {
			if (request.turn === 1) return { toolCalls: [{ id: "call-write", name: "write_file", input: { path: "readonly.txt", content: "new" } }] };
			return { text: "recovered after unknown" };
		});
		const agent = baseAgent({ allowedTools: ["write_file"] });
		const task = toolTask("read-only-write", ["write_file"], "recovered after unknown");
		const runner = createRunner({ agent, model: model.client, profile: "read-only", workspaceRoot, ids });

		const run = await runner.runTask(agent, task);

		expect(run.status).toBe("passed");
		expect(model.requestsFor("read-only-write")[0]?.tools?.map((tool) => tool.name) ?? []).toEqual([]);
		expect(toolResults(run)).toEqual([expect.objectContaining({ status: "unknown", errorMessage: "Unknown tool: write_file" })]);
		await expectMissing(path.join(workspaceRoot, "readonly.txt"));
	});

	it("allows benchmark-sandbox mutating tools while preserving task-level narrowing", async () => {
		const workspaceRoot = await mkdtemp(path.join(tmpdir(), "evolving-agent-benchmark-sandbox-"));
		const ids = createIds();
		const model = scriptedModelClient((request) => {
			if (request.turn === 1) return { toolCalls: [{ id: "call-write", name: "write_file", input: { path: "written.txt", content: "new" } }] };
			return { text: "wrote file" };
		});
		const agent = baseAgent({ allowedTools: ["read_file", "write_file"] });
		const task = toolTask("sandbox-write", ["write_file"], "wrote file");
		const runner = createRunner({ agent, model: model.client, profile: "benchmark-sandbox", workspaceRoot, ids });

		const run = await runner.runTask(agent, task);

		expect(run.status).toBe("passed");
		expect(model.requestsFor("sandbox-write")[0]?.tools?.map((tool) => tool.name)).toEqual(["write_file"]);
		expect(toolResults(run)).toEqual([expect.objectContaining({ status: "success", call: expect.objectContaining({ name: "write_file" }) })]);
		await expect(access(path.join(workspaceRoot, "written.txt"))).resolves.toBeUndefined();
	});

	it("records benchmark-sandbox tool-policy denial without executing bash", async () => {
		const workspaceRoot = await mkdtemp(path.join(tmpdir(), "evolving-agent-benchmark-sandbox-deny-"));
		const ids = createIds();
		const model = scriptedModelClient((request) => {
			if (request.turn === 1) return { toolCalls: [{ id: "call-bash", name: "bash", input: { command: "curl https://example.com" } }] };
			return { text: "recovered after sandbox denied" };
		});
		const agent = baseAgent({ allowedTools: ["bash"] });
		const task = toolTask("sandbox-bash-denied", ["bash"], "recovered after sandbox denied");
		const runner = createRunner({ agent, model: model.client, profile: "benchmark-sandbox", workspaceRoot, ids });

		const run = await runner.runTask(agent, task);

		expect(run.status).toBe("passed");
		expect(toolResults(run)).toEqual([expect.objectContaining({ status: "denied", metadata: expect.objectContaining({ sandboxDecision: "deny", sandboxMode: "workspace" }) })]);
		expect(model.requestsFor("sandbox-bash-denied")[1]?.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "tool", contentBlocks: expect.arrayContaining([expect.objectContaining({ type: "tool_result", isError: true })]) }),
		]));
	});

	it("keeps registered agent-denied tools recoverable without executing them", async () => {
		const workspaceRoot = await mkdtemp(path.join(tmpdir(), "evolving-agent-benchmark-denied-"));
		const ids = createIds();
		const model = scriptedModelClient(scriptedResponse);
		const agent = baseAgent({ allowedTools: ["write_file"], deniedTools: ["write_file"] });
		const task = toolTask("tool-denied", ["write_file"], "recovered after denied");
		const runner = createRunner({ agent, model: model.client, profile: "coding", workspaceRoot, ids });

		const run = await runner.runTask(agent, task);

		expect(run.status).toBe("passed");
		expect(model.requestsFor("tool-denied")[0]?.tools?.map((tool) => tool.name) ?? []).not.toContain("write_file");
		expect(toolResults(run)).toEqual([expect.objectContaining({ status: "denied", call: expect.objectContaining({ name: "write_file" }) })]);
		expect(model.requestsFor("tool-denied")[1]?.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "tool", contentBlocks: expect.arrayContaining([expect.objectContaining({ type: "tool_result", isError: true })]) }),
		]));
		await expectMissing(path.join(workspaceRoot, "denied.txt"));
	});

	it("preserves subagent trace linkage through benchmark runtime runs", async () => {
		const workspaceRoot = await mkdtemp(path.join(tmpdir(), "evolving-agent-benchmark-subagent-"));
		const requests: ModelRequest[] = [];
		const ids = createIds();
		const workerAgent = baseAgent({ allowedTools: ["read_file"] });
		workerAgent.id = "worker-agent";
		workerAgent.name = "Worker Agent";
		const subagent: SubagentSpec = { id: "worker", role: "tool-specialist", agent: workerAgent };
		const mainAgent = baseAgent({ allowedTools: ["subagent"] });
		mainAgent.id = "main-agent";
		mainAgent.name = "Main Agent";
		mainAgent.tools.maxToolCalls = 1;
		const model: ModelClient = {
			async complete(request) {
				requests.push(request);
				if (request.agent.id === "main-agent" && request.turn === 1) return { toolCalls: [{ id: "main-call", name: "subagent", input: { subagentId: "worker", task: "answer as worker" } }] };
				if (request.agent.id === "worker-agent") return { text: "sub-answer" };
				return { text: "done with worker" };
			},
		};
		const runner = createRunner({ agent: mainAgent, model, profile: "read-only", workspaceRoot, ids, subagents: [subagent] });
		const task = toolTask("subagent-benchmark", ["subagent"], "done with worker");

		const run = await runner.runTask(mainAgent, task);
		const mainToolCall = eventsOfType(run, "tool_call").find((event) => (event.payload as { call?: { name?: string } }).call?.name === "subagent");
		const subagentResult = toolResults(run).find((payload) => (payload as { call?: { name?: string } }).call?.name === "subagent") as { visibleContentPreview?: string } | undefined;
		const output = parseVisibleOutput(subagentResult) as { subagentId?: string; agentId?: string; status?: string; answer?: string; traceSummary?: { eventCount?: number } } | undefined;

		expect(run.status).toBe("passed");
		expect(mainToolCall).toBeDefined();
		expect(output).toMatchObject({ subagentId: "worker", agentId: "worker-agent", status: "completed", answer: "sub-answer" });
		expect(output?.traceSummary?.eventCount).toBeGreaterThan(0);
		expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["subagent"]);
		expect(requests.find((request) => request.agent.id === "worker-agent")?.tools?.map((tool) => tool.name)).toEqual(["read_file"]);
	});
});

function baseAgent(tools: { allowedTools: string[]; deniedTools?: string[] }): AgentSpec {
	return {
		id: "benchmark-tool-agent",
		version: "1.0.0",
		name: "Benchmark Tool Agent",
		kind: "baseline",
		model: { provider: "local", model: "fake-model" },
		prompts: { system: "Use tools when needed." },
		tools: { ...tools, permissionMode: "allow", maxToolCalls: 2 },
		runtime: { maxTurns: 3 },
	};
}

function toolTask(id: string, allowedTools: string[], expected: string): TaskSpec {
	return {
		id,
		type: "tool",
		title: id,
		prompt: `Run ${id}`,
		allowedTools,
		scoring: { method: "exact", maxScore: 1, config: { expected } },
	};
}

function scriptedResponse(request: ModelRequest): ModelResponse {
	if (request.turn === 2) return { text: expectedForTask(request.task.id) };
	if (request.task.id === "tool-success") return { text: "checking", toolCalls: [{ id: "call-read", name: "read_file", input: { path: "note.txt" } }] };
	if (request.task.id === "tool-denied") return { toolCalls: [{ id: "call-denied", name: "write_file", input: { path: "denied.txt", content: "new" } }] };
	if (request.task.id === "tool-unknown") return { toolCalls: [{ id: "call-unknown", name: "missing_tool", input: {} }] };
	return { toolCalls: [{ id: "call-narrowed", name: "write_file", input: { path: "narrowed.txt", content: "new" } }] };
}

function expectedForTask(taskId: string): string {
	if (taskId === "tool-success") return "saw tool content";
	if (taskId === "tool-denied") return "recovered after denied";
	if (taskId === "tool-unknown") return "recovered after unknown";
	return "task policy recovered";
}

function createRunner(options: {
	agent: AgentSpec;
	model: ModelClient;
	profile: ToolProfile;
	workspaceRoot: string;
	ids: () => string;
	store?: MemoryRunStore;
	subagents?: SubagentSpec[];
}): BenchmarkRunner {
	return new BenchmarkRunner({
		runtime: new AgentRuntime({
			modelClient: options.model,
			createToolRegistryForAgent: () => createToolRegistryForProfile({ profile: options.profile, workspaceRoot: options.workspaceRoot }),
			...(options.subagents ? { subagents: options.subagents } : {}),
			createId: options.ids,
			now: () => 1,
		}),
		grader: new MinimalTaskGrader(),
		...(options.store ? { store: options.store } : {}),
		createId: options.ids,
		now: () => 1,
	});
}

function scriptedModelClient(handler: (request: ModelRequest) => ModelResponse): { client: ModelClient; requestsFor: (taskId: string) => ModelRequest[] } {
	const requests: ModelRequest[] = [];
	return {
		client: {
			async complete(request) {
				requests.push(request);
				return handler(request);
			},
		},
		requestsFor(taskId) {
			return requests.filter((request) => request.task.id === taskId);
		},
	};
}

function runByTask(runs: AgentTaskRunResult[], taskId: string): AgentTaskRunResult {
	const run = runs.find((candidate) => candidate.task.id === taskId);
	if (!run) throw new Error(`missing run for ${taskId}`);
	return run;
}

function eventsOfType(run: AgentTaskRunResult, type: TraceEvent["type"]): TraceEvent[] {
	return run.trace.filter((event) => event.type === type);
}

function eventTypes(run: AgentTaskRunResult): string[] {
	return run.trace.map((event) => event.type);
}

function toolResults(run: AgentTaskRunResult): unknown[] {
	return eventsOfType(run, "tool_result").map((event) => event.payload);
}

function parseVisibleOutput(payload: { visibleContentPreview?: string } | undefined): unknown {
	return payload?.visibleContentPreview ? JSON.parse(payload.visibleContentPreview) : undefined;
}

function createIds(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}

async function expectMissing(filePath: string): Promise<void> {
	await expect(access(filePath)).rejects.toThrow();
}
