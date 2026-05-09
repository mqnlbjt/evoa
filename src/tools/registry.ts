import type { AgentSession } from "../runtime/session.js";
import { isAbortError } from "../runtime/timeout.js";
import { decideSandboxUse, type SandboxPolicy } from "./sandbox.js";
import type { EvolvingAgentTool, ToolExecutionContext } from "./types.js";
import { decideToolUse, toolCallLimitDecision, type ToolDecision } from "./policy.js";
import { truncateToolOutput, type ToolOutputTruncationMetadata, type TruncateToolOutputOptions } from "./truncation.js";

export interface ToolCall {
	id: string;
	name: string;
	input?: unknown;
}

export type ToolResultStatus = "success" | "error" | "denied" | "unknown" | "limit_exceeded" | "timeout";
export type ToolErrorCategory = "unknown_tool" | "policy_denied" | "limit_exceeded" | "timeout" | "abort" | "validation" | "network" | "protocol" | "unsupported" | "execution" | "hook" | "sandbox" | "mcp_error";
export type ToolErrorSource = "runtime" | "tool" | "mcp" | "policy" | "sandbox" | "hook";
export type ToolErrorPhase = "preflight" | "permission" | "execute" | "normalize" | "postprocess";

export interface ToolResult {
	call: ToolCall;
	decision: ToolDecision;
	status: ToolResultStatus;
	output?: unknown;
	errorMessage?: string;
	errorCategory?: ToolErrorCategory;
	errorSource?: ToolErrorSource;
	errorPhase?: ToolErrorPhase;
	retryable?: boolean;
	rawErrorName?: string;
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

export interface NormalizeToolResultOptions extends Partial<Pick<TruncateToolOutputOptions, "maxBytes" | "strategy" | "headBytes" | "tailBytes" | "includeMetadata">> {}

export interface NormalizedToolResultContent {
	content: string;
	metadata: ToolOutputTruncationMetadata;
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

	filterByAllowedTools(allowed: string[]): ToolRegistry {
		if (allowed.includes("*")) return this;
		const allowedSet = new Set(allowed);
		const filtered = this.list().filter((tool) => allowedSet.has(tool.name));
		return new ToolRegistry(filtered, { ...(this.options.sandboxPolicy ? { sandboxPolicy: this.options.sandboxPolicy } : {}) });
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
			return this.finalize(session, hooks, withTiming(withToolError({ call, decision: limitDecision, status: "limit_exceeded", errorMessage: limitDecision.reason }, "limit_exceeded", "runtime", "preflight", false), startedAt));
		}

		session.toolCallCount += 1;
		const tool = this.get(call.name);
		if (!tool) {
			const decision = { decision: "deny" as const, reason: `tool ${call.name} is not registered` };
			return this.finalize(session, hooks, withTiming(withToolError({ call, decision, status: "unknown", errorMessage: `Unknown tool: ${call.name}` }, "unknown_tool", "runtime", "preflight", false), startedAt));
		}

		let currentCall = call;
		let decision = decideToolUse(session.agent, session.task, tool);
		if (decision.decision !== "allow") {
			return this.finalize(session, hooks, withTiming(withToolLimits(tool, withToolError({ call: currentCall, decision, status: "denied", errorMessage: decision.reason }, "policy_denied", "policy", "permission", false)), startedAt));
		}

		for (const hook of hooks) {
			const hookResult = await hook.beforeToolCall?.(session, currentCall);
			if (!hookResult) continue;
			if (hookResult.decision === "deny") {
				decision = { decision: "deny", reason: hookResult.reason };
				return this.finalize(session, hooks, withTiming(withToolLimits(tool, withToolError({
					call: currentCall,
					decision,
					status: "denied",
					errorMessage: hookResult.reason,
					metadata: { hookDecision: "deny" },
				}, "hook", "hook", "permission", false)), startedAt));
			}
			if (hookResult.decision === "mutate") {
				currentCall = { ...currentCall, input: hookResult.input };
			}
		}

