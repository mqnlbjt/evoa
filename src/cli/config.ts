import { readFile } from "node:fs/promises";
import path from "node:path";
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
