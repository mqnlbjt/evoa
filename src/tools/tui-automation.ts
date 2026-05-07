import type { ChatServiceDeps } from "../cli/chat-service.js";
import { TuiAutomationSessionManager, type TuiAutomationSessionManagerOptions, type TuiAutomationSnapshotOptions, type TuiAutomationStartInput, type TuiAutomationWaitInput } from "../tui/automation-session.js";
import type { EvolvingAgentTool } from "./types.js";

export interface TuiAutomationToolOptions extends Omit<TuiAutomationSessionManagerOptions, "deps"> {
	deps: ChatServiceDeps;
	manager?: TuiAutomationSessionManager;
}

export interface TuiAutomationToolBundle {
	tools: EvolvingAgentTool[];
	close: () => Promise<void>;
}

export function createTuiAutomationToolBundle(options: TuiAutomationToolOptions): TuiAutomationToolBundle {
	const manager = options.manager ?? new TuiAutomationSessionManager(options);
	return {
		tools: createTuiAutomationTools(manager),
		close: () => manager.dispose(),
	};
}

function createTuiAutomationTools(manager: TuiAutomationSessionManager): EvolvingAgentTool[] {
	return [
		{
			name: "tui_start",
			description: "Start an isolated fake-terminal TUI session for agent development and return its first snapshot.",
			inputSchema: objectSchema({ agentPath: { type: "string" }, provider: { type: "string" }, model: { type: "string" }, baseURL: { type: "string" }, apiKey: { type: "string" }, providerFormat: { enum: ["openai-responses", "anthropic-messages"] }, toolProfile: { enum: ["read-only", "coding", "benchmark-sandbox", "dangerous"] }, sessionId: { type: "string" }, sessionDir: { type: "string" }, width: { type: "integer" }, height: { type: "integer" } }, ["agentPath"]),
			permission: { defaultDecision: "allow", riskLevel: "medium" },
			concurrency: "sequential",
			timeoutMs: 5_000,
			maxResultBytes: 64 * 1024,
			execute: async (input) => manager.start(startInput(assertRecord(input))),
		},
		{
			name: "tui_send_input",
			description: "Send keystrokes to a TUI automation session. Use submit=true to append Enter.",
			inputSchema: objectSchema({ sessionId: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, ["sessionId", "text"]),
			permission: { defaultDecision: "allow", riskLevel: "medium" },
			concurrency: "sequential",
			timeoutMs: 1_000,
			maxResultBytes: 64 * 1024,
			execute: async (input) => {
				const value = assertRecord(input);
				const sessionId = stringField(value, "sessionId");
				return { sessionId, accepted: true, snapshot: await manager.sendInput(sessionId, stringField(value, "text"), booleanField(value, "submit") ?? false) };
			},
		},
		{
			name: "tui_snapshot",
			description: "Read the current TUI automation frame, cursor, status, dimensions, and optional ANSI output or frame history.",
			inputSchema: objectSchema({ sessionId: { type: "string" }, includeAnsi: { type: "boolean" }, includeFrames: { type: "boolean" }, maxBytes: { type: "integer" } }, ["sessionId"]),
			permission: { defaultDecision: "allow", riskLevel: "low" },
			concurrency: "sequential",
			timeoutMs: 1_000,
			maxResultBytes: 64 * 1024,
			execute: async (input) => {
				const value = assertRecord(input);
				return manager.snapshot(stringField(value, "sessionId"), snapshotOptions(value));
			},
		},
		{
			name: "tui_resize",
			description: "Resize a TUI automation session and return the updated snapshot.",
			inputSchema: objectSchema({ sessionId: { type: "string" }, width: { type: "integer" }, height: { type: "integer" } }, ["sessionId", "width", "height"]),
			permission: { defaultDecision: "allow", riskLevel: "medium" },
			concurrency: "sequential",
			timeoutMs: 1_000,
			maxResultBytes: 64 * 1024,
			execute: async (input) => {
				const value = assertRecord(input);
				const snapshot = await manager.resize(stringField(value, "sessionId"), requiredNumberField(value, "width"), requiredNumberField(value, "height"));
				return { sessionId: snapshot.sessionId, size: snapshot.size, snapshot };
			},
		},
		{
			name: "tui_wait",
			description: "Wait for text, text disappearance, frame changes, or session status in a TUI automation session.",
			inputSchema: objectSchema({ sessionId: { type: "string" }, text: { type: "string" }, textGone: { type: "string" }, frameChanged: { type: "boolean" }, status: { enum: ["starting", "running", "exited", "disposed", "error"] }, timeoutMs: { type: "integer" }, intervalMs: { type: "integer" } }, ["sessionId"]),
			permission: { defaultDecision: "allow", riskLevel: "low" },
			concurrency: "sequential",
			timeoutMs: 31_000,
			maxResultBytes: 64 * 1024,
			execute: async (input, signal) => {
				const value = assertRecord(input);
				return manager.wait(stringField(value, "sessionId"), waitInput(value), signal);
			},
		},
		{
			name: "tui_stop",
			description: "Stop and dispose a TUI automation session.",
			inputSchema: objectSchema({ sessionId: { type: "string" } }, ["sessionId"]),
			permission: { defaultDecision: "allow", riskLevel: "medium" },
			concurrency: "sequential",
			timeoutMs: 2_000,
			maxResultBytes: 16 * 1024,
			execute: async (input) => manager.stop(stringField(assertRecord(input), "sessionId")),
		},
	];
}

function objectSchema(properties: Record<string, unknown>, required: string[]): unknown {
	return { type: "object", properties, required, additionalProperties: false };
}

function assertRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("input must be an object");
	return value as Record<string, unknown>;
}

