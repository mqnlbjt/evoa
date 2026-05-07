import { hashText } from "./extractor.js";
import { effectiveScope } from "./resolution.js";
import type { MemoryManager } from "./manager.js";
import type { MemoryItem, MemoryScope, StoredMemoryLayer } from "./types.js";
import type { EvolvingAgentTool, ToolExecutionContext } from "../tools/types.js";
import { objectInput, optionalBooleanField, optionalNumberField, optionalStringField, stringField, throwIfAborted } from "../tools/workspace.js";

export const memoryToolNames = ["memory_context", "memory_search", "memory_read", "memory_remember", "memory_update", "memory_forget"] as const;

export interface MemoryToolOptions {
	manager: MemoryManager;
	projectId?: string;
	now: () => number;
	createId: () => string;
	maxReturnedItems?: number;
	maxContentChars?: number;
}

interface ResolvedMemoryToolOptions extends MemoryToolOptions {
	maxReturnedItems: number;
	maxContentChars: number;
}

export function createMemoryTools(options: MemoryToolOptions): EvolvingAgentTool[] {
	const resolved = resolveOptions(options);
	return [memoryContextTool(resolved), memorySearchTool(resolved), memoryReadTool(resolved), memoryRememberTool(resolved), memoryUpdateTool(resolved), memoryForgetTool(resolved)];
}

function memoryContextTool(options: ResolvedMemoryToolOptions): EvolvingAgentTool {
	return {
		name: "memory_context",
		description: "Load relevant long-term memory for the current turn. Use before answering questions that may depend on remembered user preferences, identity, project facts, or durable instructions.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" }, maxStableItems: { type: "number" }, maxDynamicItems: { type: "number" } },
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "low" },
		concurrency: "parallel-safe",
		timeoutMs: 5_000,
		async execute(input, signal, context) {
			throwIfAborted(signal);
			const parsed = objectInput(input ?? {});
			const request = baseRequest(options, context, optionalStringField(parsed, "query") ?? context?.session.task.prompt ?? "");
			const maxStableItems = optionalPositiveNumber(parsed, "maxStableItems");
			const maxDynamicItems = optionalPositiveNumber(parsed, "maxDynamicItems");
			const items = await options.manager.loadContextItems({ ...request, ...(maxStableItems !== undefined ? { maxStableItems } : {}), ...(maxDynamicItems !== undefined ? { maxDynamicItems } : {}) });
			return {
				stable: items.stable.map((item) => summarizeItem(item, options.maxContentChars)),
				dynamic: items.dynamic.map((item) => summarizeItem(item, options.maxContentChars)),
				stableItemIds: items.stable.map((item) => item.id),
				dynamicItemIds: items.dynamic.map((item) => item.id),
			};
		},
	};
}

function memorySearchTool(options: ResolvedMemoryToolOptions): EvolvingAgentTool {
	return {
		name: "memory_search",
		description: "Search verified long-term memory by query. Use when you need remembered facts, preferences, project constraints, or prior durable instructions.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" }, scope: { type: "string", enum: ["user", "project", "agent", "session"] }, layer: { type: "string", enum: ["episode", "knowledge", "doctrine"] }, limit: { type: "number" } },
			required: ["query"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "low" },
		concurrency: "parallel-safe",
		timeoutMs: 5_000,
		async execute(input, signal, context) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const query = stringField(parsed, "query");
			const scope = scopeField(parsed, "scope");
			const layer = layerField(parsed, "layer");
			const limit = Math.min(optionalPositiveNumber(parsed, "limit") ?? options.maxReturnedItems, options.maxReturnedItems);
			const items = await options.manager.search({ ...baseRequest(options, context, query), query, ...(scope ? { scope } : {}), ...(layer ? { layer } : {}), limit });
			return { query, items: items.map((item) => summarizeItem(item, options.maxContentChars)), truncated: items.length >= options.maxReturnedItems };
		},
	};
}

function memoryReadTool(options: ResolvedMemoryToolOptions): EvolvingAgentTool {
	return {
		name: "memory_read",
		description: "Read specific long-term memory items by id after searching or receiving memory ids.",
		inputSchema: {
			type: "object",
			properties: { ids: { type: "array", items: { type: "string" } } },
			required: ["ids"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "low" },
		concurrency: "parallel-safe",
		timeoutMs: 5_000,
		async execute(input, signal, context) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const result = await options.manager.read({ ...baseRequest(options, context), ids: stringArrayField(parsed, "ids").slice(0, options.maxReturnedItems) });
			return { items: result.items.map((item) => detailItem(item, options.maxContentChars)), missing: result.missing };
		},
	};
}

