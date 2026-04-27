import { constants } from "node:fs";
import { access, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { EvolvingAgentTool } from "./types.js";
import { ToolRegistry } from "./registry.js";

export interface ReadOnlyToolOptions {
	workspaceRoot: string;
	maxFileBytes?: number;
	maxDirEntries?: number;
	maxSearchResults?: number;
	maxGrepMatches?: number;
}

interface ResolvedOptions {
	workspaceRoot: string;
	maxFileBytes: number;
	maxDirEntries: number;
	maxSearchResults: number;
	maxGrepMatches: number;
}

const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage"]);

export function createReadOnlyToolRegistry(options: ReadOnlyToolOptions): ToolRegistry {
	return new ToolRegistry(createReadOnlyTools(options));
}

export function createReadOnlyTools(options: ReadOnlyToolOptions): EvolvingAgentTool[] {
	const resolved = resolveOptions(options);
	return [
		readFileTool(resolved),
		listDirTool(resolved),
		findFilesTool(resolved),
		grepTool(resolved),
	];
}

function readFileTool(options: ResolvedOptions): EvolvingAgentTool {
	return {
		name: "read_file",
		description: "Read a UTF-8 text file inside the workspace root.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string" },
				encoding: { type: "string", enum: ["utf-8"] },
			},
			required: ["path"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "low" },
		concurrency: "parallel-safe",
		timeoutMs: 5_000,
		async execute(input, signal) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const target = await resolveExistingInsideRoot(options.workspaceRoot, stringField(parsed, "path"));
			throwIfAborted(signal);
			const info = await stat(target);
			if (!info.isFile()) throw new Error("Path is not a file");
			if (info.size > options.maxFileBytes) throw new Error("File is too large");
			return {
				path: relativePath(options.workspaceRoot, target),
				content: await readTextFile(target, signal),
				sizeBytes: info.size,
			};
		},
	};
}

function listDirTool(options: ResolvedOptions): EvolvingAgentTool {
	return {
		name: "list_dir",
		description: "List entries in a directory inside the workspace root.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "low" },
		concurrency: "parallel-safe",
		timeoutMs: 5_000,
		async execute(input, signal) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const target = await resolveExistingInsideRoot(options.workspaceRoot, stringField(parsed, "path"));
			throwIfAborted(signal);
			const info = await stat(target);
			if (!info.isDirectory()) throw new Error("Path is not a directory");
			const entries = (await readdir(target, { withFileTypes: true }))
				.sort((left, right) => left.name.localeCompare(right.name))
				.map((entry) => ({ name: entry.name, type: direntType(entry) }));
			return {
				path: relativePath(options.workspaceRoot, target),
				entries: entries.slice(0, options.maxDirEntries),
				truncated: entries.length > options.maxDirEntries,
			};
		},
	};
}

function findFilesTool(options: ResolvedOptions): EvolvingAgentTool {
	return {
		name: "find_files",
		description: "Find files by glob pattern inside the workspace root.",
		inputSchema: {
			type: "object",
			properties: {
				pattern: { type: "string" },
				path: { type: "string" },
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "low" },
		concurrency: "parallel-safe",
		timeoutMs: 10_000,
		async execute(input, signal) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const pattern = stringField(parsed, "pattern");
			const start = await resolveExistingInsideRoot(options.workspaceRoot, optionalStringField(parsed, "path") ?? ".");
			throwIfAborted(signal);
			const info = await stat(start);
			if (!info.isDirectory()) throw new Error("Path is not a directory");
			const matcher = globMatcher(pattern);
			const matches: string[] = [];
			await walkFiles(options, start, async (file) => {
				throwIfAborted(signal);
				const relative = relativePath(options.workspaceRoot, file);
				if (matcher(relative)) matches.push(relative);
				return matches.length >= options.maxSearchResults;
			}, signal);
			return { root: relativePath(options.workspaceRoot, start), pattern, matches, truncated: matches.length >= options.maxSearchResults };
		},
	};
}

