import { describe, expect, it, vi } from "vitest";
import { createMcpRuntimeBundle } from "../src/mcp/registry.js";
import type { McpClientHandle } from "../src/mcp/types.js";

function client(name: string, options: { listToolsError?: Error } = {}): McpClientHandle {
	return {
		serverName: name,
		status: { state: "connected", serverName: name },
		listTools: vi.fn(async () => {
			if (options.listToolsError) throw options.listToolsError;
			return [{ name: "search" }];
		}),
		callTool: vi.fn(),
		listResources: vi.fn(),
		readResource: vi.fn(),
		close: vi.fn(),
	};
}

describe("MCP registry bundle", () => {
	it("creates tools for enabled servers and records disabled servers", async () => {
		const clients = new Map<string, McpClientHandle>();
		const bundle = await createMcpRuntimeBundle({
			servers: {
				docs: { type: "http", url: "https://example.com/mcp" },
				off: { type: "sse", url: "https://example.com/sse", enabled: false },
			},
			clientFactory: async (name) => {
				const next = client(name);
				clients.set(name, next);
				return next;
			},
		});

		expect(bundle.tools.map((tool) => tool.name)).toEqual(["mcp__docs__search"]);
		expect(bundle.diagnostics).toMatchObject([
			{ name: "docs", enabled: true, type: "http", failPolicy: "fail", toolCount: 1 },
			{ name: "off", enabled: false, type: "sse", failPolicy: "fail", toolCount: 0 },
		]);
		await bundle.close();
		expect(clients.get("docs")?.close).toHaveBeenCalledOnce();
		expect(clients.has("off")).toBe(false);
	});

	it("closes already connected clients when later required server setup fails", async () => {
		const first = client("first");
		await expect(createMcpRuntimeBundle({
			servers: { first: { type: "stdio", command: "node" }, second: { type: "stdio", command: "node" } },
			clientFactory: async (name) => {
				if (name === "second") throw new Error("boom");
				return first;
			},
		})).rejects.toThrow("boom");
		expect(first.close).toHaveBeenCalledOnce();
	});

	it("skips optional server connection failures", async () => {
		const docs = client("docs");
		const bundle = await createMcpRuntimeBundle({
			servers: { docs: { type: "stdio", command: "node" }, optional: { type: "stdio", command: "node", optional: true } },
			clientFactory: async (name) => {
				if (name === "optional") throw new Error("missing server");
				return docs;
			},
		});

		expect(bundle.tools.map((tool) => tool.name)).toEqual(["mcp__docs__search"]);
		expect(bundle.diagnostics).toMatchObject([
			{ name: "docs", failPolicy: "fail", toolCount: 1 },
			{ name: "optional", failPolicy: "warn", toolCount: 0, errorMessage: "missing server" },
		]);
	});

	it("closes optional clients when tool discovery fails", async () => {
		const flaky = client("flaky", { listToolsError: new Error("list failed") });
		const bundle = await createMcpRuntimeBundle({
			servers: { flaky: { type: "stdio", command: "node", failPolicy: "warn" } },
			clientFactory: async () => flaky,
		});

		expect(bundle.tools).toEqual([]);
		expect(bundle.diagnostics).toMatchObject([{ name: "flaky", failPolicy: "warn", errorMessage: "list failed" }]);
		expect(flaky.close).toHaveBeenCalledOnce();
	});

	it("lets explicit fail policy override optional", async () => {
		await expect(createMcpRuntimeBundle({
			servers: { strict: { type: "stdio", command: "node", optional: true, failPolicy: "fail" } },
			clientFactory: async () => { throw new Error("strict failure"); },
		})).rejects.toThrow("strict failure");
	});
});
