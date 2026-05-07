import type { AgentSession } from "../runtime/session.js";
import { decideSandboxUse, type SandboxPolicy } from "./sandbox.js";
import type { EvolvingAgentTool, ToolExecutionContext } from "./types.js";
import { decideToolUse, toolCallLimitDecision, type ToolDecision } from "./policy.js";

export interface ToolCall {
	id: string;
	name: string;
	input?: unknown;
}

export type ToolResultStatus = "success" | "error" | "denied" | "unknown" | "limit_exceeded" | "timeout";

export interface ToolResult {
	call: ToolCall;
	decision: ToolDecision;
	status: ToolResultStatus;
	output?: unknown;
	errorMessage?: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	maxResultBytes?: number;
	metadata?: Record<string, unknown>;
}

export type BeforeToolCallResult =
	| void
	| { decision: "allow" }
	| { decision: "deny"; reason: string }
	| { decision: "mutate"; input: unknown };

export interface RuntimeHook {
	beforeToolCall?(session: AgentSession, call: ToolCall): Promise<BeforeToolCallResult> | BeforeToolCallResult;
	afterToolResult?(session: AgentSession, result: ToolResult): Promise<ToolResult | void> | ToolResult | void;
}

export interface NormalizeToolResultOptions {
	maxBytes?: number;
}

export interface ToolRegistryOptions {
	sandboxPolicy?: SandboxPolicy;
	disposables?: Array<() => Promise<void> | void>;
}

const defaultMaxResultBytes = 64 * 1024;

export class ToolRegistry {
	private readonly tools = new Map<string, EvolvingAgentTool>();
	private readonly options: ToolRegistryOptions;
	private readonly disposables: Array<() => Promise<void> | void>;

	constructor(tools: EvolvingAgentTool[] = [], options: ToolRegistryOptions = {}) {
		this.options = options;
		this.disposables = [...(options.disposables ?? [])];
		for (const tool of tools) {
			this.register(tool);
		}
	}

	register(tool: EvolvingAgentTool): void {
		this.tools.set(tool.name, tool);
	}

	registerDisposable(dispose: () => Promise<void> | void): void {
		this.disposables.push(dispose);
	}

	get(name: string): EvolvingAgentTool | undefined {
		return this.tools.get(name);
	}

	list(): EvolvingAgentTool[] {
		return Array.from(this.tools.values());
	}

	clone(): ToolRegistry {
		return new ToolRegistry(this.list(), { ...(this.options.sandboxPolicy ? { sandboxPolicy: this.options.sandboxPolicy } : {}) });
	}

	async close(): Promise<void> {
		const results = await Promise.allSettled(this.disposables.map((dispose) => dispose()));
		const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (rejected) throw rejected.reason;
	}

