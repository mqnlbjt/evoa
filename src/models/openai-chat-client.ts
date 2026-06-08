import { resolveReasoningPolicy, shouldSendReasoningHistory, shouldReturnReasoning } from "./reasoning.js";
import type { ModelClient, ModelContentBlock, ModelRequest, ModelResponse, ModelToolCall, ModelToolDefinition, ModelUsage } from "./types.js";

export interface OpenAIChatModelClientOptions {
	apiKey?: string;
	baseURL?: string;
	defaultHeaders?: Record<string, string>;
	temperature?: number;
	maxOutputTokens?: number;
	fetchFn?: typeof fetch;
}

export class OpenAIChatModelClient implements ModelClient {
	private readonly fetchFn: typeof fetch;

	constructor(private readonly options: OpenAIChatModelClientOptions = {}) {
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
		if (request.stream) return this.streamComplete(request, signal);
		return this.nonStreamComplete(request, signal);
	}

	private async nonStreamComplete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
		const body = buildChatBody(request, this.options);
		const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY;
		if (!apiKey) throw new Error("OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey.");

		const response = await this.fetchFn(`${normalizeBaseURL(this.options.baseURL)}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...this.options.defaultHeaders },
			body: JSON.stringify(body),
			...(signal ? { signal } : {}),
		});

		const json = await response.json() as Record<string, unknown>;
		if (!response.ok) {
			const err = json.error as Record<string, unknown> | undefined;
			throw new Error(err?.message ? String(err.message) : `Chat Completions request failed with status ${response.status}`);
		}

		return parseChatResponse(json, request);
	}

	private async streamComplete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
		const body = { ...buildChatBody(request, this.options), stream: true };
		const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY;
		if (!apiKey) throw new Error("OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey.");

		const response = await this.fetchFn(`${normalizeBaseURL(this.options.baseURL)}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...this.options.defaultHeaders },
			body: JSON.stringify(body),
			...(signal ? { signal } : {}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			let message = `Chat Completions streaming request failed with status ${response.status}`;
			try {
				const parsed = JSON.parse(errorText);
				if (parsed.error?.message) message = parsed.error.message;
			} catch { /* use default message */ }
			throw new Error(message);
		}
		if (!response.body) throw new Error("Chat Completions streaming response has no body");

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const state = createStreamState();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("data: ")) continue;
					const data = trimmed.slice(6);
					if (data === "[DONE]") continue;
					let event: Record<string, unknown>;
					try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
					processStreamEvent(state, event, request);
				}
			}
		} finally {
			reader.releaseLock();
		}

		return streamResponseFromState(state, request);
	}
}

interface StreamState {
	fullText: string;
	reasoningParts: string[];
	toolCalls: Array<{ id: string; name: string; json: string }>;
	chatToolCalls: Map<number, { id: string; name: string; json: string }>;
	usage?: ModelUsage;
	requestId: string;
}

function createStreamState(): StreamState {
	return { fullText: "", reasoningParts: [], toolCalls: [], chatToolCalls: new Map(), requestId: "" };
}

function processStreamEvent(state: StreamState, event: Record<string, unknown>, request: ModelRequest): void {
	for (const raw of toArray(event.choices)) {
		const choice = asRecord(raw);
		const delta = asRecord(choice.delta);
		const content = stringField(delta, "content");
		if (content) {
			state.fullText += content;
			request.streamCallbacks?.onTextDelta?.(content, state.fullText);
		}
		const reasoning = stringField(delta, "reasoning") ?? stringField(delta, "reasoning_content");
		if (reasoning) {
			state.reasoningParts.push(reasoning);
			request.streamCallbacks?.onReasoningDelta?.(reasoning, state.reasoningParts.join(""));
		}
		for (const call of toArray(delta.tool_calls)) {
			const tc = asRecord(call);
			const index = typeof tc.index === "number" ? tc.index : 0;
			const current = state.chatToolCalls.get(index) ?? { id: "", name: "", json: "" };
			const id = stringField(tc, "id");
			if (id) current.id = id;
			const fn = asRecord(tc.function);
			const name = stringField(fn, "name");
			if (name) current.name = name;
			const args = stringField(fn, "arguments");
			if (args) current.json += args;
			state.chatToolCalls.set(index, current);
		}
	}
	const usage = normalizeUsage(event.usage);
	if (usage) state.usage = usage;
	const reqId = stringField(event, "_request_id");
	if (reqId) state.requestId = reqId;
}

