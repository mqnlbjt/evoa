import path from "node:path";
import type { TuiCommand } from "../cli/args.js";
import type { ChatServiceDeps } from "../cli/chat-service.js";
import { FakeTerminal } from "./fake-terminal.js";
import { InteractiveMode } from "./interactive-mode.js";

export type TuiAutomationStatus = "starting" | "running" | "exited" | "disposed" | "error";

export interface TuiAutomationStartInput {
	agentPath: string;
	provider?: string;
	model?: string;
	baseURL?: string;
	apiKey?: string;
	providerFormat?: "openai-responses" | "anthropic-messages";
	toolProfile?: "read-only" | "coding" | "benchmark-sandbox" | "dangerous";
	sessionId?: string;
	sessionDir?: string;
	width?: number;
	height?: number;
}

export interface TuiAutomationSnapshotOptions {
	includeAnsi?: boolean;
	includeFrames?: boolean;
	maxBytes?: number;
}

export interface TuiAutomationSnapshot {
	sessionId: string;
	status: TuiAutomationStatus;
	size: { width: number; height: number };
	cursor: { row: number; column: number };
	plain: string;
	ansi?: string;
	frames?: string[];
	frameCount: number;
	clearCount: number;
	truncated: boolean;
	exitCode?: number;
	errorMessage?: string;
}

export interface TuiAutomationWaitInput {
	text?: string;
	textGone?: string;
	frameChanged?: boolean;
	status?: TuiAutomationStatus;
	timeoutMs?: number;
	intervalMs?: number;
}

export interface TuiAutomationSessionManagerOptions {
	workspaceRoot: string;
	deps: ChatServiceDeps;
	now?: () => number;
	createId?: () => string;
	maxSessions?: number;
}

interface TuiAutomationSession {
	id: string;
	terminal: FakeTerminal;
	mode: InteractiveMode;
	startedAt: number;
	lastActivityAt: number;
	status: TuiAutomationStatus;
	exitCode?: number;
	errorMessage?: string;
	startPromise: Promise<number>;
}

const defaultMaxBytes = 64 * 1024;
const defaultWaitTimeoutMs = 5_000;
const maxWaitTimeoutMs = 30_000;

export class TuiAutomationSessionManager {
	private readonly sessions = new Map<string, TuiAutomationSession>();
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly maxSessions: number;
	private readonly workspaceRoot: string;

	constructor(private readonly options: TuiAutomationSessionManagerOptions) {
		this.workspaceRoot = path.resolve(options.workspaceRoot);
		this.now = options.now ?? options.deps.now ?? Date.now;
		this.createId = options.createId ?? options.deps.createId ?? (() => crypto.randomUUID());
		this.maxSessions = options.maxSessions ?? 4;
	}

	async start(input: TuiAutomationStartInput): Promise<TuiAutomationSnapshot> {
		const sessionId = input.sessionId ?? this.createId();
		if (this.sessions.has(sessionId)) throw new Error(`TUI session already exists: ${sessionId}`);
		if (this.sessions.size >= this.maxSessions) throw new Error(`too many TUI automation sessions: ${this.maxSessions}`);
		const agentPath = this.workspacePath(input.agentPath, "agentPath");
		const sessionDir = input.sessionDir ? this.workspacePath(input.sessionDir, "sessionDir") : undefined;
		const terminal = new FakeTerminal({ width: boundedInteger(input.width ?? 100, 20, 240, "width"), height: boundedInteger(input.height ?? 24, 5, 80, "height") });
		const mode = new InteractiveMode({ command: this.command(input, agentPath, sessionDir), deps: { ...this.options.deps, enableTuiAutomationTools: false }, terminal, now: this.now });
		const session: TuiAutomationSession = { id: sessionId, terminal, mode, startedAt: this.now(), lastActivityAt: this.now(), status: "starting", startPromise: Promise.resolve(0) };
		this.sessions.set(sessionId, session);
		session.startPromise = mode.start().then((exitCode) => {
			session.exitCode = exitCode;
			if (session.status !== "disposed") session.status = "exited";
			return exitCode;
		}, (error: unknown) => {
			session.errorMessage = error instanceof Error ? error.message : String(error);
			if (session.status !== "disposed") session.status = "error";
			return 1;
		});
		await waitForFrame(terminal, 250);
		if (session.status === "error") {
			this.sessions.delete(sessionId);
			throw new Error(session.errorMessage ?? "TUI session failed to start");
		}
		if (session.status === "starting") session.status = "running";
		return this.snapshot(sessionId);
	}

	async sendInput(sessionId: string, text: string, submit = false): Promise<TuiAutomationSnapshot> {
		const session = this.requireRunningSession(sessionId);
		if (text) session.terminal.emitInput(text);
		if (submit) session.terminal.emitInput("\n");
		session.lastActivityAt = this.now();
		await delay(20);
		return this.snapshot(sessionId);
	}

	async resize(sessionId: string, width: number, height: number): Promise<TuiAutomationSnapshot> {
		const session = this.requireRunningSession(sessionId);
		session.terminal.resize({ width: boundedInteger(width, 20, 240, "width"), height: boundedInteger(height, 5, 80, "height") });
		session.lastActivityAt = this.now();
		await delay(20);
		return this.snapshot(sessionId);
	}

