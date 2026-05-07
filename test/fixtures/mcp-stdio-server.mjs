import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "smoke", version: "1.0.0" });

server.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async (input) => ({
	content: [{ type: "text", text: input.text }],
}));

await server.connect(new StdioServerTransport());