function memoryRememberTool(options: ResolvedMemoryToolOptions): EvolvingAgentTool {
	return {
		name: "memory_remember",
		description: "Persist a durable long-term memory when the user explicitly asks to remember a fact, preference, project constraint, or rule.",
		inputSchema: {
			type: "object",
			properties: { content: { type: "string" }, layer: { type: "string", enum: ["episode", "knowledge", "doctrine"] }, scope: { type: "string", enum: ["user", "project", "agent", "session"] }, topic: { type: "string" }, key: { type: "string" }, stable: { type: "boolean" }, reason: { type: "string" }, supersedes: { type: "array", items: { type: "string" } } },
			required: ["content", "layer", "scope"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "medium" },
		concurrency: "sequential",
		timeoutMs: 5_000,
		async execute(input, signal, context) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const item = await options.manager.recordManualMemory({
				...baseRequest(options, context),
				content: stringField(parsed, "content"),
				layer: requiredLayer(parsed, "layer"),
				scope: requiredScope(parsed, "scope"),
				...manualOptionalFields(parsed),
				sourceRef: toolSourceRef(context),
				createId: options.createId,
			});
			return { item: detailItem(item, options.maxContentChars) };
		},
	};
}

function memoryUpdateTool(options: ResolvedMemoryToolOptions): EvolvingAgentTool {
	return {
		name: "memory_update",
		description: "Replace an existing long-term memory with corrected content. This appends a replacement and supersedes the previous memory id.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" }, content: { type: "string" }, reason: { type: "string" }, topic: { type: "string" }, key: { type: "string" }, stable: { type: "boolean" } },
			required: ["id", "content", "reason"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "medium" },
		concurrency: "sequential",
		timeoutMs: 5_000,
		async execute(input, signal, context) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const previousId = stringField(parsed, "id");
			const item = await options.manager.updateMemory({
				...baseRequest(options, context),
				id: previousId,
				content: stringField(parsed, "content"),
				reason: stringField(parsed, "reason"),
				...updateOptionalFields(parsed),
				sourceRef: toolSourceRef(context),
				createId: options.createId,
			});
			return item ? { previousId, item: detailItem(item, options.maxContentChars) } : { previousId, missing: true };
		},
	};
}

function memoryForgetTool(options: ResolvedMemoryToolOptions): EvolvingAgentTool {
	return {
		name: "memory_forget",
		description: "Revoke remembered long-term memory items when the user asks to forget or remove them.",
		inputSchema: {
			type: "object",
			properties: { ids: { type: "array", items: { type: "string" } }, reason: { type: "string" } },
			required: ["ids", "reason"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "medium" },
		concurrency: "sequential",
		timeoutMs: 5_000,
		async execute(input, signal, context) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			return options.manager.forgetMemories({ ...baseRequest(options, context), ids: stringArrayField(parsed, "ids").slice(0, options.maxReturnedItems), reason: stringField(parsed, "reason"), sourceRef: toolSourceRef(context), createId: options.createId });
		},
	};
}

function baseRequest(options: ResolvedMemoryToolOptions, context?: ToolExecutionContext, prompt = context?.session.task.prompt ?? "") {
	if (!context) throw new Error("memory tools require runtime context");
	return { agentId: context.session.agent.id, sessionId: context.session.id, ...(options.projectId ? { projectId: options.projectId } : {}), prompt, now: options.now };
}

function toolSourceRef(context?: ToolExecutionContext) {
	if (!context) throw new Error("memory tools require runtime context");
	const id = `${context.session.id}:${context.call.id}`;
	return { kind: "trace_event" as const, id, sessionId: context.session.id, traceEventId: context.call.id, excerptHash: hashText(JSON.stringify(context.call.input ?? null)) };
}

function manualOptionalFields(input: Record<string, unknown>) {
	const topic = optionalStringField(input, "topic");
	const key = optionalStringField(input, "key");
	const stable = optionalBooleanField(input, "stable");
	const reason = optionalStringField(input, "reason");
	const supersedes = optionalStringArrayField(input, "supersedes");
	return { ...(topic ? { topic } : {}), ...(key ? { key } : {}), ...(stable !== undefined ? { stable } : {}), ...(reason ? { reason } : {}), ...(supersedes ? { supersedes } : {}) };
}