function startInput(value: Record<string, unknown>): TuiAutomationStartInput {
	return {
		agentPath: stringField(value, "agentPath"),
		...optionalStringObject(value, "provider"),
		...optionalStringObject(value, "model"),
		...optionalStringObject(value, "baseURL"),
		...optionalStringObject(value, "apiKey"),
		...optionalStringObject(value, "providerFormat"),
		...optionalStringObject(value, "toolProfile"),
		...optionalStringObject(value, "sessionId"),
		...optionalStringObject(value, "sessionDir"),
		...optionalNumberObject(value, "width"),
		...optionalNumberObject(value, "height"),
	} as TuiAutomationStartInput;
}

function snapshotOptions(value: Record<string, unknown>): TuiAutomationSnapshotOptions {
	return {
		...optionalBooleanObject(value, "includeAnsi"),
		...optionalBooleanObject(value, "includeFrames"),
		...optionalNumberObject(value, "maxBytes"),
	};
}

function waitInput(value: Record<string, unknown>): TuiAutomationWaitInput {
	return {
		...optionalStringObject(value, "text"),
		...optionalStringObject(value, "textGone"),
		...optionalBooleanObject(value, "frameChanged"),
		...optionalStringObject(value, "status"),
		...optionalNumberObject(value, "timeoutMs"),
		...optionalNumberObject(value, "intervalMs"),
	} as TuiAutomationWaitInput;
}

function optionalStringObject(value: Record<string, unknown>, field: string): Record<string, string> {
	const raw = stringOptional(value, field);
	return raw === undefined ? {} : { [field]: raw };
}

function optionalBooleanObject(value: Record<string, unknown>, field: string): Record<string, boolean> {
	const raw = booleanField(value, field);
	return raw === undefined ? {} : { [field]: raw };
}

function optionalNumberObject(value: Record<string, unknown>, field: string): Record<string, number> {
	const raw = numberField(value, field);
	return raw === undefined ? {} : { [field]: raw };
}

function stringField(value: Record<string, unknown>, field: string): string {
	const raw = value[field];
	if (typeof raw !== "string" || raw.length === 0) throw new Error(`${field} must be a non-empty string`);
	return raw;
}

function stringOptional(value: Record<string, unknown>, field: string): string | undefined {
	const raw = value[field];
	if (raw === undefined) return undefined;
	if (typeof raw !== "string") throw new Error(`${field} must be a string`);
	return raw;
}

function booleanField(value: Record<string, unknown>, field: string): boolean | undefined {
	const raw = value[field];
	if (raw === undefined) return undefined;
	if (typeof raw !== "boolean") throw new Error(`${field} must be a boolean`);
	return raw;
}

function requiredNumberField(value: Record<string, unknown>, field: string): number {
	const raw = numberField(value, field);
	if (raw === undefined) throw new Error(`${field} is required`);
	return raw;
}

function numberField(value: Record<string, unknown>, field: string): number | undefined {
	const raw = value[field];
	if (raw === undefined) return undefined;
	if (typeof raw !== "number" || !Number.isInteger(raw)) throw new Error(`${field} must be an integer`);
	return raw;
}
