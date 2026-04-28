import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import type { OpenAIResponsesClient } from "../src/models/openai-client.js";
import { createIO, fakeOpenAIClient, fakeToolOpenAIClient, lines, nextId } from "./helpers/cli.js";

const agentPath = "/home/wyq/data/pi/evolving-agent/examples/agents/basic.json";
const taskPath = "/home/wyq/data/pi/evolving-agent/examples/tasks/smoke.json";
const suitePath = "/home/wyq/data/pi/evolving-agent/examples/suites/smoke.json";

describe("CLI main", () => {
	it("discovers models as JSON", async () => {
		const io = createIO();
		const code = await main([
			"models",
			"discover",
			"--provider",
			"local",
			"--base-url",
			"http://localhost:8317/v1",
			"--json",
		], {
			...io,
			fetchFn: async () => new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-5.4-mini" }] }), { status: 200 }),
		});

		expect(code).toBe(0);
		const output = JSON.parse(io.stdoutText());
		expect(output).toMatchObject({ ok: true, command: "models.discover", models: [{ id: "gpt-5.4-mini" }] });
	});

	it("returns usage errors for missing args", async () => {
		const io = createIO();
		const code = await main(["run", "--json"], io);

		expect(code).toBe(2);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: false, error: { code: "USAGE_ERROR" } });
	});

	it("runs chat as JSON with a fake OpenAI client", async () => {
		const io = createIO();
		const code = await main([
			"chat",
			"hello",
			"--agent",
			agentPath,
			"--provider",
			"local",
			"--model",
			"gpt-5.4-mini",
			"--base-url",
			"http://localhost:8317/v1",
			"--json",
		], { ...io, openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, command: "chat", answer: "hi" });
	});

	it("runs chat with defaults from a config file", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ agentPath, provider: "local", model: "gpt-5.4-mini", baseURL: "http://localhost:8317/v1", apiKey: "key" }));
		const io = createIO();
		const code = await main(["chat", "hello", "--config", configPath, "--json"], { ...io, openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, command: "chat", answer: "hi" });
	});

	it("runs chat as human output", async () => {
		const io = createIO();
		const code = await main([
			"chat", "hello", "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1",
		], { ...io, openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(io.stdoutText()).toBe("hi\n");
	});

	it("runs chat as an interactive REPL", async () => {
		const io = createIO();
		let calls = 0;
		const code = await main([
			"chat", "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1",
		], { ...io, inputLines: lines(["hello", "/exit"]), openAIClientFactory: () => ({ responses: { async create() { calls += 1; return { output_text: "hi" }; } } }), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(calls).toBe(1);
		expect(io.stdoutText()).toBe("> hi\n> ");
	});

	it("skips empty REPL input", async () => {
		const io = createIO();
		let calls = 0;
		const code = await main([
			"chat", "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1",
		], { ...io, inputLines: lines(["", "   ", "/quit"]), openAIClientFactory: () => ({ responses: { async create() { calls += 1; return { output_text: "hi" }; } } }), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(calls).toBe(0);
		expect(io.stdoutText()).toBe("> > > ");
	});

	it("reuses REPL messages across turns", async () => {
		const io = createIO();
		let calls = 0;
		let seenInput: unknown;
		const code = await main([
			"chat", "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1",
		], { ...io, inputLines: lines(["remember", "recall", "/exit"]), openAIClientFactory: () => ({ responses: { async create(input) { calls += 1; if (calls === 2) seenInput = input; return { output_text: calls === 1 ? "stored" : "recalled" }; } } }), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(calls).toBe(2);
		expect(seenInput).toMatchObject({ input: expect.arrayContaining([
			expect.objectContaining({ role: "user", content: "remember" }),
			expect.objectContaining({ role: "assistant", content: "stored" }),
			expect.objectContaining({ role: "user", content: "recall" }),
		]) });
	});

	it("resets REPL run counters for each user turn", async () => {
		const io = createIO();
		let calls = 0;
		const code = await main([
			"chat", "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1",
		], { ...io, inputLines: lines(["one", "two", "/exit"]), openAIClientFactory: () => ({ responses: { async create() { calls += 1; return { output_text: `answer-${calls}` }; } } }), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(calls).toBe(2);
		expect(io.stdoutText()).toBe("> answer-1\n> answer-2\n> ");
	});

	it("saves REPL sessions for resume", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const io1 = createIO();
		await main([
			"chat", "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1", "--session", "demo", "--session-dir", root,
		], { ...io1, inputLines: lines(["remember", "/exit"]), openAIClientFactory: () => fakeOpenAIClient("stored"), now: () => 1, createId: nextId() });

		let seenInput: unknown;
		const io2 = createIO();
		const code = await main([
			"chat", "recall", "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1", "--resume", "demo", "--session-dir", root, "--json",
		], { ...io2, openAIClientFactory: () => ({ responses: { async create(input) { seenInput = input; return { output_text: "recalled" }; } } }), now: () => 2, createId: nextId() });

		expect(code).toBe(0);
		expect(JSON.parse(io2.stdoutText())).toMatchObject({ ok: true, answer: "recalled", sessionId: "demo" });
		expect(seenInput).toMatchObject({ input: expect.arrayContaining([
			expect.objectContaining({ role: "user", content: "remember" }),
			expect.objectContaining({ role: "assistant", content: "stored" }),
			expect.objectContaining({ role: "user", content: "recall" }),
		]) });
	});

	it("saves and resumes chat sessions", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const io1 = createIO();
		await main([
			"chat", "remember", "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1", "--session", "demo", "--session-dir", root, "--json",
		], { ...io1, openAIClientFactory: () => fakeOpenAIClient("stored"), now: () => 1, createId: nextId() });

		let seenInput: unknown;
		const io2 = createIO();
		const code = await main([
			"chat", "recall", "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1", "--resume", "demo", "--session-dir", root, "--json",
		], { ...io2, openAIClientFactory: () => ({ responses: { async create(input) { seenInput = input; return { output_text: "recalled" }; } } }), now: () => 2, createId: nextId() });

		expect(code).toBe(0);
		expect(JSON.parse(io2.stdoutText())).toMatchObject({ ok: true, answer: "recalled", sessionId: "demo" });
		expect(seenInput).toMatchObject({ input: expect.arrayContaining([
			expect.objectContaining({ role: "user", content: "remember" }),
			expect.objectContaining({ role: "assistant", content: "stored" }),
			expect.objectContaining({ role: "user", content: "recall" }),
		]) });
	});

	it("runs a task as JSON with a fake OpenAI client", async () => {
		const io = createIO();
		const code = await main([
			"run",
			"--agent",
			agentPath,
			"--task",
			taskPath,
			"--provider",
			"local",
			"--model",
			"gpt-5.4-mini",
			"--base-url",
			"http://localhost:8317/v1",
			"--json",
		], { ...io, openAIClientFactory: () => fakeOpenAIClient("pong"), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, command: "run", status: "passed", score: { score: 1 } });
	});

	it("runs a benchmark as JSON with a fake OpenAI client", async () => {
		const io = createIO();
		const code = await main([
			"benchmark",
			"--suite",
			suitePath,
			"--agent",
			agentPath,
			"--provider",
			"local",
			"--model",
			"gpt-5.4-mini",
			"--base-url",
			"http://localhost:8317/v1",
			"--json",
		], { ...io, openAIClientFactory: () => fakeOpenAIClient("pong"), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, command: "benchmark", summary: { totalTasks: 1, passedTasks: 1, passRate: 1 } });
	});

	it("returns failure for benchmark tasks that do not pass grading", async () => {
		const io = createIO();
		const code = await main([
			"benchmark",
			"--suite",
			suitePath,
			"--agent",
			agentPath,
			"--provider",
			"local",
			"--model",
			"gpt-5.4-mini",
			"--base-url",
			"http://localhost:8317/v1",
			"--json",
		], { ...io, openAIClientFactory: () => fakeOpenAIClient("wrong"), now: () => 1, createId: nextId() });

		expect(code).toBe(1);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: false, command: "benchmark", summary: { failedTasks: 1 }, runs: [{ status: "failed" }] });
	});

	it("writes benchmark JSON reports", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const reportPath = path.join(root, "report.json");
		const io = createIO();
		const code = await main([
			"benchmark", "--suite", suitePath, "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1", "--report", reportPath, "--json",
		], { ...io, openAIClientFactory: () => fakeOpenAIClient("pong"), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({ version: 1, suite: { id: "smoke" }, summary: { passedTasks: 1 } });
	});

	it("writes benchmark trace and report files together", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const tracePath = path.join(root, "trace.json");
		const reportPath = path.join(root, "report.json");
		const io = createIO();
		const code = await main([
			"benchmark", "--suite", suitePath, "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1", "--trace", tracePath, "--report", reportPath, "--json",
		], { ...io, openAIClientFactory: () => fakeOpenAIClient("pong"), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, command: "benchmark" });
		expect(JSON.parse(await readFile(tracePath, "utf8"))).toMatchObject({ suite: { id: "smoke" }, runs: [{ status: "passed", trace: expect.any(Array) }] });
		expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({ version: 1, suite: { id: "smoke" }, summary: { passedTasks: 1 } });
	});

	it("writes benchmark Markdown reports", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const reportPath = path.join(root, "report.md");
		const io = createIO();
		const code = await main([
			"benchmark", "--suite", suitePath, "--agent", agentPath, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1", "--report", reportPath, "--report-format", "markdown", "--json",
		], { ...io, openAIClientFactory: () => fakeOpenAIClient("pong"), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		const markdown = await readFile(reportPath, "utf8");
		expect(markdown).toContain("# Benchmark Report");
		expect(markdown).toContain("| smoke\\-task | general | passed | 1/1 |");
	});

	it("runs evolution as JSON and writes reports and history", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const baselineAgentFile = path.join(root, "baseline.json");
		const candidateAgentFile = path.join(root, "candidate.json");
		const reportPath = path.join(root, "evolution.md");
		const historyPath = path.join(root, "evolution.jsonl");
		await writeFile(baselineAgentFile, JSON.stringify({
			id: "baseline-agent",
			version: "1.0.0",
			name: "Baseline Agent",
			kind: "baseline",
			model: { provider: "local", model: "gpt-5.4-mini" },
			prompts: { system: "system" },
			tools: { allowedTools: [] },
			runtime: { maxTurns: 1 },
		}));
		await writeFile(candidateAgentFile, JSON.stringify({
			id: "candidate-agent",
			version: "1.0.0",
			name: "Candidate Agent",
			kind: "candidate",
			model: { provider: "local", model: "gpt-5.4-mini" },
			prompts: { system: "system" },
			tools: { allowedTools: [] },
			runtime: { maxTurns: 1 },
		}));
		let calls = 0;
		const io = createIO();
		const code = await main([
			"evolve", "--suite", suitePath, "--baseline-agent", baselineAgentFile, "--candidate-agent", candidateAgentFile, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1", "--report", reportPath, "--report-format", "markdown", "--history", historyPath, "--json",
		], { ...io, openAIClientFactory: () => fakeOpenAIClient(++calls === 1 ? "nope" : "pong"), now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, command: "evolve", recommendation: "accept", improvements: ["smoke-task"] });
		expect(await readFile(reportPath, "utf8")).toContain("# Evolution Report");
		expect(await readFile(historyPath, "utf8")).toContain("evolution_comparison");
	});

	it("replays a trace as JSON", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const tracePath = path.join(root, "trace.json");
		await writeFile(tracePath, JSON.stringify(taskRunFixture("run-1", "task-1", "passed", 1)));
		const io = createIO();
		const code = await main(["replay", "--trace", tracePath, "--json"], io);

		expect(code).toBe(0);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, command: "replay", runs: [{ runId: "run-1", eventCount: 2, warnings: [] }] });
	});

	it("diffs two task runs as JSON", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const leftPath = path.join(root, "left.json");
		const rightPath = path.join(root, "right.json");
		await writeFile(leftPath, JSON.stringify(taskRunFixture("left", "task-1", "failed", 0)));
		await writeFile(rightPath, JSON.stringify(taskRunFixture("right", "task-1", "passed", 1)));
		const io = createIO();
		const code = await main(["diff", "--left", leftPath, "--right", rightPath, "--json"], io);

		expect(code).toBe(0);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, command: "diff", diff: { classification: "improvement", scoreDelta: 1 } });
	});

	it("runs a task through the default full tool registry", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const agentFile = path.join(root, "agent.json");
		const taskFile = path.join(root, "task.json");
		await writeFile(path.join(root, "note.txt"), "tool result");
		await writeFile(agentFile, JSON.stringify({
			id: "tool-agent",
			version: "1.0.0",
			name: "Tool Agent",
			kind: "baseline",
			model: { provider: "local", model: "gpt-5.4-mini" },
			prompts: { system: "Read files." },
			tools: { allowedTools: ["read_file"], permissionMode: "allow", maxToolCalls: 2 },
			runtime: { maxTurns: 3 },
		}));
		await writeFile(taskFile, JSON.stringify({
			id: "tool-task",
			type: "general",
			title: "Read note",
			prompt: "Read note.txt",
			scoring: { method: "rubric", config: { contains: ["saw tool"] } },
		}));
		const io = createIO();
		const code = await main([
			"run",
			"--agent",
			agentFile,
			"--task",
			taskFile,
			"--provider",
			"local",
			"--model",
			"gpt-5.4-mini",
			"--base-url",
			"http://localhost:8317/v1",
			"--json",
		], { ...io, openAIClientFactory: () => fakeToolOpenAIClient("read_file"), workspaceRoot: root, now: () => 1, createId: nextId() });

		expect(code).toBe(0);
		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, command: "run", status: "passed", score: { score: 1 } });
	});

	it("exposes mutating tools by default", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const agentFile = path.join(root, "agent.json");
		const taskFile = path.join(root, "task.json");
		await writeToolFixture(agentFile, taskFile, ["write_file"]);
		const io = createIO();
		await main([
			"run", "--agent", agentFile, "--task", taskFile, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1", "--json",
		], { ...io, openAIClientFactory: () => inspectingToolClient(), workspaceRoot: root, now: () => 1, createId: nextId() });

		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, status: "passed" });
	});

	it("exposes mutating tools with the coding profile", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const agentFile = path.join(root, "agent.json");
		const taskFile = path.join(root, "task.json");
		await writeToolFixture(agentFile, taskFile, ["write_file"]);
		const io = createIO();
		await main([
			"run", "--agent", agentFile, "--task", taskFile, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1", "--tool-profile", "coding", "--json",
		], { ...io, openAIClientFactory: () => inspectingToolClient(), workspaceRoot: root, now: () => 1, createId: nextId() });

		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, status: "passed" });
	});
});

