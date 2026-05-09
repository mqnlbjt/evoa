import type { EvolvingAgentTool } from "../tools/types.js";
import { createMcpTools } from "./adapter.js";
import { createMcpClient } from "./client.js";
import { normalizeMcpName } from "./names.js";
import { mcpFailPolicy, type McpClientHandle, type McpConnectionStatus, type McpServerConfig, type McpServerFailPolicy, type McpServersConfig, type McpServerTransportType } from "./types.js";

export interface McpRuntimeBundle {
	tools: EvolvingAgentTool[];
	diagnostics: McpRuntimeServerDiagnostic[];
	close(): Promise<void>;
}

export interface McpRuntimeServerDiagnostic {
	name: string;
	enabled: boolean;
	type: McpServerTransportType;
	failPolicy: McpServerFailPolicy;
	status: McpConnectionStatus | { state: "disabled"; serverName: string };
	toolCount: number;
	resourceHelpersEnabled: boolean;
	errorMessage?: string;
}

export interface CreateMcpRuntimeBundleOptions {
	servers?: McpServersConfig;
	clientFactory?: (serverName: string, config: McpServersConfig[string]) => Promise<McpClientHandle>;
}

export async function createMcpRuntimeBundle(options: CreateMcpRuntimeBundleOptions = {}): Promise<McpRuntimeBundle> {
	const entries = Object.entries(options.servers ?? {});
	if (entries.length === 0) return { tools: [], diagnostics: [], close: async () => {} };
	const clientFactory = options.clientFactory ?? createMcpClient;
	const results = await Promise.allSettled(entries.map(async ([serverName, config]) => {
		const failPolicy = mcpFailPolicy(config);
		if (config.enabled === false) {
			return { diagnostic: disabledDiagnostic(serverName, config, failPolicy), tools: [], client: undefined };
		}
		normalizeMcpName(serverName);
		const client = await clientFactory(serverName, config);
		try {
			const remoteTools = await client.listTools();
			const wrappedTools = createMcpTools({ serverName, client, tools: remoteTools, ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}), ...(config.resources !== undefined ? { resources: config.resources } : {}) });
			return { diagnostic: { name: serverName, enabled: true, type: config.type, failPolicy, status: client.status, toolCount: remoteTools.length, resourceHelpersEnabled: config.resources === true }, tools: wrappedTools, client };
		} catch (error) {
			try { await client.close(); } catch { /* best effort */ }
			throw error;
		}
	}));

	const clients: McpClientHandle[] = [];
	const tools: EvolvingAgentTool[] = [];
	const diagnostics: McpRuntimeServerDiagnostic[] = [];
	let firstError: unknown;

	for (const [i, result] of results.entries()) {
		const [, config] = entries[i]!;
		if (result.status === "fulfilled") {
			if (result.value.client) clients.push(result.value.client);
			tools.push(...result.value.tools);
			diagnostics.push(result.value.diagnostic);
		} else {
			const failPolicy = mcpFailPolicy(config);
			if (failPolicy === "warn") {
				diagnostics.push(failedDiagnostic(entries[i]![0], config, failPolicy, result.reason));
				continue;
			}
			firstError = result.reason;
		}
	}

	if (firstError) {
		await closeBestEffort(clients);
		throw firstError;
	}

	return { tools, diagnostics, close: () => closeClients(clients) };
}

function disabledDiagnostic(serverName: string, config: McpServerConfig, failPolicy: McpServerFailPolicy): McpRuntimeServerDiagnostic {
	return { name: serverName, enabled: false, type: config.type, failPolicy, status: { state: "disabled", serverName }, toolCount: 0, resourceHelpersEnabled: config.resources === true };
}

function failedDiagnostic(serverName: string, config: McpServerConfig, failPolicy: McpServerFailPolicy, error: unknown): McpRuntimeServerDiagnostic {
	const message = errorMessage(error);
	return { name: serverName, enabled: true, type: config.type, failPolicy, status: { state: "failed", serverName, errorMessage: message }, toolCount: 0, resourceHelpersEnabled: config.resources === true, errorMessage: message };
}

async function closeBestEffort(clients: McpClientHandle[]): Promise<void> {
	await Promise.allSettled(clients.map((client) => client.close()));
}

async function closeClients(clients: McpClientHandle[]): Promise<void> {
	const results = await Promise.allSettled(clients.map((client) => client.close()));
	const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (rejected) throw rejected.reason;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
