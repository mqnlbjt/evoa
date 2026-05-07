import { readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServerConfig, McpServerFailPolicy, McpServersConfig } from "../mcp/types.js";
import { parseToolProfile } from "../tools/profiles.js";
import type { CliDefaults } from "./args.js";

export interface CliConfigLoadResult {
	defaults: CliDefaults;
	diagnostics: string[];
}

export async function loadCliDefaults(configPath: string | undefined, cwd = process.cwd()): Promise<CliConfigLoadResult> {
	const pathToRead = configPath ?? path.join(cwd, ".evolving-agent", "config.json");
	try {
		return parseCliDefaults(JSON.parse(await readFile(pathToRead, "utf8")));
	} catch (error) {
		if (!configPath && isNotFound(error)) return { defaults: {}, diagnostics: [] };
		return { defaults: {}, diagnostics: [`failed to load config ${pathToRead}: ${errorMessage(error)}`] };
	}
}

export function parseCliDefaults(value: unknown): CliConfigLoadResult {
	const diagnostics: string[] = [];
	if (!isRecord(value)) return { defaults: {}, diagnostics: ["config must be an object"] };

	const defaults: CliDefaults = {};
	copyString(value, "agentPath", defaults);
	copyString(value, "provider", defaults);
	copyString(value, "model", defaults);
	copyString(value, "baseURL", defaults);
	copyString(value, "apiKey", defaults);
	copyString(value, "sessionDir", defaults);
	copyProviderFormat(value.providerFormat, defaults, diagnostics);
	copyToolProfile(value.toolProfile, defaults, diagnostics);
	copyMcpServers(value.mcpServers, defaults, diagnostics);
	return { defaults, diagnostics };
}

type StringDefaultKey = "agentPath" | "provider" | "model" | "baseURL" | "apiKey" | "sessionDir";

function copyString(source: Record<string, unknown>, key: StringDefaultKey, target: CliDefaults): void {
	const value = source[key];
	if (typeof value === "string" && value.length > 0) target[key] = value;
}

function copyProviderFormat(value: unknown, target: CliDefaults, diagnostics: string[]): void {
	if (value === undefined) return;
	if (value === "openai-responses" || value === "anthropic-messages") {
		target.providerFormat = value;
		return;
	}
	diagnostics.push("config.providerFormat must be openai-responses or anthropic-messages");
}

function copyToolProfile(value: unknown, target: CliDefaults, diagnostics: string[]): void {
	if (value === undefined) return;
	if (typeof value !== "string") {
		diagnostics.push("config.toolProfile must be a string");
		return;
	}
	const profile = parseToolProfile(value);
	if (profile) {
		target.toolProfile = profile;
		return;
	}
	diagnostics.push("config.toolProfile must be read-only, coding, benchmark-sandbox, or dangerous");
}

function copyMcpServers(value: unknown, target: CliDefaults, diagnostics: string[]): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		diagnostics.push("config.mcpServers must be an object");
		return;
	}
	const servers: McpServersConfig = {};
	for (const [name, serverValue] of Object.entries(value)) {
		const server = parseMcpServer(name, serverValue, diagnostics);
		if (server) servers[name] = server;
	}
	if (Object.keys(servers).length > 0) target.mcpServers = servers;
}

function parseMcpServer(name: string, value: unknown, diagnostics: string[]): McpServerConfig | undefined {
	const prefix = `config.mcpServers.${name}`;
	if (!isRecord(value)) {
		diagnostics.push(`${prefix} must be an object`);
		return undefined;
	}
	if (value.type !== "stdio" && value.type !== "http" && value.type !== "sse") {
		diagnostics.push(`${prefix}.type must be stdio, http, or sse`);
		return undefined;
	}
	const common = parseMcpCommon(value, prefix, diagnostics);
	if (value.type === "stdio") return parseStdioMcpServer(value, prefix, diagnostics, common);
	return parseRemoteMcpServer(value, value.type, prefix, diagnostics, common);
}

