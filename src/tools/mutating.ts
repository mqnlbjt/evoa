import { lstat, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHostBashExecutor, type BashExecutor } from "./bash-executor.js";
import type { EvolvingAgentTool } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { objectInput, optionalBooleanField, optionalNumberField, optionalStringField, readTextFile, relativePath, resolveCreatableInsideRoot, resolveExistingInsideRoot, stringField, throwIfAborted } from "./workspace.js";

export interface MutatingToolOptions {
	workspaceRoot: string;
	maxFileBytes?: number;
	maxWriteBytes?: number;
	bashTimeoutMs?: number;
	bashMaxTimeoutMs?: number;
	bashMaxOutputBytes?: number;
	bashExecutor?: BashExecutor;
}

interface ResolvedOptions {
	workspaceRoot: string;
	maxFileBytes: number;
	maxWriteBytes: number;
	bashTimeoutMs: number;
	bashMaxTimeoutMs: number;
	bashMaxOutputBytes: number;
	bashExecutor: BashExecutor;
}

interface EditSpec {
	oldText: string;
	newText: string;
	replaceAll: boolean;
}

const mutationQueues = new Map<string, Promise<void>>();

export function createMutatingToolRegistry(options: MutatingToolOptions): ToolRegistry {
	return new ToolRegistry(createMutatingTools(options));
}

export function createMutatingTools(options: MutatingToolOptions): EvolvingAgentTool[] {
	const resolved = resolveOptions(options);
	return [writeFileTool(resolved), editFileTool(resolved), bashTool(resolved)];
}

export function createCodingTools(options: MutatingToolOptions): EvolvingAgentTool[] {
	const resolved = resolveOptions(options);
	return [writeFileTool(resolved), editFileTool(resolved)];
}

function writeFileTool(options: ResolvedOptions): EvolvingAgentTool {
	return {
		name: "write_file",
		description: "Create or replace a UTF-8 text file inside the workspace root.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string" },
				content: { type: "string" },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "medium", requiresSandbox: true },
		concurrency: "sequential",
		timeoutMs: 5_000,
		async execute(input, signal, context) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const userPath = stringField(parsed, "path");
			const content = stringField(parsed, "content");
			const bytesWritten = Buffer.byteLength(content, "utf8");
			if (bytesWritten > options.maxWriteBytes) throw new Error("Content is too large");
			const target = await resolveCreatableInsideRoot(options.workspaceRoot, userPath, context?.sandboxMode);
			return withPathQueue(target, async () => {
				throwIfAborted(signal);
				const existing = await lstat(target).catch((error: unknown) => {
					if (isNotFound(error)) return undefined;
					throw error;
				});
				if (existing?.isDirectory()) throw new Error("Path is a directory");
				if (existing?.isSymbolicLink()) throw new Error("Path is a symlink");
				await writeFile(target, content, "utf8");
				return { path: relativePath(options.workspaceRoot, target), bytesWritten, created: !existing };
			});
		},
	};
}

