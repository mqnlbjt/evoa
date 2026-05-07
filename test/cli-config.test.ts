import { describe, expect, it } from "vitest";
import { parseCliDefaults } from "../src/cli/config.js";

describe("parseCliDefaults", () => {
	it("parses supported CLI defaults", () => {
		const result = parseCliDefaults({
			agentPath: "agent.json",
			provider: "local",
			model: "model",
			baseURL: "url",
			apiKey: "key",
			providerFormat: "anthropic-messages",
			toolProfile: "coding",
			sessionDir: "sessions",
			mcpServers: {
				docs: {
					type: "stdio",
					command: "node",
					args: ["server.js"],
					env: { DOCS_ROOT: "docs" },
					cwd: ".",
					timeoutMs: 1000,
					enabled: true,
					resources: true,
					optional: true,
					failPolicy: "warn",
				},
				remote: {
					type: "http",
					url: "https://example.com/mcp",
					headers: { Authorization: "Bearer token" },
					timeoutMs: 2000,
					resources: true,
				},
				legacy: {
					type: "sse",
					url: "http://localhost:3000/sse",
					headers: { "X-API-Key": "key" },
				},
			},
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.defaults).toEqual({
			agentPath: "agent.json",
			provider: "local",
			model: "model",
			baseURL: "url",
			apiKey: "key",
			providerFormat: "anthropic-messages",
			toolProfile: "coding",
			sessionDir: "sessions",
			mcpServers: {
				docs: {
					type: "stdio",
					command: "node",
					args: ["server.js"],
					env: { DOCS_ROOT: "docs" },
					cwd: ".",
					timeoutMs: 1000,
					enabled: true,
					resources: true,
					optional: true,
					failPolicy: "warn",
				},
				remote: {
					type: "http",
					url: "https://example.com/mcp",
					headers: { Authorization: "Bearer token" },
					timeoutMs: 2000,
					resources: true,
				},
				legacy: {
					type: "sse",
					url: "http://localhost:3000/sse",
					headers: { "X-API-Key": "key" },
				},
			},
		});
	});

	it("reports invalid config values", () => {
		const result = parseCliDefaults({ providerFormat: "wat", toolProfile: "wat" });

		expect(result.defaults).toEqual({});
		expect(result.diagnostics).toEqual([
			"config.providerFormat must be openai-responses or anthropic-messages",
			"config.toolProfile must be read-only, coding, benchmark-sandbox, or dangerous",
		]);
	});

	it("reports invalid MCP server config values", () => {
		const result = parseCliDefaults({
			mcpServers: {
				badType: { type: "websocket" },
				badStdio: { type: "stdio", command: "", args: ["ok", 1], env: { TOKEN: 1 }, cwd: 1 },
				badRemote: { type: "http", url: "file:///tmp/server", headers: { TOKEN: 1 }, timeoutMs: 0, enabled: "yes", resources: "yes", optional: "yes", failPolicy: "ignore" },
			},
		});

		expect(result.defaults).toEqual({});
		expect(result.diagnostics).toEqual([
			"config.mcpServers.badType.type must be stdio, http, or sse",
			"config.mcpServers.badStdio.command must be a non-empty string",
			"config.mcpServers.badStdio.args must be an array of strings",
			"config.mcpServers.badStdio.env must be an object with string values",
			"config.mcpServers.badStdio.cwd must be a non-empty string",
			"config.mcpServers.badRemote.timeoutMs must be a positive number",
			"config.mcpServers.badRemote.enabled must be a boolean",
			"config.mcpServers.badRemote.resources must be a boolean",
			"config.mcpServers.badRemote.optional must be a boolean",
			"config.mcpServers.badRemote.failPolicy must be fail or warn",
			"config.mcpServers.badRemote.url must be an http(s) URL",
			"config.mcpServers.badRemote.headers must be an object with string values",
		]);
	});
});
