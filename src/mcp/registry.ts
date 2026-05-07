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
	const clients: McpClientHandle[] = [];
	const tools: EvolvingAgentTool[] = [];
	const diagnostics: McpRuntimeServerDiagnostic[] = [];
	const clientFactory = options.clientFactory ?? createMcpClient;
	for (const [serverName, config] of entries) {
		const failPolicy = mcpFailPolicy(config);
		if (config.enabled === false) {
			diagnostics.push(disabledDiagnostic(serverName, config, failPolicy));
			continue;
		}
		let client: McpClientHandle | undefined;
		try {
			normalizeMcpName(serverName);
			client = await clientFactory(serverName, config);
			const remoteTools = await client.listTools();
			const wrappedTools = createMcpTools({ serverName, client, tools: remoteTools, ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}), ...(config.resources !== undefined ? { resources: config.resources } : {}) });
			clients.push(client);
			tools.push(...wrappedTools);
			diagnostics.push({ name: serverName, enabled: true, type: config.type, failPolicy, status: client.status, toolCount: remoteTools.length, resourceHelpersEnabled: config.resources === true });
		} catch (error) {
			if (client) await closeBestEffort([client]);
			if (failPolicy === "warn") {
				diagnostics.push(failedDiagnostic(serverName, config, failPolicy, error));
				continue;
			}
			await closeBestEffort(clients);
			throw error;
		}
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
