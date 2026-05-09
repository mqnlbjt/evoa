import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { appendUserMessage, createAgentSession } from "../src/runtime/session.js";
import type { TraceEvent } from "../src/runtime/events.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { EvolvingAgentTool } from "../src/tools/types.js";
import { fakeOpenAIClient, fakeToolOpenAIClient, nextId } from "./helpers/cli.js";
import { OpenAIModelClient } from "../src/models/openai-client.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "system" },
	tools: { allowedTools: ["echo"], permissionMode: "allow" },
	runtime: { maxTurns: 3 },
};

const task: TaskSpec = {
	id: "task",
	type: "general",
	title: "Task",
	prompt: "hello",
	scoring: { method: "rubric", config: { contains: [] } },
};

const echoTool: EvolvingAgentTool = {
	name: "echo",
	description: "Echo input",
	permission: { defaultDecision: "allow", riskLevel: "low" },
	concurrency: "parallel-safe",
	async execute(input) {
		return input;
	},
};

describe("runtime event observer", () => {
	it("emits model events in the same order as session trace", async () => {
		const observed: TraceEvent[] = [];
		const session = createSession();
		const runtime = new AgentRuntime({
			modelClient: new OpenAIModelClient({ client: fakeOpenAIClient("answer") }),
			createId: nextId(),
			now: () => 100,
			eventObserver: (event) => { observed.push(event); },
		});

		await runtime.runSession(session);

		expect(observed.map((event) => event.type)).toEqual(["context_view", "model_request", "model_response"]);
		expect(observed).toEqual(session.trace);
	});

	it("emits tool call and result events", async () => {
		const observed: TraceEvent[] = [];
		const session = createSession();
		const runtime = new AgentRuntime({
			modelClient: new OpenAIModelClient({ client: fakeToolOpenAIClient("echo", "ok") }),
			toolRegistry: new ToolRegistry([echoTool]),
			createId: nextId(),
			now: () => 100,
			eventObserver: (event) => { observed.push(event); },
		});

		await runtime.runSession(session);

		expect(observed.map((event) => event.type)).toEqual(["context_view", "model_request", "model_response", "tool_call", "tool_result", "context_view", "model_request", "model_response"]);
		expect(observed).toEqual(session.trace);
	});

	it("does not fail runtime when observer throws", async () => {
		const session = createSession();
		const runtime = new AgentRuntime({
			modelClient: new OpenAIModelClient({ client: fakeOpenAIClient("answer") }),
			createId: nextId(),
			eventObserver: () => { throw new Error("observer failed"); },
		});

		const output = await runtime.runSession(session);

		expect(output.answer).toBe("answer");
		expect(session.trace.map((event) => event.type)).toEqual(["context_view", "model_request", "model_response"]);
	});
});

function createSession() {
	const session = createAgentSession({ id: "session", agent, task });
	appendUserMessage(session, "hello");
	return session;
}
