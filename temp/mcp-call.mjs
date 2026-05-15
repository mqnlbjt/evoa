import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "exa-mcp-server"],
  env: { ...process.env, EXA_API_KEY: "577fe2d9-f189-415b-9f2a-8101ea48476f" },
  stderr: "pipe",
});

const client = new Client({ name: "test-call", version: "0.1.0" });

try {
  console.log("Connecting to exa MCP server...");
  await client.connect(transport);
  console.log("Connected!\n");

  // 1. List available tools
  console.log("=== Available Tools ===");
  const toolsResult = await client.listTools();
  for (const tool of toolsResult.tools) {
    console.log(`  - ${tool.name}: ${tool.description ?? "(no description)"}`);
  }
  console.log();

  // 2. Call the web_search tool
  console.log("=== Calling web_search ===");
  const result = await client.callTool({
    name: "web_search_exa",
    arguments: { query: "MCP model context protocol", numResults: 3 },
  });
  console.log(JSON.stringify(result, null, 2).slice(0, 2000));

} catch (err) {
  console.error("Error:", err.message);
} finally {
  await client.close();
  console.log("\nDone.");
}
