import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	CallToolResultSchema,
	type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type {
	Transport,
	TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { EventSourceInit } from "eventsource";
import type {
	McpClientHandle,
	McpConnectionStatus,
	McpHttpServerConfig,
	McpResourceDescriptor,
	McpServerConfig,
	McpSseServerConfig,
	McpStdioServerConfig,
	McpToolDescriptor,
} from "./types.js";

const clientVersion = "0.1.0";

export async function createMcpClient(
	serverName: string,
	config: McpServerConfig,
): Promise<McpClientHandle> {
	if (config.type === "stdio") return createStdioMcpClient(serverName, config);
	if (config.type === "http") return createHttpMcpClient(serverName, config);
	return createSseMcpClient(serverName, config);
}

export async function createStdioMcpClient(
	serverName: string,
	config: McpStdioServerConfig,
): Promise<McpClientHandle> {
	const handle = new SdkMcpClient(
		serverName,
		config.timeoutMs,
		new StdioClientTransport({
			command: config.command,
			...(config.args ? { args: config.args } : {}),
			...(config.cwd ? { cwd: config.cwd } : {}),
			...(config.env
				? { env: { ...process.env, ...config.env } as Record<string, string> }
				: {}),
			stderr: "pipe",
		}),
	);
	await handle.connect();
	return handle;
}

export async function createHttpMcpClient(
	serverName: string,
	config: McpHttpServerConfig,
): Promise<McpClientHandle> {
	const handle = new SdkMcpClient(
		serverName,
		config.timeoutMs,
		transportAdapter(
			new StreamableHTTPClientTransport(
				new URL(config.url),
				remoteRequestOptions(config),
			),
		),
	);
	await handle.connect();
	return handle;
}

export async function createSseMcpClient(
	serverName: string,
	config: McpSseServerConfig,
): Promise<McpClientHandle> {
	const handle = new SdkMcpClient(
		serverName,
		config.timeoutMs,
		new SSEClientTransport(new URL(config.url), sseTransportOptions(config)),
	);
	await handle.connect();
	return handle;
}

class SdkMcpClient implements McpClientHandle {
	private readonly client = new Client({
		name: "evoa",
		version: clientVersion,
	});
	private currentStatus: McpConnectionStatus = { state: "idle" };

	constructor(
		readonly serverName: string,
		private readonly timeoutMs: number | undefined,
		private readonly transport: Transport,
	) {}

	get status(): McpConnectionStatus {
		return this.currentStatus;
	}

	async connect(): Promise<void> {
		this.currentStatus = { state: "connecting", serverName: this.serverName };
		try {
			await this.client.connect(this.transport, requestOptions(this.timeoutMs));
			this.currentStatus = { state: "connected", serverName: this.serverName };
		} catch (error) {
			this.currentStatus = {
				state: "failed",
				serverName: this.serverName,
				errorMessage: errorMessage(error),
			};
			throw new Error(
				`failed to connect MCP server ${this.serverName}: ${errorMessage(error)}`,
			);
		}
	}

	async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
		const tools: McpToolDescriptor[] = [];
		let cursor: string | undefined;
		do {
			const result = await this.client.listTools(
				cursor ? { cursor } : undefined,
				requestOptions(this.timeoutMs, signal),
			);
			for (const tool of result.tools) {
				tools.push({
					name: tool.name,
					...(tool.description ? { description: tool.description } : {}),
					inputSchema: tool.inputSchema,
				});
			}
			cursor = result.nextCursor;
		} while (cursor);
		return tools;
	}

	async callTool(
		name: string,
		input: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.client.callTool(
			{ name, arguments: isRecord(input) ? input : {} },
			CallToolResultSchema,
			requestOptions(this.timeoutMs, signal),
		);
	}

	async listResources(signal?: AbortSignal): Promise<McpResourceDescriptor[]> {
		const resources: McpResourceDescriptor[] = [];
		let cursor: string | undefined;
		do {
			const result = await this.client.listResources(
				cursor ? { cursor } : undefined,
				requestOptions(this.timeoutMs, signal),
			);
			for (const resource of result.resources) {
				resources.push({
					uri: resource.uri,
					name: resource.name,
					...(resource.description
						? { description: resource.description }
						: {}),
					...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
				});
			}
			cursor = result.nextCursor;
		} while (cursor);
		return resources;
	}

	async readResource(uri: string, signal?: AbortSignal): Promise<unknown> {
		return this.client.readResource(
			{ uri },
			requestOptions(this.timeoutMs, signal),
		);
	}

	async close(): Promise<void> {
		await this.client.close();
		this.currentStatus = { state: "closed", serverName: this.serverName };
	}
}

function transportAdapter(transport: StreamableHTTPClientTransport): Transport {
	const adapter: Transport = {
		start: () => transport.start(),
		send: (message: JSONRPCMessage, options?: TransportSendOptions) =>
			transport.send(message, options),
		close: () => transport.close(),
		setProtocolVersion: (version) => transport.setProtocolVersion(version),
	};
	Object.defineProperty(adapter, "sessionId", {
		get: () => transport.sessionId,
		enumerable: true,
	});
	Object.defineProperty(adapter, "onclose", {
		get: () => transport.onclose,
		set: (handler: (() => void) | undefined) => {
			setOptional(transport, "onclose", handler);
		},
		enumerable: true,
	});
	Object.defineProperty(adapter, "onerror", {
		get: () => transport.onerror,
		set: (handler: ((error: Error) => void) | undefined) => {
			setOptional(transport, "onerror", handler);
		},
		enumerable: true,
	});
	Object.defineProperty(adapter, "onmessage", {
		get: () => transport.onmessage,
		set: (handler: ((message: JSONRPCMessage) => void) | undefined) => {
			setOptional(transport, "onmessage", handler);
		},
		enumerable: true,
	});
	return adapter;
}

function setOptional<T extends object, K extends keyof T>(
	target: T,
	key: K,
	value: T[K] | undefined,
): void {
	if (value === undefined) delete target[key];
	else target[key] = value;
}

function remoteRequestOptions(
	config: McpHttpServerConfig | McpSseServerConfig,
): { requestInit?: RequestInit } | undefined {
	if (!config.headers) return undefined;
	return { requestInit: { headers: new Headers(config.headers) } };
}

function sseTransportOptions(
	config: McpSseServerConfig,
):
	| { requestInit?: RequestInit; eventSourceInit?: EventSourceInit }
	| undefined {
	if (!config.headers) return undefined;
	return {
		requestInit: { headers: new Headers(config.headers) },
		eventSourceInit: {
			fetch: (url, init) =>
				fetch(url, { ...init, headers: new Headers(config.headers) }),
		},
	};
}

function requestOptions(timeoutMs: number | undefined, signal?: AbortSignal) {
	return {
		...(timeoutMs ? { timeout: timeoutMs } : {}),
		...(signal ? { signal } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