type McpCommonFields = Pick<McpServerConfig, "timeoutMs" | "enabled" | "resources" | "optional" | "failPolicy">;

function parseMcpCommon(value: Record<string, unknown>, prefix: string, diagnostics: string[]): McpCommonFields {
	const timeoutMs = optionalPositiveNumber(value.timeoutMs, `${prefix}.timeoutMs`, diagnostics);
	const enabled = optionalBoolean(value.enabled, `${prefix}.enabled`, diagnostics);
	const resources = optionalBoolean(value.resources, `${prefix}.resources`, diagnostics);
	const optional = optionalBoolean(value.optional, `${prefix}.optional`, diagnostics);
	const failPolicy = optionalFailPolicy(value.failPolicy, `${prefix}.failPolicy`, diagnostics);
	return { ...(timeoutMs ? { timeoutMs } : {}), ...(enabled !== undefined ? { enabled } : {}), ...(resources !== undefined ? { resources } : {}), ...(optional !== undefined ? { optional } : {}), ...(failPolicy ? { failPolicy } : {}) };
}

function parseStdioMcpServer(value: Record<string, unknown>, prefix: string, diagnostics: string[], common: McpCommonFields): McpServerConfig | undefined {
	if (typeof value.command !== "string" || value.command.length === 0) diagnostics.push(`${prefix}.command must be a non-empty string`);
	const args = optionalStringArray(value.args, `${prefix}.args`, diagnostics);
	const env = optionalStringRecord(value.env, `${prefix}.env`, diagnostics);
	const cwd = optionalString(value.cwd, `${prefix}.cwd`, diagnostics);
	if (typeof value.command !== "string" || value.command.length === 0) return undefined;
	return { type: "stdio", command: value.command, ...(args ? { args } : {}), ...(env ? { env } : {}), ...(cwd ? { cwd } : {}), ...common };
}

function parseRemoteMcpServer(value: Record<string, unknown>, type: "http" | "sse", prefix: string, diagnostics: string[], common: McpCommonFields): McpServerConfig | undefined {
	const url = requiredHttpUrl(value.url, `${prefix}.url`, diagnostics);
	const headers = optionalStringRecord(value.headers, `${prefix}.headers`, diagnostics);
	if (!url) return undefined;
	return { type, url, ...(headers ? { headers } : {}), ...common };
}

function requiredHttpUrl(value: unknown, pathName: string, diagnostics: string[]): string | undefined {
	if (typeof value !== "string" || value.length === 0) {
		diagnostics.push(`${pathName} must be an http(s) URL`);
		return undefined;
	}
	try {
		const url = new URL(value);
		if (url.protocol === "http:" || url.protocol === "https:") return value;
	} catch {
		// fall through
	}
	diagnostics.push(`${pathName} must be an http(s) URL`);
	return undefined;
}

function optionalString(value: unknown, pathName: string, diagnostics: string[]): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && value.length > 0) return value;
	diagnostics.push(`${pathName} must be a non-empty string`);
	return undefined;
}

function optionalStringArray(value: unknown, pathName: string, diagnostics: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
	diagnostics.push(`${pathName} must be an array of strings`);
	return undefined;
}

function optionalStringRecord(value: unknown, pathName: string, diagnostics: string[]): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (isRecord(value) && Object.values(value).every((item) => typeof item === "string")) return value as Record<string, string>;
	diagnostics.push(`${pathName} must be an object with string values`);
	return undefined;
}

function optionalPositiveNumber(value: unknown, pathName: string, diagnostics: string[]): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	diagnostics.push(`${pathName} must be a positive number`);
	return undefined;
}

function optionalBoolean(value: unknown, pathName: string, diagnostics: string[]): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	diagnostics.push(`${pathName} must be a boolean`);
	return undefined;
}

function optionalFailPolicy(value: unknown, pathName: string, diagnostics: string[]): McpServerFailPolicy | undefined {
	if (value === undefined) return undefined;
	if (value === "fail" || value === "warn") return value;
	diagnostics.push(`${pathName} must be fail or warn`);
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
