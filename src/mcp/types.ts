export type McpServerFailPolicy = "fail" | "warn";

export type McpServerTransportType = "stdio" | "http" | "sse";

export interface McpServerCommonConfig {
	timeoutMs?: number;
	enabled?: boolean;
	resources?: boolean;
	optional?: boolean;
	failPolicy?: McpServerFailPolicy;
}

export interface McpStdioServerConfig extends McpServerCommonConfig {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface McpHttpServerConfig extends McpServerCommonConfig {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

export interface McpSseServerConfig extends McpServerCommonConfig {
	type: "sse";
	url: string;
	headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export type McpServersConfig = Record<string, McpServerConfig>;

export function mcpFailPolicy(config: McpServerConfig): McpServerFailPolicy {
	return config.failPolicy ?? (config.optional === true ? "warn" : "fail");
}

export type McpConnectionStatus =
	| { state: "idle" }
	| { state: "connecting"; serverName: string }
	| { state: "connected"; serverName: string }
	| { state: "failed"; serverName: string; errorMessage: string }
	| { state: "closed"; serverName: string };

export interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpResourceDescriptor {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

export interface McpClientHandle {
	readonly serverName: string;
	readonly status: McpConnectionStatus;
	listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]>;
	callTool(name: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
	listResources(signal?: AbortSignal): Promise<McpResourceDescriptor[]>;
	readResource(uri: string, signal?: AbortSignal): Promise<unknown>;
	close(): Promise<void>;
}