	async execute(session: AgentSession, call: ToolCall, hooks: RuntimeHook[] = [], signal?: AbortSignal): Promise<ToolResult> {
		const startedAt = Date.now();
		const limitDecision = toolCallLimitDecision(session.agent, session.toolCallCount);
		if (limitDecision) {
			return this.finalize(session, hooks, withTiming({ call, decision: limitDecision, status: "limit_exceeded", errorMessage: limitDecision.reason }, startedAt));
		}

		session.toolCallCount += 1;
		const tool = this.get(call.name);
		if (!tool) {
			const decision = { decision: "deny" as const, reason: `tool ${call.name} is not registered` };
			return this.finalize(session, hooks, withTiming({ call, decision, status: "unknown", errorMessage: `Unknown tool: ${call.name}` }, startedAt));
		}

		let currentCall = call;
		let decision = decideToolUse(session.agent, session.task, tool);
		if (decision.decision !== "allow") {
			return this.finalize(session, hooks, withTiming(withToolLimits(tool, { call: currentCall, decision, status: "denied", errorMessage: decision.reason }), startedAt));
		}

		for (const hook of hooks) {
			const hookResult = await hook.beforeToolCall?.(session, currentCall);
			if (!hookResult) continue;
			if (hookResult.decision === "deny") {
				decision = { decision: "deny", reason: hookResult.reason };
				return this.finalize(session, hooks, withTiming(withToolLimits(tool, {
					call: currentCall,
					decision,
					status: "denied",
					errorMessage: hookResult.reason,
					metadata: { hookDecision: "deny" },
				}), startedAt));
			}
			if (hookResult.decision === "mutate") {
				currentCall = { ...currentCall, input: hookResult.input };
			}
		}

		if (this.options.sandboxPolicy) {
			const sandboxDecision = decideSandboxUse({ session, tool, call: currentCall, policy: this.options.sandboxPolicy });
			if (sandboxDecision.decision !== "allow") {
				decision = { decision: "deny", reason: sandboxDecision.reason };
				return this.finalize(session, hooks, withTiming(withToolLimits(tool, {
					call: currentCall,
					decision,
					status: "denied",
					errorMessage: sandboxDecision.reason,
					metadata: { sandboxDecision: "deny", ...sandboxDecision.metadata },
				}), startedAt));
			}
		}

		try {
			const output = await executeWithTimeout(tool, currentCall.input, signal, { session, call: currentCall });
			return this.finalize(session, hooks, withTiming(withToolLimits(tool, { call: currentCall, decision, status: "success", output }), startedAt));
		} catch (error) {
			const timedOut = error instanceof ToolTimeoutError;
			return this.finalize(session, hooks, withTiming(withToolLimits(tool, {
				call: currentCall,
				decision,
				status: timedOut ? "timeout" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			}), startedAt));
		}
	}

	private async finalize(session: AgentSession, hooks: RuntimeHook[], result: ToolResult): Promise<ToolResult> {
		let current = result;
		for (const hook of hooks) {
			const next = await hook.afterToolResult?.(session, current);
			if (next) current = next;
		}
		return current;
	}
}

export function normalizeToolResultContent(result: ToolResult, options: NormalizeToolResultOptions = {}): string {
	const maxBytes = options.maxBytes ?? result.maxResultBytes ?? defaultMaxResultBytes;
	const value = result.errorMessage
		? { status: result.status, error: result.errorMessage }
		: result.output ?? null;
	const serialized = safeStringify(value);
	if (byteLength(serialized) <= maxBytes) return serialized;
	return safeStringify({ truncated: true, maxBytes, content: truncateUtf8(serialized, maxBytes) });
}

function withTiming(result: Omit<ToolResult, "startedAt" | "endedAt" | "durationMs">, startedAt: number): ToolResult {
	const endedAt = Date.now();
	return { ...result, startedAt, endedAt, durationMs: endedAt - startedAt };
}

function withToolLimits(tool: EvolvingAgentTool, result: Omit<ToolResult, "startedAt" | "endedAt" | "durationMs" | "maxResultBytes">): Omit<ToolResult, "startedAt" | "endedAt" | "durationMs"> {
	return tool.maxResultBytes === undefined ? result : { ...result, maxResultBytes: tool.maxResultBytes };
}

async function executeWithTimeout(tool: EvolvingAgentTool, input: unknown, signal?: AbortSignal, context?: ToolExecutionContext): Promise<unknown> {
	if (!tool.timeoutMs) return tool.execute(input, signal, context);

	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });

	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			tool.execute(input, controller.signal, context),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => {
					controller.abort();
					reject(new ToolTimeoutError(`tool ${tool.name} timed out after ${tool.timeoutMs}ms`));
				}, tool.timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

class ToolTimeoutError extends Error {}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch (error) {
		return JSON.stringify({ status: "error", error: `Tool result is not JSON serializable: ${error instanceof Error ? error.message : String(error)}` });
	}
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
	let bytes = 0;
	let output = "";
	for (const char of value) {
		const next = Buffer.byteLength(char, "utf8");
		if (bytes + next > maxBytes) break;
		bytes += next;
		output += char;
	}
	return output;
}
