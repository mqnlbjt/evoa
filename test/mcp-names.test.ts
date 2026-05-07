import { describe, expect, it } from "vitest";
import { normalizeMcpName, parseQualifiedMcpToolName, qualifiedMcpToolName } from "../src/mcp/names.js";

describe("MCP tool names", () => {
	it("normalizes server and tool names", () => {
		expect(normalizeMcpName("docs server")).toBe("docs_server");
		expect(qualifiedMcpToolName("docs server", "query.docs")).toBe("mcp__docs_server__query_docs");
	});

	it("rejects empty normalized names", () => {
		expect(() => normalizeMcpName("***")).toThrow("empty");
	});

	it("parses qualified MCP tool names", () => {
		expect(parseQualifiedMcpToolName("mcp__docs__search")).toEqual({ serverName: "docs", toolName: "search" });
		expect(parseQualifiedMcpToolName("read_file")).toBeUndefined();
	});
});