function taskRunFixture(runId: string, taskId: string, status: "passed" | "failed" | "errored" | "timeout", scoreValue: number) {
	const agent = {
		id: "agent-1",
		version: "1.0.0",
		name: "Agent",
		kind: "baseline",
		model: { provider: "local", model: "model" },
		prompts: { system: "system" },
		tools: { allowedTools: [] },
		runtime: { maxTurns: 1 },
	};
	const task = { id: taskId, type: "general", title: taskId, prompt: "Prompt", scoring: { method: "rubric" } };
	return {
		runId,
		agent,
		task,
		status,
		score: { score: scoreValue, maxScore: 1, passed: status === "passed", reason: "ok" },
		startedAt: 1,
		endedAt: 2,
		durationMs: 1,
		trace: [
			{ id: `${runId}-start`, type: "run_start", timestamp: 1, agentId: agent.id, taskId, payload: {} },
			{ id: `${runId}-end`, type: "run_end", timestamp: 2, agentId: agent.id, taskId, payload: {} },
		],
	};
}

function inspectingToolClient(): OpenAIResponsesClient {
	return {
		responses: {
			async create(input) {
				const names = input.tools?.map((tool) => "name" in tool ? tool.name : "") ?? [];
				return { output_text: names.join(",") };
			},
		},
	};
}

async function writeToolFixture(agentFile: string, taskFile: string, allowedTools: string[]): Promise<void> {
	await writeFile(agentFile, JSON.stringify({
		id: "tool-agent",
		version: "1.0.0",
		name: "Tool Agent",
		kind: "baseline",
		model: { provider: "local", model: "gpt-5.4-mini" },
		prompts: { system: "Inspect tools." },
		tools: { allowedTools, permissionMode: "allow", maxToolCalls: 2 },
		runtime: { maxTurns: 1 },
	}));
	await writeFile(taskFile, JSON.stringify({
		id: "tool-task",
		type: "general",
		title: "Inspect tools",
		prompt: "Inspect tools",
		scoring: { method: "rubric", config: { contains: allowedTools } },
	}));
}

