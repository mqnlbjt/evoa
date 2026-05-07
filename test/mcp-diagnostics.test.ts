import { describe, expect, it, vi } from "vitest";
import { diagnoseMcpServers } from "../src/mcp/diagnostics.js";
import type { McpClientHandle } from "../src/mcp/types.js";

function client(name: string, options: { closeError?: Error } = {}): McpClientHandle {
	return {
		serverName: name,
		status: { state: "connected", serverName: name },
		listTools: vi.fn(async () => [{ name: "search", description: "Search docs", inputSchema: { type: "object" } }]),
		callTool: vi.fn(),
		listResources: vi.fn(async () => [{ uri: "file://doc", name: "doc", mimeType: "text/plain" }]),
		readResource: vi.fn(),
		close: vi.fn(async () => {
			if (options.closeError) throw options.closeError;
		}),
	};
}

describe("MCP diagnostics", () => {
	it("reports disabled servers without connecting", async () => {
		const factory = vi.fn();
		const report = await diagnoseMcpServers({ servers: { off: { type: "stdio", command: "node", enabled: false } }, clientFactory: factory });

		expect(report).toMatchObject({ ok: true, summary: { configured: 1, enabled: 0, disabled: 1 } });
		expect(report.servers).toMatchObject([{ name: "off", enabled: false, state: "disabled" }]);
		expect(factory).not.toHaveBeenCalled();
	});

	it("reports connected server tools, qualified names, and resources", async () => {
		const docs = client("docs");
		const report = await diagnoseMcpServers({
			servers: { docs: { type: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "secret" }, resources: true } },
			clientFactory: async () => docs,
			includeDetails: true,
		});

		expect(report.ok).toBe(true);
		expect(report.summary).toMatchObject({ configured: 1, enabled: 1, connected: 1, toolCount: 1 });
		expect(report.servers[0]).toMatchObject({
			name: "docs",
			state: "connected",
			tools: [{ name: "search", qualifiedName: "mcp__docs__search" }],
			resourceCount: 1,
			resources: [{ uri: "file://doc" }],
			envKeys: ["TOKEN"],
		});
		expect(JSON.stringify(report)).not.toContain("secret");
		expect(docs.close).toHaveBeenCalledOnce();
	});

	it("reports HTTP server details without leaking headers", async () => {
		const docs = client("docs");
		const report = await diagnoseMcpServers({
			servers: { docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer secret", "X-Test": "ok" }, resources: true } },
			clientFactory: async () => docs,
			includeDetails: true,
		});

		expect(report.ok).toBe(true);
		expect(report.servers[0]).toMatchObject({
			name: "docs",
			type: "http",
			url: "https://example.com/mcp",
			headerKeys: ["Authorization", "X-Test"],
			tools: [{ name: "search", qualifiedName: "mcp__docs__search" }],
		});
		expect(JSON.stringify(report)).not.toContain("Bearer secret");
	});

	it("treats optional failures as non-blocking", async () => {
		const report = await diagnoseMcpServers({
			servers: { optional: { type: "sse", url: "https://example.com/sse", optional: true } },
			clientFactory: async () => { throw new Error("not installed"); },
		});

		expect(report.ok).toBe(true);
		expect(report.summary).toMatchObject({ failed: 1, optionalFailures: 1, requiredFailures: 0 });
		expect(report.servers).toMatchObject([{ name: "optional", type: "sse", failPolicy: "warn", state: "failed", errorMessage: "not installed" }]);
	});

	it("treats required failures as blocking", async () => {
		const report = await diagnoseMcpServers({
			servers: { required: { type: "stdio", command: "node" } },
			clientFactory: async () => { throw new Error("boom"); },
		});

		expect(report.ok).toBe(false);
		expect(report.summary).toMatchObject({ failed: 1, requiredFailures: 1, optionalFailures: 0 });
	});

	it("records close failures as diagnostics", async () => {
		const docs = client("docs", { closeError: new Error("close failed") });
		const report = await diagnoseMcpServers({ servers: { docs: { type: "stdio", command: "node" } }, clientFactory: async () => docs });

		expect(report.ok).toBe(true);
		expect(report.diagnostics).toEqual(["failed to close MCP server docs: close failed"]);
	});
});