function streamResponseFromState(state: StreamState, request: ModelRequest): ModelResponse {
	const rawCalls = [...state.toolCalls, ...state.chatToolCalls.values()].filter((call) => call.id && call.name);
	const toolCalls = rawCalls.map((call) => ({ id: call.id, name: call.name, input: parseToolInput(call.json) }));
	const policy = resolveReasoningPolicy(request.agent.model, "chat-compatible");
	const reasoning = shouldReturnReasoning(policy, toolCalls) ? joinUnique(state.reasoningParts) : undefined;
	return {
		text: state.fullText,
		...(reasoning !== undefined ? { reasoning } : {}),
		...(toolCalls.length > 0 ? { toolCalls } : {}),
		...(state.requestId ? { requestId: state.requestId } : {}),
		...(state.usage ? { usage: state.usage } : {}),
		metadata: {
			...(state.requestId ? { requestId: state.requestId } : {}),
			...(state.usage ? { usage: { input_tokens: state.usage.inputTokens, output_tokens: state.usage.outputTokens } } : {}),
		},
	};
}

function joinUnique(parts: string[]): string | undefined {
	const nonEmpty = parts.filter((part) => part.length > 0);
	if (nonEmpty.length === 0) return undefined;
	const combined = nonEmpty.join("");
	const last = nonEmpty[nonEmpty.length - 1]!;
	return nonEmpty.length > 1 && combined.slice(0, -last.length) === last ? last : combined;
}

function buildChatBody(request: ModelRequest, options: OpenAIChatModelClientOptions): Record<string, unknown> {
	const messages = buildChatMessages(request);
	const body: Record<string, unknown> = {
		model: request.agent.model.model,
		messages,
		stream: false,
	};
	if (options.temperature !== undefined) body.temperature = options.temperature;
	if (options.maxOutputTokens !== undefined) body.max_tokens = options.maxOutputTokens;
	applyChatReasoningParams(body, request);
	if (request.tools?.length) body.tools = request.tools.map(toChatTool);
	return body;
}

function buildChatMessages(request: ModelRequest): unknown[] {
	const messages: unknown[] = [];
	const policy = resolveReasoningPolicy(request.agent.model, "chat-compatible");

	for (const message of request.messages) {
		if (message.role === "system") {
			messages.push({ role: "system", content: message.content });
			continue;
		}
		if (message.role === "tool") {
			const result = message.contentBlocks?.find((block): block is Extract<ModelContentBlock, { type: "tool_result" }> => block.type === "tool_result");
			messages.push({
				role: "tool",
				tool_call_id: result?.toolCallId ?? message.toolCallId ?? "",
				content: result?.content ?? message.content,
			});
			continue;
		}
		if (message.role === "assistant") {
			const toolCalls = message.contentBlocks?.filter((block): block is Extract<ModelContentBlock, { type: "tool_call" }> => block.type === "tool_call") ?? [];
			const reasoning = message.contentBlocks?.find((block): block is Extract<ModelContentBlock, { type: "reasoning" }> => block.type === "reasoning");
			// Always include reasoning_content on assistant messages.
			// DeepSeek requires it on ALL subsequent messages after a tool call.
			// Other providers ignore the field if not applicable.
			messages.push({
				role: "assistant",
				content: message.content || null,
				reasoning_content: reasoning?.text ?? "",
				...(toolCalls.length > 0 ? {
					tool_calls: toolCalls.map((call) => ({
						id: call.id,
						type: "function",
						function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
					})),
				} : {}),
			});
			continue;
		}
		messages.push({ role: message.role, content: message.content });
	}
	return messages;
}

function applyChatReasoningParams(body: Record<string, unknown>, request: ModelRequest): void {
	const policy = resolveReasoningPolicy(request.agent.model, "chat-compatible");
	if (!policy.enabled) return;
	if (policy.requestField === "extra_body.thinking") {
		body.extra_body = { ...(body.extra_body as Record<string, unknown> ?? {}), thinking: { type: policy.thinkingType }, reasoning_effort: policy.effort };
		return;
	}
	body.reasoning_effort = policy.effort;
}

