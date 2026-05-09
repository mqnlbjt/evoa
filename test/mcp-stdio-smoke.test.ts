import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { createStdioMcpClient } from "../src/mcp/client.js";
import { createToolRegistryForProfileAsync } from "../src/tools/profiles.js";
import type { ModelClient } from "../src/models/types.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

describe("stdio MCP client smoke", () => {
	it("connects, lists tools, calls a tool, and closes", async () => {
		const serverPath = mcpServerPath();
		const client = await createStdioMcpClient("smoke", { type: "stdio", command: process.execPath, args: [serverPath], timeoutMs: 3000 });
		expect(client.status).toMatchObject({ state: "connected", serverName: "smoke" });
		expect(await client.listTools()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "echo" })]));
		expect(await client.callTool("echo", { text: "hi" })).toMatchObject({ content: [{ type: "text", text: "hi" }] });
		await client.close();
		expect(client.status).toMatchObject({ state: "closed", serverName: "smoke" });
	});

	it("runs a real stdio MCP tool through the agent runtime loop", async () => {
		const registry = await createToolRegistryForProfileAsync({
			profile: "read-only",
			workspaceRoot: import.meta.dirname,
			mcpServers: { smoke: { type: "stdio", command: process.execPath, args: [mcpServerPath()], timeoutMs: 3000 } },
		});
		try {
			const result = await new AgentRuntime({ modelClient: echoToolModel(), toolRegistry: registry, createId: createIds(), now: () => 1 }).runTask(agent, task);
			expect(result.answer).toBe("done");
			expect(result.trace?.map((event) => event.type)).toEqual(["model_request", "model_response", "tool_call", "tool_result", "model_request", "model_response"]);
			expect(result.trace).toEqual(expect.arrayContaining([
				expect.objectContaining({ type: "tool_call", payload: expect.objectContaining({ call: expect.objectContaining({ name: "mcp__smoke__echo" }) }) }),
				expect.objectContaining({
					type: "tool_result",
					payload: expect.objectContaining({
						status: "success",
						visibleContentPreview: expect.stringContaining("hi from runtime"),
					}),
				}),
			]));
		} finally {
			await registry.close();
		}
	});
});

const agent: AgentSpec = {
	id: "mcp-smoke-agent",
	version: "1.0.0",
	name: "MCP Smoke Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "Use MCP tools." },
	tools: { allowedTools: ["mcp__smoke__echo"], permissionMode: "allow", maxToolCalls: 2 },
	runtime: { maxTurns: 3 },
};

const task: TaskSpec = {
	id: "mcp-smoke-task",
	type: "general",
	title: "Echo",
	prompt: "Call echo",
	scoring: { method: "exact" },
};

function mcpServerPath(): string {
	return path.join(import.meta.dirname, "fixtures", "mcp-stdio-server.mjs");
}

function echoToolModel(): ModelClient {
	let turn = 0;
	return {
		async complete(request) {
			turn += 1;
			if (turn === 1) {
				expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "mcp__smoke__echo" })]));
				return { toolCalls: [{ id: "call-1", name: "mcp__smoke__echo", input: { text: "hi from runtime" } }] };
			}
			expect(request.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", toolCallId: "call-1", content: expect.stringContaining("hi from runtime") })]));
			return { text: "done" };
		},
	};
}

function createIds(): () => string {
	let index = 0;
	return () => `id-${index += 1}`;
}
