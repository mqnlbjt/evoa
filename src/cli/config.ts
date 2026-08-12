import { readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServerConfig, McpServerFailPolicy, McpServersConfig } from "../mcp/types.js";
import type { ProviderConfig, ProviderFormat } from "../models/provider-types.js";
import type { ModelPurpose } from "../models/types.js";
import type { ModelRoutingSpec, ModelSpec } from "../specs.js";
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
	copyString(value, "port", defaults);
	copyString(value, "host", defaults);
	copyString(value, "staticDir", defaults);
	copyProviderFormat(value.providerFormat, defaults, diagnostics);
	copyProviders(value.providers, defaults, diagnostics);
	copyModelRouting(value.models, defaults, diagnostics);
	copyToolProfile(value.toolProfile, defaults, diagnostics);
	copyMcpServers(value.mcpServers, defaults, diagnostics);
	return { defaults, diagnostics };
}

type StringDefaultKey = "agentPath" | "provider" | "model" | "baseURL" | "apiKey" | "sessionDir" | "port" | "host" | "staticDir";

function copyString(source: Record<string, unknown>, key: StringDefaultKey, target: CliDefaults): void {
	const value = source[key];
	if (typeof value === "string" && value.length > 0) target[key] = value;
}

function copyProviderFormat(value: unknown, target: CliDefaults, diagnostics: string[]): void {
	if (value === undefined) return;
	if (value === "openai-responses" || value === "openai-chat" || value === "anthropic-messages") {
		target.providerFormat = value;
		return;
	}
	diagnostics.push("config.providerFormat must be openai-responses, openai-chat, or anthropic-messages");
}

function copyProviders(value: unknown, target: CliDefaults, diagnostics: string[]): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		diagnostics.push("config.providers must be an object");
		return;
	}
	const providers: Record<string, ProviderConfig> = {};
	for (const [id, providerValue] of Object.entries(value)) {
		const provider = parseProvider(id, providerValue, diagnostics);
		if (provider) providers[id] = provider;
	}
	if (Object.keys(providers).length > 0) target.providers = providers;
}

function parseProvider(id: string, value: unknown, diagnostics: string[]): ProviderConfig | undefined {
	const prefix = `config.providers.${id}`;
	if (!isRecord(value)) {
		diagnostics.push(`${prefix} must be an object`);
		return undefined;
	}
	const baseURL = optionalString(value.baseURL, `${prefix}.baseURL`, diagnostics);
	const format = providerFormatValue(value.format, `${prefix}.format`, diagnostics);
	const apiKey = optionalString(value.apiKey, `${prefix}.apiKey`, diagnostics);
	const headers = optionalStringRecord(value.headers, `${prefix}.headers`, diagnostics);
	if (!baseURL || !format) return undefined;
	return { id, baseURL, format, ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) };
}

function copyModelRouting(value: unknown, target: CliDefaults, diagnostics: string[]): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		diagnostics.push("config.models must be an object");
		return;
	}
	const aliases = parseModelAliases(value.aliases, diagnostics);
	const routes = parseModelRoutes(value.routes, aliases, diagnostics);
	const defaultAlias = optionalString(value.defaultAlias, "config.models.defaultAlias", diagnostics);
	const purposeRules = parsePurposeRules(value.purposeRules, diagnostics);
	const routing: ModelRoutingSpec = {
		...(aliases && Object.keys(aliases).length > 0 ? { aliases } : {}),
		...(routes && Object.keys(routes).length > 0 ? { routes } : {}),
		...(defaultAlias ? { defaultAlias } : {}),
		...(purposeRules ? { purposeRules } : {}),
	};
	if (Object.keys(routing).length > 0) target.modelRouting = routing;
}

function parseModelAliases(value: unknown, diagnostics: string[]): Record<string, ModelSpec> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		diagnostics.push("config.models.aliases must be an object");
		return undefined;
	}
	const aliases: Record<string, ModelSpec> = {};
	for (const [alias, modelValue] of Object.entries(value)) {
		const model = parseModelSpec(modelValue, `config.models.aliases.${alias}`, diagnostics);
		if (model) aliases[alias] = model;
	}
	return aliases;
}

function parseModelSpec(value: unknown, prefix: string, diagnostics: string[]): ModelSpec | undefined {
	if (!isRecord(value)) {
		diagnostics.push(`${prefix} must be an object`);
		return undefined;
	}
	const provider = requiredString(value.provider, `${prefix}.provider`, diagnostics);
	const model = requiredString(value.model, `${prefix}.model`, diagnostics);
	const reasoningLevel = reasoningLevelValue(value.reasoningLevel, `${prefix}.reasoningLevel`, diagnostics);
	const options = parseModelOptions(value.options, `${prefix}.options`, diagnostics);
	if (!provider || !model) return undefined;
	return { provider, model, ...(reasoningLevel ? { reasoningLevel } : {}), ...(options ? { options } : {}) };
}

