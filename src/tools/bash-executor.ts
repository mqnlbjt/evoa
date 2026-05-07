import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";

export interface BashExecuteOptions {
	command: string;
	cwd: string;
	workspaceRoot: string;
	timeoutMs: number;
	maxOutputBytes: number;
	signal?: AbortSignal;
}

export interface BashExecutionResult {
	command: string;
	cwd: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
	durationMs: number;
}

export interface BashExecutor {
	execute(options: BashExecuteOptions): Promise<BashExecutionResult>;
}

export interface SpawnedProcess extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnLike = (command: string, args: string[] | undefined, options: { cwd?: string; shell?: boolean }) => SpawnedProcess;

export function createHostBashExecutor(spawnFn: SpawnLike = spawnLike): BashExecutor {
	return {
		execute(options) {
			return runSpawnedProcess(options, () => spawnFn(options.command, undefined, { cwd: options.cwd, shell: true }));
		},
	};
}

export function createDockerBashExecutor(input: { container: string; spawnFn?: SpawnLike }): BashExecutor {
	return {
		execute(options) {
			const args = buildDockerExecArgs(input.container, options.cwd, options.command);
			return runSpawnedProcess(options, () => (input.spawnFn ?? spawnLike)("docker", args, { shell: false }));
		},
	};
}

export function buildDockerExecArgs(container: string, cwd: string, command: string): string[] {
	return ["exec", "-w", cwd, container, "/bin/sh", "-lc", command];
}

function runSpawnedProcess(options: BashExecuteOptions, start: () => SpawnedProcess): Promise<BashExecutionResult> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;
		const child = start();
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, options.timeoutMs);
		const abort = () => child.kill("SIGTERM");
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += appendOutput(chunk, options.maxOutputBytes, () => outputBytes, (bytes) => { outputBytes = bytes; }, () => { truncated = true; child.kill("SIGTERM"); });
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += appendOutput(chunk, options.maxOutputBytes, () => outputBytes, (bytes) => { outputBytes = bytes; }, () => { truncated = true; child.kill("SIGTERM"); });
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
			reject(error);
		});
		child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
			resolve({
				command: options.command,
				cwd: relativePath(options.workspaceRoot, options.cwd),
				exitCode,
				signal,
				stdout,
				stderr,
				truncated,
				timedOut,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}

function spawnLike(command: string, args: string[] | undefined, options: { cwd?: string; shell?: boolean }): SpawnedProcess {
	return args === undefined ? spawn(command, options) : spawn(command, args, options);
}

function appendOutput(chunk: Buffer, maxBytes: number, currentBytes: () => number, setBytes: (bytes: number) => void, onLimit: () => void): string {
	if (currentBytes() >= maxBytes) return "";
	const remaining = maxBytes - currentBytes();
	const piece = chunk.subarray(0, remaining);
	setBytes(currentBytes() + piece.length);
	if (chunk.length > remaining || currentBytes() >= maxBytes) onLimit();
	return piece.toString("utf8");
}

function relativePath(workspaceRoot: string, target: string): string {
	return path.relative(workspaceRoot, target) || ".";
}
