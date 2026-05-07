import type { BashExecutionResult } from "../tools/bash-executor.js";
import type { ToolResult } from "../tools/registry.js";

export function isBashExecutionResult(value: unknown): value is BashExecutionResult {
	if (!value || typeof value !== "object") return false;
	const result = value as Partial<BashExecutionResult>;
	return typeof result.command === "string"
		&& typeof result.cwd === "string"
		&& typeof result.stdout === "string"
		&& typeof result.stderr === "string"
		&& typeof result.truncated === "boolean"
		&& typeof result.timedOut === "boolean"
		&& typeof result.durationMs === "number";
}

export function renderBashResult(result: ToolResult, width: number): string[] {
	if (!isBashExecutionResult(result.output)) return [];
	const output = result.output;
	const lines = [
		`$ ${output.command}`,
		`cwd: ${output.cwd} | exit: ${output.exitCode ?? output.signal ?? "-"} | duration: ${output.durationMs}ms${output.timedOut ? " | timed out" : ""}${output.truncated ? " | truncated" : ""}`,
	];
	lines.push(...previewBlock("stdout", output.stdout, width));
	lines.push(...previewBlock("stderr", output.stderr, width));
	return lines.map((line) => truncate(line, width));
}

function previewBlock(label: string, text: string, width: number): string[] {
	if (!text.trim()) return [];
	const lines = text.trimEnd().split(/\r?\n/).slice(0, 4).map((line) => `  ${truncate(line, Math.max(0, width - 2))}`);
	return [`${label}:`, ...lines];
}

function truncate(value: string, width: number): string {
	if (width <= 0) return "";
	return value.length <= width ? value : value.slice(0, Math.max(0, width - 1));
}
