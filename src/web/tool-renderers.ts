import type { ToolCall, ToolResult } from "../tools/registry.js";

export interface ToolRenderer {
	canRender(toolName: string, value: unknown): boolean;
	renderCall(call: ToolCall, width: number): string[];
	renderRunning(call: ToolCall, width: number): string[];
	renderResult(result: ToolResult, width: number): string[];
	renderError(result: ToolResult, width: number): string[];
}

export function renderToolCall(call: ToolCall, width: number): string[] {
	return [truncate(`→ ${call.name} ${compactToolInput(call.input)}`, width)];
}

export function renderRunningTool(call: ToolCall, width: number): string[] {
	return [truncate(`… running ${call.name}`, width)];
}

export function renderToolResult(result: ToolResult, width: number): string[] {
	const detail = result.errorMessage ?? compactJson(result.output);
	return [truncate(`${statusPrefix(result)} ${result.call.name}: ${detail}`, width)];
}

export function renderToolResultText(result: ToolResult, width: number): string {
	return renderToolResult(result, width).join("\n");
}

function statusPrefix(result: ToolResult): string {
	if (result.status === "success") return "✓";
	if (result.status === "denied") return "! denied";
	if (result.status === "timeout") return "! timeout";
	if (result.status === "limit_exceeded") return "! limit";
	return "! error";
}

function compactJson(value: unknown): string {
	if (value === undefined) return "";
	try {
		const json = JSON.stringify(value);
		return json.length > 120 ? `${json.slice(0, 117)}...` : json;
	} catch {
		return String(value);
	}
}

function compactToolInput(value: unknown): string {
	if (!isRecord(value)) return compactJson(value);
	const path = stringValue(value.path);
	const pattern = stringValue(value.pattern);
	const command = stringValue(value.command);
	if (command) return `$ ${command}`;
	if (pattern && path) return `${path} ${pattern}`;
	if (path) return path;
	return compactJson(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, width: number): string {
	if (width <= 0) return "";
	return value.length <= width ? value : value.slice(0, Math.max(0, width - 1));
}
