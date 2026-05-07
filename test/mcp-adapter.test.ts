import { describe, expect, it, vi } from "vitest";
import { createMcpTools } from "../src/mcp/adapter.js";
import type { McpClientHandle } from "../src/mcp/types.js";

const baseClient: McpClientHandle = {
	serverName: "docs",
	status: { state: "connected", serverName: "docs" },
	listTools: vi.fn(),
	callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
	listResources: vi.fn(async () => [{ uri: "file://doc", name: "doc" }]),
	readResource: vi.fn(async () => ({ contents: [{ uri: "file://doc", text: "hello", mimeType: "text/plain" }] })),
	close: vi.fn(),
};

describe("MCP adapter", () => {
	it("wraps MCP tools as EvolvingAgent tools", async () => {
		const tools = createMcpTools({ serverName: "docs", client: baseClient, tools: [{ name: "search.docs", description: "Search", inputSchema: { type: "object" } }] });

		expect(tools[0]).toMatchObject({
			name: "mcp__docs__search_docs",
			description: "Search",
			inputSchema: { type: "object" },
			metadata: { kind: "mcp", serverName: "docs", remoteToolName: "search.docs" },
		});
		expect(await tools[0]?.execute({ q: "hi" })).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(baseClient.callTool).toHaveBeenCalledWith("search.docs", { q: "hi" }, undefined);
	});

	it("adds text resource helper tools", async () => {
		const tools = createMcpTools({ serverName: "docs", client: baseClient, tools: [], resources: true });
		const list = tools.find((tool) => tool.name === "mcp__docs__resources_list");
		const read = tools.find((tool) => tool.name === "mcp__docs__resource_read");

		expect(await list?.execute({})).toEqual({ resources: [{ uri: "file://doc", name: "doc" }] });
		expect(await read?.execute({ uri: "file://doc" })).toEqual({ contents: [{ uri: "file://doc", mimeType: "text/plain", text: "hello" }] });
	});

	it("rejects normalized tool name collisions", () => {
		expect(() => createMcpTools({ serverName: "docs", client: baseClient, tools: [{ name: "a.b" }, { name: "a b" }] })).toThrow("collision");
	});
});