function grepTool(options: ResolvedOptions): EvolvingAgentTool {
	return {
		name: "grep",
		description: "Search file contents with a JavaScript regular expression inside the workspace root.",
		inputSchema: {
			type: "object",
			properties: {
				pattern: { type: "string" },
				path: { type: "string" },
				caseInsensitive: { type: "boolean" },
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "low" },
		concurrency: "parallel-safe",
		timeoutMs: 10_000,
		async execute(input, signal) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const pattern = stringField(parsed, "pattern");
			const flags = parsed.caseInsensitive === true ? "i" : "";
			const regex = new RegExp(pattern, flags);
			const start = await resolveExistingInsideRoot(options.workspaceRoot, optionalStringField(parsed, "path") ?? ".");
			const matches: Array<{ path: string; line: number; text: string }> = [];
			await walkFiles(options, start, async (file) => {
				throwIfAborted(signal);
				const info = await stat(file);
				if (info.size > options.maxFileBytes) return false;
				const text = await readTextFile(file, signal);
				let lineNumber = 0;
				for (const line of text.split(/\r?\n/)) {
					throwIfAborted(signal);
					lineNumber += 1;
					regex.lastIndex = 0;
					if (regex.test(line)) {
						matches.push({ path: relativePath(options.workspaceRoot, file), line: lineNumber, text: line });
						if (matches.length >= options.maxGrepMatches) return true;
					}
				}
				return false;
			}, signal);
			return { pattern, matches, truncated: matches.length >= options.maxGrepMatches };
		},
	};
}

function resolveOptions(options: ReadOnlyToolOptions): ResolvedOptions {
	return {
		workspaceRoot: path.resolve(options.workspaceRoot),
		maxFileBytes: options.maxFileBytes ?? 256 * 1024,
		maxDirEntries: options.maxDirEntries ?? 500,
		maxSearchResults: options.maxSearchResults ?? 200,
		maxGrepMatches: options.maxGrepMatches ?? 200,
	};
}

async function resolveExistingInsideRoot(root: string, userPath: string): Promise<string> {
	const rootReal = await realpath(root);
	const candidate = path.isAbsolute(userPath) ? userPath : path.resolve(rootReal, userPath);
	await access(candidate, constants.F_OK);
	const targetReal = await realpath(candidate);
	if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) {
		throw new Error("Path is outside workspace root");
	}
	return targetReal;
}

async function walkFiles(options: ResolvedOptions, start: string, visit: (file: string) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
	throwIfAborted(signal);
	const info = await lstat(start);
	if (info.isSymbolicLink()) return false;
	if (info.isFile()) return visit(start);
	if (!info.isDirectory()) return false;
	const entries = (await readdir(start, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		throwIfAborted(signal);
		if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
		if (entry.isSymbolicLink()) continue;
		const child = path.join(start, entry.name);
		if (entry.isDirectory()) {
			if (await walkFiles(options, child, visit, signal)) return true;
		} else if (entry.isFile()) {
			if (await visit(child)) return true;
		}
	}
	return false;
}

async function readTextFile(file: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const buffer = await readFile(file);
	throwIfAborted(signal);
	if (buffer.subarray(0, Math.min(buffer.length, 1024)).includes(0)) throw new Error("File appears to be binary");
	return buffer.toString("utf8");
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function globMatcher(pattern: string): (value: string) => boolean {
	const normalized = pattern.split(path.sep).join("/");
	const regex = new RegExp(`^${escapeGlob(normalized)}$`);
	return (value) => regex.test(value.split(path.sep).join("/"));
}

function escapeGlob(pattern: string): string {
	let output = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		const next = pattern[index + 1];
		if (char === "*" && next === "*") {
			output += ".*";
			index += 1;
		} else if (char === "*") {
			output += "[^/]*";
		} else if (char === "?") {
			output += "[^/]";
		} else if (char !== undefined) {
			output += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}
	return output;
}

function objectInput(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object");
	return input as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
	return value;
}

function optionalStringField(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
	return value;
}

function relativePath(root: string, target: string): string {
	const relative = path.relative(path.resolve(root), target);
	return relative === "" ? "." : relative.split(path.sep).join("/");
}

function direntType(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): string {
	if (entry.isFile()) return "file";
	if (entry.isDirectory()) return "directory";
	if (entry.isSymbolicLink()) return "symlink";
	return "other";
}