function toChatTool(tool: ModelToolDefinition): unknown {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
		},
	};
}

function parseChatResponse(json: Record<string, unknown>, request: ModelRequest): ModelResponse {
	const choices = toArray(json.choices);
	const first = asRecord(choices[0]);
	const message = asRecord(first.message);
	const content = typeof message.content === "string" ? message.content : "";
	const toolCalls = parseChatToolCalls(message.tool_calls);
	const policy = resolveReasoningPolicy(request.agent.model, "chat-compatible");
	const rawReasoning = message.reasoning ?? message.reasoning_content;
	const reasoningContent = typeof rawReasoning === "string" && rawReasoning.length > 0 ? rawReasoning : undefined;
	const reasoning = reasoningContent !== undefined && shouldReturnReasoning(policy, toolCalls) ? reasoningContent : undefined;
	const usage = normalizeUsage(json.usage);
	const requestId = stringField(json, "id");
	const finishReason = stringField(first, "finish_reason");

	return {
		text: content,
		...(reasoning !== undefined ? { reasoning } : {}),
		...(toolCalls.length > 0 ? { toolCalls } : {}),
		...(requestId ? { requestId } : {}),
		...(usage ? { usage } : {}),
		metadata: {
			...(requestId ? { requestId } : {}),
			...(usage ? { usage } : {}),
			...(finishReason ? { finishReason } : {}),
		},
	};
}

function parseChatToolCalls(value: unknown): ModelToolCall[] {
	const calls = toArray(value);
	return calls.reduce<ModelToolCall[]>((acc, raw) => {
		const tc = asRecord(raw);
		const id = stringField(tc, "id");
		const fn = asRecord(tc.function);
		const name = stringField(fn, "name");
		if (!id || !name) return acc;
		const args = stringField(fn, "arguments");
		acc.push({ id, name, ...(args ? { input: parseToolInput(args) } : {}) });
		return acc;
	}, []);
}

function parseToolInput(json: string): unknown {
	try { return JSON.parse(json); } catch { return { raw: json }; }
}

function normalizeUsage(value: unknown): ModelUsage | undefined {
	const usage = asRecord(value);
	const inputTokens = numberAny(usage, ["input_tokens", "prompt_tokens", "inputTokens"]);
	const outputTokens = numberAny(usage, ["output_tokens", "completion_tokens", "outputTokens"]);
	const detailsOutput = asRecord(usage.output_tokens_details ?? usage.completion_tokens_details);
	const detailsInput = asRecord(usage.input_tokens_details ?? usage.prompt_tokens_details);
	const reasoningTokens = numberField(detailsOutput, "reasoning_tokens") ?? numberField(usage, "reasoning_tokens");
	const cacheReadTokens = numberField(detailsInput, "cached_tokens") ?? numberField(usage, "cached_tokens");
	const adjInputTokens = inputTokens === undefined ? undefined : Math.max(0, inputTokens - (cacheReadTokens ?? 0));
	const totalTokens = numberAny(usage, ["total_tokens", "totalTokens"]) ?? sumKnown([adjInputTokens, cacheReadTokens, outputTokens]);
	const costUsd = numberAny(usage, ["cost_usd", "costUsd", "cost"]);
	if ([adjInputTokens, outputTokens, totalTokens, reasoningTokens, cacheReadTokens, costUsd].every((item) => item === undefined)) return undefined;
	return {
		...(adjInputTokens === undefined ? {} : { inputTokens: adjInputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(totalTokens === undefined ? {} : { totalTokens }),
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(costUsd === undefined ? {} : { costUsd }),
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
	const v = obj[key];
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function numberAny(obj: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const v = numberField(obj, key);
		if (v !== undefined) return v;
	}
	return undefined;
}

function sumKnown(values: Array<number | undefined>): number | undefined {
	if (!values.some((v) => v !== undefined)) return undefined;
	return values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
}

function normalizeBaseURL(baseURL = "https://api.openai.com/v1"): string {
	return baseURL.replace(/\/+$/, "");
}