function editFileTool(options: ResolvedOptions): EvolvingAgentTool {
	return {
		name: "edit_file",
		description: "Apply exact text replacements to a UTF-8 file inside the workspace root.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string" },
				edits: {
					type: "array",
					items: {
						type: "object",
						properties: {
							oldText: { type: "string" },
							newText: { type: "string" },
							replaceAll: { type: "boolean" },
						},
						required: ["oldText", "newText"],
						additionalProperties: false,
					},
				},
			},
			required: ["path", "edits"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "medium", requiresSandbox: true },
		concurrency: "sequential",
		timeoutMs: 5_000,
		async execute(input, signal, context) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const target = await resolveExistingInsideRoot(options.workspaceRoot, stringField(parsed, "path"), context?.sandboxMode);
			const edits = editSpecs(parsed["edits"]);
			return withPathQueue(target, async () => {
				throwIfAborted(signal);
				const info = await stat(target);
				if (!info.isFile()) throw new Error("Path is not a file");
				if (info.size > options.maxFileBytes) throw new Error("File is too large");
				let text = await readTextFile(target, signal);
				let editsApplied = 0;
				for (const edit of edits) {
					const count = occurrenceCount(text, edit.oldText);
					if (count === 0) throw new Error("oldText not found");
					if (!edit.replaceAll && count !== 1) throw new Error("oldText must occur exactly once");
					editsApplied += edit.replaceAll ? count : 1;
					text = edit.replaceAll ? text.split(edit.oldText).join(edit.newText) : text.replace(edit.oldText, edit.newText);
				}
				const bytesWritten = Buffer.byteLength(text, "utf8");
				if (bytesWritten > options.maxWriteBytes) throw new Error("Edited content is too large");
				await writeFile(target, text, "utf8");
				return { path: relativePath(options.workspaceRoot, target), editsApplied, bytesWritten };
			});
		},
	};
}

function bashTool(options: ResolvedOptions): EvolvingAgentTool {
	return {
		name: "bash",
		description: "Run a shell command from a workspace-scoped cwd with bounded timeout and output.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string" },
				cwd: { type: "string" },
				timeoutMs: { type: "number" },
			},
			required: ["command"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "high", requiresSandbox: true },
		concurrency: "sequential",
		timeoutMs: options.bashMaxTimeoutMs + 1_000,
		maxResultBytes: options.bashMaxOutputBytes + 1024,
		async execute(input, signal, context) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const command = stringField(parsed, "command");
			const cwd = await resolveExistingInsideRoot(options.workspaceRoot, optionalStringField(parsed, "cwd") ?? ".", context?.sandboxMode);
			const info = await stat(cwd);
			if (!info.isDirectory()) throw new Error("cwd is not a directory");
			const timeoutMs = Math.min(optionalNumberField(parsed, "timeoutMs") ?? options.bashTimeoutMs, options.bashMaxTimeoutMs);
			if (timeoutMs <= 0) throw new Error("timeoutMs must be greater than 0");
			return options.bashExecutor.execute({ command, cwd, workspaceRoot: options.workspaceRoot, timeoutMs, maxOutputBytes: options.bashMaxOutputBytes, ...(signal ? { signal } : {}) });
		},
	};
}

function resolveOptions(options: MutatingToolOptions): ResolvedOptions {
	return {
		workspaceRoot: path.resolve(options.workspaceRoot),
		maxFileBytes: options.maxFileBytes ?? 256 * 1024,
		maxWriteBytes: options.maxWriteBytes ?? 256 * 1024,
		bashTimeoutMs: options.bashTimeoutMs ?? 10_000,
		bashMaxTimeoutMs: options.bashMaxTimeoutMs ?? 60_000,
		bashMaxOutputBytes: options.bashMaxOutputBytes ?? 64 * 1024,
		bashExecutor: options.bashExecutor ?? createHostBashExecutor(),
	};
}

function editSpecs(value: unknown): EditSpec[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("edits must be a non-empty array");
	return value.map((entry) => {
		const parsed = objectInput(entry);
		return {
			oldText: stringField(parsed, "oldText"),
			newText: requiredStringField(parsed, "newText"),
			replaceAll: optionalBooleanField(parsed, "replaceAll") ?? false,
		};
	});
}

function requiredStringField(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

function occurrenceCount(text: string, search: string): number {
	let count = 0;
	let index = text.indexOf(search);
	while (index !== -1) {
		count += 1;
		index = text.indexOf(search, index + search.length);
	}
	return count;
}

async function withPathQueue<T>(target: string, operation: () => Promise<T>): Promise<T> {
	const previous = mutationQueues.get(target) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => next, () => next);
	mutationQueues.set(target, queued);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
		if (mutationQueues.get(target) === queued) mutationQueues.delete(target);
	}
}


function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