	snapshot(sessionId: string, options: TuiAutomationSnapshotOptions = {}): TuiAutomationSnapshot {
		const session = this.requireSession(sessionId);
		const maxBytes = boundedInteger(options.maxBytes ?? defaultMaxBytes, 1_024, 256 * 1024, "maxBytes");
		const frames = session.terminal.frames();
		const plain = truncateUtf8(session.terminal.lastFrame(), maxBytes);
		const ansi = options.includeAnsi ? truncateUtf8(session.terminal.outputText(), maxBytes) : undefined;
		const selectedFrames = options.includeFrames ? truncateFrames(frames, maxBytes) : undefined;
		const output: TuiAutomationSnapshot = {
			sessionId,
			status: session.status,
			size: { width: session.terminal.width, height: session.terminal.height },
			cursor: session.terminal.cursorPosition(),
			plain: plain.content,
			...(ansi ? { ansi: ansi.content } : {}),
			...(selectedFrames ? { frames: selectedFrames.content } : {}),
			frameCount: frames.length,
			clearCount: session.terminal.clearCount(),
			truncated: plain.truncated || Boolean(ansi?.truncated) || Boolean(selectedFrames?.truncated),
			...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
			...(session.errorMessage ? { errorMessage: session.errorMessage } : {}),
		};
		return output;
	}

	async wait(sessionId: string, input: TuiAutomationWaitInput, signal?: AbortSignal): Promise<{ matched: boolean; reason: string; elapsedMs: number; snapshot: TuiAutomationSnapshot }> {
		const startedAt = this.now();
		const timeoutMs = Math.min(input.timeoutMs ?? defaultWaitTimeoutMs, maxWaitTimeoutMs);
		const intervalMs = boundedInteger(input.intervalMs ?? 50, 10, 1_000, "intervalMs");
		const initialFrame = this.snapshot(sessionId).plain;
		while (this.now() - startedAt <= timeoutMs) {
			if (signal?.aborted) throw new Error("TUI wait aborted");
			const snapshot = this.snapshot(sessionId);
			const reason = matchWait(snapshot, input, initialFrame);
			if (reason) return { matched: true, reason, elapsedMs: this.now() - startedAt, snapshot };
			await delay(intervalMs);
		}
		return { matched: false, reason: "timeout", elapsedMs: this.now() - startedAt, snapshot: this.snapshot(sessionId) };
	}

	async stop(sessionId: string): Promise<{ sessionId: string; status: TuiAutomationStatus; exitCode?: number; errorMessage?: string }> {
		const session = this.requireSession(sessionId);
		if (session.status !== "disposed") {
			session.mode.stop();
			await session.startPromise;
			session.status = "disposed";
			session.terminal.dispose();
		}
		this.sessions.delete(sessionId);
		return { sessionId, status: "disposed", ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }), ...(session.errorMessage ? { errorMessage: session.errorMessage } : {}) };
	}

	async dispose(): Promise<void> {
		await Promise.all(Array.from(this.sessions.keys()).map((sessionId) => this.stop(sessionId)));
	}

	private command(input: TuiAutomationStartInput, agentPath: string, sessionDir: string | undefined): TuiCommand {
		return {
			kind: "tui",
			format: "human",
			agentPath,
			provider: input.provider ?? "local",
			model: input.model ?? "gpt-5.5",
			baseURL: input.baseURL ?? "http://localhost:8317/v1",
			...(input.apiKey ? { apiKey: input.apiKey } : {}),
			providerFormat: input.providerFormat ?? "openai-responses",
			toolProfile: input.toolProfile ?? "dangerous",
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			...(sessionDir ? { sessionDir } : {}),
			providedFlags: { agentPath: true, provider: Boolean(input.provider), model: Boolean(input.model), baseURL: Boolean(input.baseURL), providerFormat: Boolean(input.providerFormat), toolProfile: Boolean(input.toolProfile), sessionDir: Boolean(input.sessionDir) },
		};
	}

	private workspacePath(value: string, field: string): string {
		const resolved = path.resolve(this.workspaceRoot, value);
		if (resolved !== this.workspaceRoot && !resolved.startsWith(`${this.workspaceRoot}${path.sep}`)) throw new Error(`${field} must be inside workspace`);
		return resolved;
	}

	private requireSession(sessionId: string): TuiAutomationSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`TUI session not found: ${sessionId}`);
		return session;
	}

	private requireRunningSession(sessionId: string): TuiAutomationSession {
		const session = this.requireSession(sessionId);
		if (session.status !== "running" && session.status !== "starting") throw new Error(`TUI session ${sessionId} is ${session.status}`);
		return session;
	}
}

function matchWait(snapshot: TuiAutomationSnapshot, input: TuiAutomationWaitInput, initialFrame: string): string | undefined {
	if (input.text && snapshot.plain.includes(input.text)) return "text";
	if (input.textGone && !snapshot.plain.includes(input.textGone)) return "textGone";
	if (input.frameChanged && snapshot.plain !== initialFrame) return "frameChanged";
	if (input.status && snapshot.status === input.status) return "status";
	return undefined;
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
	return value;
}

async function waitForFrame(terminal: FakeTerminal, timeoutMs: number): Promise<void> {
	const startedAt = Date.now();
	while (terminal.frames().length === 0 && Date.now() - startedAt < timeoutMs) await delay(10);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateUtf8(value: string, maxBytes: number): { content: string; truncated: boolean } {
	let bytes = 0;
	let content = "";
	for (const char of value) {
		const next = Buffer.byteLength(char, "utf8");
		if (bytes + next > maxBytes) return { content, truncated: true };
		bytes += next;
		content += char;
	}
	return { content, truncated: false };
}

function truncateFrames(frames: string[], maxBytes: number): { content: string[]; truncated: boolean } {
	const output: string[] = [];
	let bytes = 0;
	for (const frame of frames) {
		const next = Buffer.byteLength(frame, "utf8");
		if (bytes + next > maxBytes) return { content: output, truncated: true };
		bytes += next;
		output.push(frame);
	}
	return { content: output, truncated: false };
}
