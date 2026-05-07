import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { createHttpMcpClient } from "../src/mcp/client.js";
import { createToolRegistryForProfileAsync } from "../src/tools/profiles.js";
import type { ModelClient } from "../src/models/types.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

describe("HTTP MCP client smoke", () => {
	it("connects, lists tools, calls a tool, and closes over Streamable HTTP", async () => {
		const server = await startHttpMcpServer();
		try {
			const client = await createHttpMcpClient("http-smoke", { type: "http", url: server.url, timeoutMs: 3000 });
			expect(client.status).toMatchObject({ state: "connected", serverName: "http-smoke" });
			expect(await client.listTools()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "echo" })]));
			expect(await client.callTool("echo", { text: "hi http" })).toMatchObject({ content: [{ type: "text", text: "hi http" }] });
			await client.close();
			expect(client.status).toMatchObject({ state: "closed", serverName: "http-smoke" });
		} finally {
			await server.close();
		}
	});

	it("runs a real HTTP MCP tool through the agent runtime loop", async () => {
		const server = await startHttpMcpServer();
		const registry = await createToolRegistryForProfileAsync({
			profile: "read-only",
			workspaceRoot: import.meta.dirname,
			mcpServers: { smoke: { type: "http", url: server.url, timeoutMs: 3000 } },
		});
		try {
			const result = await new AgentRuntime({ modelClient: echoToolModel(), toolRegistry: registry, createId: createIds(), now: () => 1 }).runTask(agent, task);
			expect(result.answer).toBe("done");
			expect(result.trace).toEqual(expect.arrayContaining([
				expect.objectContaining({ type: "tool_call", payload: expect.objectContaining({ call: expect.objectContaining({ name: "mcp__smoke__echo" }) }) }),
				expect.objectContaining({ type: "tool_result", payload: expect.objectContaining({ status: "success", output: expect.objectContaining({ content: [{ type: "text", text: "hi from runtime" }] }) }) }),
			]));
		} finally {
			await registry.close();
			await server.close();
		}
	});
});

const agent: AgentSpec = {
	id: "mcp-http-smoke-agent",
	version: "1.0.0",
	name: "MCP HTTP Smoke Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "Use MCP tools." },
	tools: { allowedTools: ["mcp__smoke__echo"], permissionMode: "allow", maxToolCalls: 2 },
	runtime: { maxTurns: 3 },
};

const task: TaskSpec = {
	id: "mcp-http-smoke-task",
	type: "general",
	title: "Echo",
	prompt: "Call echo",
	scoring: { method: "exact" },
};

async function startHttpMcpServer(): Promise<{ url: string; close(): Promise<void> }> {
	const transports = new Map<string, StreamableHTTPServerTransport>();
	const server = createServer((request, response) => {
		void handleMcpRequest(request, response, transports);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("HTTP MCP server did not bind to a TCP port");
	return { url: `http://127.0.0.1:${address.port}/mcp`, close: () => closeServer(server) };
}

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse, transports: Map<string, StreamableHTTPServerTransport>): Promise<void> {
	if (request.url?.split("?")[0] !== "/mcp") {
		response.writeHead(404).end();
		return;
	}
	try {
		const body = await readJsonBody(request);
		let transport = request.headers["mcp-session-id"] ? transports.get(String(request.headers["mcp-session-id"])) : undefined;
		if (!transport) {
			transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sessionId) => { transports.set(sessionId, transport!); } });
			transport.onclose = () => {
				const sessionId = transport?.sessionId;
				if (sessionId) transports.delete(sessionId);
			};
			await createSmokeMcpServer().connect(transportAdapter(transport));
		}
		await transport.handleRequest(request, response, body);
	} catch (error) {
		if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	}
}

function transportAdapter(transport: StreamableHTTPServerTransport): Transport {
	const adapter: Transport = {
		start: () => transport.start(),
		send: (message, options) => transport.send(message, options),
		close: () => transport.close(),
	};
	Object.defineProperty(adapter, "sessionId", { get: () => transport.sessionId, enumerable: true });
	Object.defineProperty(adapter, "onclose", { get: () => transport.onclose, set: (handler: (() => void) | undefined) => { setOptional(transport, "onclose", handler); }, enumerable: true });
	Object.defineProperty(adapter, "onerror", { get: () => transport.onerror, set: (handler: ((error: Error) => void) | undefined) => { setOptional(transport, "onerror", handler); }, enumerable: true });
	Object.defineProperty(adapter, "onmessage", { get: () => transport.onmessage, set: (handler: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined) => { setOptional(transport, "onmessage", handler); }, enumerable: true });
	return adapter;
}

function setOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
	if (value === undefined) delete target[key];
	else target[key] = value;
}

function createSmokeMcpServer(): McpServer {
	const server = new McpServer({ name: "http-smoke", version: "1.0.0" });
	server.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async (input) => ({
		content: [{ type: "text", text: input.text }],
	}));
	return server;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	if (chunks.length === 0) return undefined;
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
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
