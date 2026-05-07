import type { EvolvingAgentTool } from "../tools/types.js";
import { normalizeMcpName, qualifiedMcpToolName } from "./names.js";
import { normalizeMcpResourceResult, normalizeMcpToolResult } from "./result.js";
import type { McpClientHandle, McpToolDescriptor } from "./types.js";

export interface CreateMcpToolsOptions {
	serverName: string;
	client: McpClientHandle;
	tools: McpToolDescriptor[];
	timeoutMs?: number;
	resources?: boolean;
}

export function createMcpTools(options: CreateMcpToolsOptions): EvolvingAgentTool[] {
	assertUniqueToolNames(options.serverName, options.tools);
	const tools = options.tools.map((tool) => createMcpTool(options, tool));
	if (options.resources) tools.push(createResourcesListTool(options), createResourceReadTool(options));
	return tools;
}

function createMcpTool(options: CreateMcpToolsOptions, tool: McpToolDescriptor): EvolvingAgentTool {
	return {
		name: qualifiedMcpToolName(options.serverName, tool.name),
		description: tool.description ?? `MCP tool ${tool.name} from ${options.serverName}`,
		inputSchema: tool.inputSchema,
		permission: { defaultDecision: "allow", riskLevel: "medium" },
		concurrency: "sequential",
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
		metadata: { kind: "mcp", serverName: options.serverName, remoteToolName: tool.name },
		async execute(input, signal) {
			return normalizeMcpToolResult(await options.client.callTool(tool.name, input ?? {}, signal));
		},
	};
}

function createResourcesListTool(options: CreateMcpToolsOptions): EvolvingAgentTool {
	return {
		name: qualifiedMcpToolName(options.serverName, "resources_list"),
		description: `List MCP resources exposed by ${options.serverName}`,
		inputSchema: emptyObjectSchema(),
		permission: { defaultDecision: "allow", riskLevel: "medium" },
		concurrency: "sequential",
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
		metadata: { kind: "mcp_resource", serverName: options.serverName, remoteToolName: "resources/list" },
		async execute(_input, signal) {
			return { resources: await options.client.listResources(signal) };
		},
	};
}

function createResourceReadTool(options: CreateMcpToolsOptions): EvolvingAgentTool {
	return {
		name: qualifiedMcpToolName(options.serverName, "resource_read"),
		description: `Read a text MCP resource exposed by ${options.serverName}`,
		inputSchema: {
			type: "object",
			properties: { uri: { type: "string" } },
			required: ["uri"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "medium" },
		concurrency: "sequential",
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
		metadata: { kind: "mcp_resource", serverName: options.serverName, remoteToolName: "resources/read" },
		async execute(input, signal) {
			const uri = readUri(input);
			return normalizeMcpResourceResult(await options.client.readResource(uri, signal));
		},
	};
}

function assertUniqueToolNames(serverName: string, tools: McpToolDescriptor[]): void {
	const seen = new Map<string, string>();
	for (const tool of tools) {
		const normalized = normalizeMcpName(tool.name);
		const existing = seen.get(normalized);
		if (existing) throw new Error(`MCP server ${serverName} has tool name collision after normalization: ${existing} and ${tool.name}`);
		seen.set(normalized, tool.name);
	}
}

function readUri(input: unknown): string {
	if (typeof input === "object" && input !== null && !Array.isArray(input) && typeof (input as { uri?: unknown }).uri === "string") return (input as { uri: string }).uri;
	throw new Error("resource_read requires input.uri");
}

function emptyObjectSchema(): Record<string, unknown> {
	return { type: "object", properties: {}, additionalProperties: false };
}