		if (this.options.sandboxPolicy) {
			const sandboxDecision = decideSandboxUse({ session, tool, call: currentCall, policy: this.options.sandboxPolicy });
			if (sandboxDecision.decision !== "allow") {
				decision = { decision: "deny", reason: sandboxDecision.reason };
				return this.finalize(session, hooks, withTiming(withToolLimits(tool, withToolError({
					call: currentCall,
					decision,
					status: "denied",
					errorMessage: sandboxDecision.reason,
					metadata: { sandboxDecision: "deny", ...sandboxDecision.metadata },
				}, "sandbox", "sandbox", "permission", false)), startedAt));
			}
		}

		try {
			const output = await executeWithTimeout(tool, currentCall.input, signal, { session, call: currentCall, ...(this.options.sandboxPolicy?.mode ? { sandboxMode: this.options.sandboxPolicy.mode } : {}) });
			return this.finalize(session, hooks, withTiming(withToolLimits(tool, { call: currentCall, decision, status: "success", output }), startedAt));
		} catch (error) {
			const classification = classifyToolError(error, currentCall.name);
			if (classification.category === "abort") throw error;
			return this.finalize(session, hooks, withTiming(withToolLimits(tool, withToolError({
				call: currentCall,
				decision,
				status: classification.category === "timeout" ? "timeout" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			}, classification.category, classification.source, classification.phase, classification.retryable, error instanceof Error ? error.name : undefined)), startedAt));
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
	return normalizeToolResultForModel(result, options).content;
}

export function normalizeToolResultForModel(result: ToolResult, options: NormalizeToolResultOptions = {}): NormalizedToolResultContent {
	const maxBytes = options.maxBytes ?? result.maxResultBytes ?? defaultMaxResultBytes;
	const value = result.errorMessage
		? { status: result.status, error: result.errorMessage, category: result.errorCategory, source: result.errorSource, phase: result.errorPhase, retryable: result.retryable }
		: result.output ?? null;
	return truncateToolOutput(safeStringify(value), {
		maxBytes,
		strategy: options.strategy ?? "head-tail",
		...(options.headBytes === undefined ? {} : { headBytes: options.headBytes }),
		...(options.tailBytes === undefined ? {} : { tailBytes: options.tailBytes }),
		includeMetadata: options.includeMetadata ?? true,
	});
}

function withTiming(result: Omit<ToolResult, "startedAt" | "endedAt" | "durationMs">, startedAt: number): ToolResult {
	const endedAt = Date.now();
	return { ...result, startedAt, endedAt, durationMs: endedAt - startedAt };
}

function withToolError<T extends Omit<ToolResult, "startedAt" | "endedAt" | "durationMs">>(result: T, category: ToolErrorCategory, source: ToolErrorSource, phase: ToolErrorPhase, retryable: boolean, rawErrorName?: string): T {
	return {
		...result,
		errorCategory: category,
		errorSource: source,
		errorPhase: phase,
		retryable,
		...(rawErrorName ? { rawErrorName } : {}),
	};
}

function classifyToolError(error: unknown, toolName: string): { category: ToolErrorCategory; source: ToolErrorSource; phase: ToolErrorPhase; retryable: boolean } {
	if (error instanceof ToolTimeoutError) return { category: "timeout", source: "runtime", phase: "execute", retryable: true };
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error);
	if (name === "McpToolCallError") return { category: "mcp_error", source: "mcp", phase: "execute", retryable: false };
	if (isAbortError(error)) return { category: "abort", source: "runtime", phase: "execute", retryable: false };
	if (name === "WebFetchRequestTimeoutError" || message.includes("timed out")) return { category: "timeout", source: toolName === "web_fetch" ? "tool" : "runtime", phase: "execute", retryable: true };
	if (toolName === "web_fetch" && /HTTP request failed|fetch failed|network|ENOTFOUND|ECONN|attempt/.test(message)) return { category: "network", source: "tool", phase: "execute", retryable: true };
	if (/requires input|must be|invalid|Invalid|expected/.test(message)) return { category: "validation", source: "tool", phase: "execute", retryable: false };
	return { category: "execution", source: "tool", phase: "execute", retryable: false };
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

