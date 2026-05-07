import { createMcpClient } from "./client.js";
import { qualifiedMcpToolName } from "./names.js";
import { mcpFailPolicy, type McpClientHandle, type McpResourceDescriptor, type McpServerFailPolicy, type McpServersConfig, type McpServerTransportType, type McpToolDescriptor } from "./types.js";

export interface McpDiagnosticsOptions {
	servers?: McpServersConfig;
	clientFactory?: (serverName: string, config: McpServersConfig[string]) => Promise<McpClientHandle>;
	includeDetails?: boolean;
}

export interface McpDiagnosticsReport {
	ok: boolean;
	summary: McpDiagnosticsSummary;
	servers: McpServerDiagnostic[];
	diagnostics: string[];
}

export interface McpDiagnosticsSummary {
	configured: number;
	enabled: number;
	disabled: number;
	connected: number;
	failed: number;
	requiredFailures: number;
	optionalFailures: number;
	toolCount: number;
}

export interface McpServerDiagnostic {
	name: string;
	enabled: boolean;
	type: McpServerTransportType;
	failPolicy: McpServerFailPolicy;
	state: "disabled" | "connected" | "failed" | "idle" | "connecting" | "closed";
	toolCount: number;
	resourcesEnabled: boolean;
	command?: string;
	args?: string[];
	cwd?: string;
	url?: string;
	timeoutMs?: number;
	envKeys?: string[];
	headerKeys?: string[];
	tools?: McpDiagnosticTool[];
	resourceCount?: number;
	resources?: McpResourceDescriptor[];
	errorMessage?: string;
}

export interface McpDiagnosticTool extends McpToolDescriptor {
	qualifiedName: string;
}

export async function diagnoseMcpServers(options: McpDiagnosticsOptions = {}): Promise<McpDiagnosticsReport> {
	const servers = Object.entries(options.servers ?? {});
	const clientFactory = options.clientFactory ?? createMcpClient;
	const report: McpDiagnosticsReport = { ok: true, summary: emptySummary(servers.length), servers: [], diagnostics: [] };
	for (const [name, config] of servers) {
		const failPolicy = mcpFailPolicy(config);
		if (config.enabled === false) {
			report.servers.push(disabledServer(name, config, failPolicy, options.includeDetails === true));
			continue;
		}
		report.summary.enabled += 1;
		let client: McpClientHandle | undefined;
		try {
			client = await clientFactory(name, config);
			const tools = await client.listTools();
			const resources = config.resources === true ? await client.listResources() : [];
			report.summary.connected += 1;
			report.summary.toolCount += tools.length;
			report.servers.push(connectedServer(name, config, failPolicy, client, tools, resources, options.includeDetails === true));
		} catch (error) {
			recordFailure(report, name, config, failPolicy, error, options.includeDetails === true);
		} finally {
			if (client) await closeClient(name, client, report.diagnostics);
		}
	}
	report.summary.disabled = report.servers.filter((server) => !server.enabled).length;
	report.summary.failed = report.summary.requiredFailures + report.summary.optionalFailures;
	report.ok = report.summary.requiredFailures === 0;
	return report;
}

function emptySummary(configured: number): McpDiagnosticsSummary {
	return { configured, enabled: 0, disabled: 0, connected: 0, failed: 0, requiredFailures: 0, optionalFailures: 0, toolCount: 0 };
}

function disabledServer(name: string, config: McpServersConfig[string], failPolicy: McpServerFailPolicy, includeDetails: boolean): McpServerDiagnostic {
	return { name, enabled: false, type: config.type, failPolicy, state: "disabled", toolCount: 0, resourcesEnabled: config.resources === true, ...configDetails(config, includeDetails) };
}

function connectedServer(name: string, config: McpServersConfig[string], failPolicy: McpServerFailPolicy, client: McpClientHandle, tools: McpToolDescriptor[], resources: McpResourceDescriptor[], includeDetails: boolean): McpServerDiagnostic {
	return {
		name,
		enabled: true,
		type: config.type,
		failPolicy,
		state: client.status.state,
		toolCount: tools.length,
		resourcesEnabled: config.resources === true,
		...(includeDetails ? { tools: tools.map((tool) => ({ ...tool, qualifiedName: qualifiedMcpToolName(name, tool.name) })) } : {}),
		...(config.resources === true ? { resourceCount: resources.length } : {}),
		...(includeDetails && config.resources === true ? { resources } : {}),
		...configDetails(config, includeDetails),
	};
}

function recordFailure(report: McpDiagnosticsReport, name: string, config: McpServersConfig[string], failPolicy: McpServerFailPolicy, error: unknown, includeDetails: boolean): void {
	const message = errorMessage(error);
	if (failPolicy === "warn") report.summary.optionalFailures += 1;
	else report.summary.requiredFailures += 1;
	report.servers.push({
		name,
		enabled: true,
		type: config.type,
		failPolicy,
		state: "failed",
		toolCount: 0,
		resourcesEnabled: config.resources === true,
		errorMessage: message,
		...configDetails(config, includeDetails),
	});
}

function configDetails(config: McpServersConfig[string], includeDetails: boolean): Partial<McpServerDiagnostic> {
	if (!includeDetails) return {};
	if (config.type === "stdio") {
		return {
			command: config.command,
			...(config.args ? { args: config.args } : {}),
			...(config.cwd ? { cwd: config.cwd } : {}),
			...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
			...(config.env ? { envKeys: Object.keys(config.env).sort() } : {}),
		};
	}
	return {
		url: config.url,
		...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
		...(config.headers ? { headerKeys: Object.keys(config.headers).sort() } : {}),
	};
}

async function closeClient(name: string, client: McpClientHandle, diagnostics: string[]): Promise<void> {
	try {
		await client.close();
	} catch (error) {
		diagnostics.push(`failed to close MCP server ${name}: ${errorMessage(error)}`);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
