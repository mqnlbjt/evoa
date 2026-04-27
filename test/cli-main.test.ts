import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import type { OpenAIResponsesClient } from "../src/models/openai-client.js";

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

	it("runs a task through the default read-only tool registry", async () => {
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

	it("does not expose mutating tools by default", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-cli-"));
		const agentFile = path.join(root, "agent.json");
		const taskFile = path.join(root, "task.json");
		await writeToolFixture(agentFile, taskFile, ["write_file"]);
		const io = createIO();
		await main([
			"run", "--agent", agentFile, "--task", taskFile, "--provider", "local", "--model", "gpt-5.4-mini", "--base-url", "http://localhost:8317/v1", "--json",
		], { ...io, openAIClientFactory: () => inspectingToolClient(), workspaceRoot: root, now: () => 1, createId: nextId() });

		expect(JSON.parse(io.stdoutText())).toMatchObject({ ok: true, status: "failed" });
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

function createIO(): { stdout: { write: (chunk: string) => boolean }; stderr: { write: (chunk: string) => boolean }; stdoutText: () => string; stderrText: () => string } {
	let stdout = "";
	let stderr = "";
	return {
		stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
		stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
		stdoutText: () => stdout,
		stderrText: () => stderr,
	};
}

function fakeOpenAIClient(answer: string): OpenAIResponsesClient {
	return { responses: { async create() { return { output_text: answer }; } } };
}

function fakeToolOpenAIClient(toolName: string): OpenAIResponsesClient {
	let calls = 0;
	return {
		responses: {
			async create() {
				calls += 1;
				if (calls === 1) {
					return { output_text: "", output: [{ type: "function_call", call_id: "call_1", name: toolName, arguments: "{\"path\":\"note.txt\"}" }] };
				}
				return { output_text: "saw tool" };
			},
		},
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

function nextId(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}
