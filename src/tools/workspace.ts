import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export function objectInput(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object");
	return input as Record<string, unknown>;
}

export function stringField(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
	return value;
}

export function optionalStringField(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
	return value;
}

export function optionalBooleanField(input: Record<string, unknown>, key: string): boolean | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
	return value;
}

export function optionalNumberField(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
	return value;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

export async function resolveExistingInsideRoot(root: string, userPath: string, sandboxMode?: string): Promise<string> {
	const rootReal = await realpath(root);
	const candidate = path.isAbsolute(userPath) ? userPath : path.resolve(rootReal, userPath);
	await access(candidate, constants.F_OK);
	const targetReal = await realpath(candidate);
	if (sandboxMode !== "off") {
		assertInsideRoot(rootReal, targetReal);
	}
	return targetReal;
}

export async function resolveCreatableInsideRoot(root: string, userPath: string, sandboxMode?: string): Promise<string> {
	const rootReal = await realpath(root);
	const candidate = path.isAbsolute(userPath) ? userPath : path.resolve(rootReal, userPath);
	const parentReal = await realpath(path.dirname(candidate));
	if (sandboxMode !== "off") {
		assertInsideRoot(rootReal, parentReal);
	}
	const existing = await lstat(candidate).catch((error: unknown) => {
		if (isNotFound(error)) return undefined;
		throw error;
	});
	if (existing?.isSymbolicLink()) throw new Error("Path is a symlink");
	return path.join(parentReal, path.basename(candidate));
}

export async function readTextFile(file: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const buffer = await readFile(file);
	throwIfAborted(signal);
	if (buffer.subarray(0, Math.min(buffer.length, 1024)).includes(0)) throw new Error("File appears to be binary");
	return buffer.toString("utf8");
}

export function relativePath(root: string, target: string): string {
	const relative = path.relative(path.resolve(root), target);
	return relative === "" ? "." : relative.split(path.sep).join("/");
}

function assertInsideRoot(rootReal: string, targetReal: string): void {
	if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) {
		throw new Error("Path is outside workspace root");
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