function parseModelOptions(value: unknown, prefix: string, diagnostics: string[]): ModelSpec["options"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		diagnostics.push(`${prefix} must be an object`);
		return undefined;
	}
	if (value.reasoning !== undefined) validateReasoningOptions(value.reasoning, `${prefix}.reasoning`, diagnostics);
	return { ...value };
}

function validateReasoningOptions(value: unknown, prefix: string, diagnostics: string[]): void {
	if (!isRecord(value)) {
		diagnostics.push(`${prefix} must be an object`);
		return;
	}
	if (value.mode !== undefined && !["auto", "off", "effort", "provider", "adaptive"].includes(String(value.mode))) diagnostics.push(`${prefix}.mode must be auto, off, effort, provider, or adaptive`);
	if (value.returnContent !== undefined && !["never", "needed", "always"].includes(String(value.returnContent))) diagnostics.push(`${prefix}.returnContent must be never, needed, or always`);
	if (value.sendHistory !== undefined && !["never", "needed", "always"].includes(String(value.sendHistory))) diagnostics.push(`${prefix}.sendHistory must be never, needed, or always`);
	if (value.provider !== undefined) validateReasoningProviderOptions(value.provider, `${prefix}.provider`, diagnostics);
}

function validateReasoningProviderOptions(value: unknown, prefix: string, diagnostics: string[]): void {
	if (!isRecord(value)) {
		diagnostics.push(`${prefix} must be an object`);
		return;
	}
	if (value.style !== undefined && !["openai-responses", "deepseek", "anthropic", "chat-compatible"].includes(String(value.style))) diagnostics.push(`${prefix}.style must be openai-responses, deepseek, anthropic, or chat-compatible`);
	if (value.requestField !== undefined && !["reasoning", "reasoning_effort", "extra_body.reasoning_effort", "extra_body.thinking"].includes(String(value.requestField))) diagnostics.push(`${prefix}.requestField must be reasoning, reasoning_effort, extra_body.reasoning_effort, or extra_body.thinking`);
	if (value.effort !== undefined && (typeof value.effort !== "string" || value.effort.length === 0)) diagnostics.push(`${prefix}.effort must be a non-empty string`);
	if (value.thinkingType !== undefined && !["enabled", "adaptive"].includes(String(value.thinkingType))) diagnostics.push(`${prefix}.thinkingType must be enabled or adaptive`);
}

function parseModelRoutes(value: unknown, aliases: Record<string, ModelSpec> | undefined, diagnostics: string[]): ModelRoutingSpec["routes"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		diagnostics.push("config.models.routes must be an object");
		return undefined;
	}
	const routes: Partial<Record<ModelPurpose, string>> = {};
	for (const [purpose, aliasValue] of Object.entries(value)) {
		if (!isModelPurpose(purpose)) {
			diagnostics.push(`config.models.routes.${purpose} is not a supported model purpose`);
			continue;
		}
		if (typeof aliasValue !== "string" || aliasValue.length === 0) {
			diagnostics.push(`config.models.routes.${purpose} must be a non-empty string`);
			continue;
		}
		if (aliases && aliasValue !== "default" && aliases[aliasValue] === undefined) {
			diagnostics.push(`config.models.routes.${purpose} references unknown alias ${aliasValue}`);
			continue;
		}
		routes[purpose] = aliasValue;
	}
	return routes;
}

function parsePurposeRules(value: unknown, diagnostics: string[]): ModelRoutingSpec["purposeRules"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		diagnostics.push("config.models.purposeRules must be an object");
		return undefined;
	}
	const codingTasks = optionalBoolean(value.codingTasks, "config.models.purposeRules.codingTasks", diagnostics);
	const toolHeavy = optionalBoolean(value.toolHeavy, "config.models.purposeRules.toolHeavy", diagnostics);
	return { ...(codingTasks !== undefined ? { codingTasks } : {}), ...(toolHeavy !== undefined ? { toolHeavy } : {}) };
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

function providerFormatValue(value: unknown, pathName: string, diagnostics: string[]): ProviderFormat | undefined {
	if (value === "openai-responses" || value === "openai-chat" || value === "anthropic-messages") return value;
	diagnostics.push(`${pathName} must be openai-responses, openai-chat, or anthropic-messages`);
	return undefined;
}

function reasoningLevelValue(value: unknown, pathName: string, diagnostics: string[]): ModelSpec["reasoningLevel"] | undefined {
	if (value === undefined) return undefined;
	if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
	diagnostics.push(`${pathName} must be off, minimal, low, medium, high, or xhigh`);
	return undefined;
}

function isModelPurpose(value: string): value is ModelPurpose {
	return ["main", "memory-extraction", "summary", "compaction", "verification", "evolution", "coding", "tool-heavy"].includes(value);
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

function requiredString(value: unknown, pathName: string, diagnostics: string[]): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	diagnostics.push(`${pathName} must be a non-empty string`);
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