function updateOptionalFields(input: Record<string, unknown>) {
	const topic = optionalStringField(input, "topic");
	const key = optionalStringField(input, "key");
	const stable = optionalBooleanField(input, "stable");
	return { ...(topic ? { topic } : {}), ...(key ? { key } : {}), ...(stable !== undefined ? { stable } : {}) };
}

function summarizeItem(item: MemoryItem, maxContentChars: number) {
	return { id: item.id, scope: effectiveScope(item), layer: item.layer, content: truncate(item.content, maxContentChars), confidence: item.confidence, updatedAt: item.updatedAt, ...(item.metadata ? { metadata: publicMetadata(item.metadata) } : {}) };
}

function detailItem(item: MemoryItem, maxContentChars: number) {
	return { ...summarizeItem(item, maxContentChars), status: item.status, sourceRefs: item.sourceRefs.map((ref) => ({ kind: ref.kind, id: ref.id, ...(ref.sessionId ? { sessionId: ref.sessionId } : {}), ...(ref.traceEventId ? { traceEventId: ref.traceEventId } : {}), ...(ref.messageIndex !== undefined ? { messageIndex: ref.messageIndex } : {}) })) };
}

function publicMetadata(metadata: NonNullable<MemoryItem["metadata"]>) {
	return { ...(metadata.topic ? { topic: metadata.topic } : {}), ...(metadata.stable !== undefined ? { stable: metadata.stable } : {}), ...(metadata.reason ? { reason: metadata.reason } : {}), ...(metadata.key ? { key: metadata.key } : {}), ...(metadata.projectId ? { projectId: metadata.projectId } : {}), ...(metadata.expiresAt !== undefined ? { expiresAt: metadata.expiresAt } : {}), ...(metadata.staleAfterMs !== undefined ? { staleAfterMs: metadata.staleAfterMs } : {}), ...(metadata.priority !== undefined ? { priority: metadata.priority } : {}), ...(metadata.supersedes?.length ? { supersedes: metadata.supersedes } : {}) };
}

function resolveOptions(options: MemoryToolOptions): ResolvedMemoryToolOptions {
	return { ...options, maxReturnedItems: options.maxReturnedItems ?? 20, maxContentChars: options.maxContentChars ?? 320 };
}

function optionalPositiveNumber(input: Record<string, unknown>, key: string): number | undefined {
	const value = optionalNumberField(input, key);
	if (value === undefined) return undefined;
	if (value < 1) throw new Error(`${key} must be a positive number`);
	return Math.floor(value);
}

function stringArrayField(input: Record<string, unknown>, key: string): string[] {
	const value = input[key];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(`${key} must be an array of non-empty strings`);
	return value;
}

function optionalStringArrayField(input: Record<string, unknown>, key: string): string[] | undefined {
	if (input[key] === undefined) return undefined;
	return stringArrayField(input, key);
}

function requiredLayer(input: Record<string, unknown>, key: string): StoredMemoryLayer {
	const value = stringField(input, key);
	if (value === "episode" || value === "knowledge" || value === "doctrine") return value;
	throw new Error(`${key} must be episode, knowledge, or doctrine`);
}

function layerField(input: Record<string, unknown>, key: string): StoredMemoryLayer | undefined {
	const value = optionalStringField(input, key);
	if (value === undefined) return undefined;
	if (value === "episode" || value === "knowledge" || value === "doctrine") return value;
	throw new Error(`${key} must be episode, knowledge, or doctrine`);
}

function requiredScope(input: Record<string, unknown>, key: string): MemoryScope {
	const value = stringField(input, key);
	if (value === "user" || value === "project" || value === "agent" || value === "session") return value;
	throw new Error(`${key} must be user, project, agent, or session`);
}

function scopeField(input: Record<string, unknown>, key: string): MemoryScope | undefined {
	const value = optionalStringField(input, key);
	if (value === undefined) return undefined;
	if (value === "user" || value === "project" || value === "agent" || value === "session") return value;
	throw new Error(`${key} must be user, project, agent, or session`);
}

function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : value.slice(0, maxChars).trimEnd();
}
