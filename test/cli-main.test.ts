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

function nextId(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}
