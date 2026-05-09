import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses.js";
import { openAIPromptCacheParams, resolveCacheRetention } from "./cache.js";
import type { ModelClient, ModelContentBlock, ModelRequest, ModelResponse, ModelToolCall, ModelToolDefinition, ModelUsage } from "./types.js";

export interface OpenAIModelClientOptions {
	apiKey?: string;
	baseURL?: string;
	defaultHeaders?: Record<string, string>;
	temperature?: number;
	maxOutputTokens?: number;
	store?: boolean;
	client?: OpenAIResponsesClient;
	fetchFn?: typeof fetch;
}

interface OpenAIOutputItemLike {
	type?: string;
	id?: string;
	call_id?: string | null;
	name?: string;
	arguments?: string;
	content?: string | OpenAIOutputContentLike[] | OpenAIOutputContentLike;
	reasoning_content?: string;
	summary?: Array<{ text?: string }>;
}

interface OpenAIOutputContentLike {
	type?: string;
	text?: string;
	reasoning_content?: string;
	content?: string;
}

interface OpenAIChatMessageLike {
	content?: string | OpenAIOutputContentLike[] | OpenAIOutputContentLike | null;
	reasoning_content?: string | null;
	tool_calls?: OpenAIChatToolCallLike[] | null;
}

interface OpenAIChatToolCallLike {
	id?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

interface OpenAIChatChoiceLike {
	message?: OpenAIChatMessageLike;
}

interface OpenAIErrorResponseLike {
	error?: { message?: string };
}

export interface OpenAIResponseLike {
	output_text?: string | undefined;
	output?: OpenAIOutputItemLike[] | OpenAIOutputItemLike | undefined;
	choices?: OpenAIChatChoiceLike[] | undefined;
	usage?: unknown;
	_request_id?: string | null | undefined;
}

type ResponseCreateParamsWithPromptCache = ResponseCreateParamsNonStreaming & {
	prompt_cache_key?: string;
	prompt_cache_retention?: "24h";
};

export interface OpenAIResponsesClient {
	responses: {
		create(
			params: ResponseCreateParamsWithPromptCache,
			options?: { signal?: AbortSignal },
		): Promise<OpenAIResponseLike>;
	};
}

export class OpenAIModelClient implements ModelClient {
	private readonly fetchFn: typeof fetch;

	constructor(private readonly options: OpenAIModelClientOptions = {}) {
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
		const params = this.buildParams(request);
		const response = this.options.client ? await this.options.client.responses.create(params, signal ? { signal } : undefined) : await this.createResponse(params, signal);
		const toolCalls = parseToolCalls(response);
		const reasoning = parseReasoning(response);
		const usage = normalizeUsage(response.usage);
		const finishReason = response.choices?.[0]?.message ? (response.choices[0] as Record<string, unknown>).finish_reason as string | undefined : undefined;
		return {
			text: parseResponseText(response),
			...(reasoning ? { reasoning } : {}),
			...(toolCalls.length > 0 ? { toolCalls } : {}),
			...(response._request_id ? { requestId: response._request_id } : {}),
			...(usage ? { usage } : {}),
			metadata: {
				...(response._request_id ? { requestId: response._request_id } : {}),
				...(response.usage ? { usage: response.usage } : {}),
				...(finishReason ? { finishReason } : {}),
			},
		};
	}

	private async createResponse(params: ResponseCreateParamsWithPromptCache, signal?: AbortSignal): Promise<OpenAIResponseLike> {
		const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY;
		if (!apiKey) throw new Error("OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey.");
		const response = await this.fetchFn(`${normalizeBaseURL(this.options.baseURL)}/responses`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
				...this.options.defaultHeaders,
			},
			body: JSON.stringify(params),
			...(signal ? { signal } : {}),
		});
		const body = (await response.json()) as OpenAIResponseLike | OpenAIErrorResponseLike;
		if (!response.ok) throw new Error("error" in body ? body.error?.message ?? `OpenAI responses request failed with status ${response.status}` : `OpenAI responses request failed with status ${response.status}`);
		return body as OpenAIResponseLike;
	}

	private buildParams(request: ModelRequest): ResponseCreateParamsWithPromptCache {
		const params: ResponseCreateParamsWithPromptCache = {
			model: request.agent.model.model,
			instructions: request.agent.prompts.system,
			input: buildInput(request),
			store: this.options.store ?? false,
			...openAIPromptCacheParams(request.sessionId, resolveCacheRetention(request), this.options.baseURL),
		};

		if (this.options.temperature !== undefined) {
			params.temperature = this.options.temperature;
		}
		if (this.options.maxOutputTokens !== undefined) {
			params.max_output_tokens = this.options.maxOutputTokens;
		}
		if (request.agent.model.reasoningLevel && request.agent.model.reasoningLevel !== "off") {
			params.reasoning = { effort: request.agent.model.reasoningLevel };
		}
		if (request.tools?.length) {
			params.tools = request.tools.map(toOpenAITool) as NonNullable<ResponseCreateParamsNonStreaming["tools"]>;
		}

		return params;
	}
}

function buildInput(request: ModelRequest): NonNullable<ResponseCreateParamsNonStreaming["input"]> {
	const input: unknown[] = [];
	for (const message of request.messages.filter((message) => message.role !== "system")) {
		if (message.role === "tool") {
			const result = message.contentBlocks?.find((block): block is Extract<ModelContentBlock, { type: "tool_result" }> => block.type === "tool_result");
			input.push({
				type: "function_call_output",
				call_id: result?.toolCallId ?? message.toolCallId ?? "",
				output: result?.content ?? message.content,
				...(result?.toolName ?? message.toolName ? { name: result?.toolName ?? message.toolName } : {}),
			});
			continue;
		}
		const toolCalls = message.contentBlocks?.filter((block): block is Extract<ModelContentBlock, { type: "tool_call" }> => block.type === "tool_call") ?? [];
		const reasoning = message.contentBlocks?.find((block): block is Extract<ModelContentBlock, { type: "reasoning" }> => block.type === "reasoning");
		if (message.role === "assistant" && (toolCalls.length > 0 || reasoning)) {
			input.push(...assistantHistoryItem(message, reasoning, toolCalls));
			continue;
		}
		input.push({ role: message.role, content: message.content });
	}
	return input as NonNullable<ResponseCreateParamsNonStreaming["input"]>;
}

function assistantHistoryItem(message: { content: string }, reasoning: Extract<ModelContentBlock, { type: "reasoning" }> | undefined, toolCalls: Array<Extract<ModelContentBlock, { type: "tool_call" }>>): unknown[] {
	const items: unknown[] = [];
	if (message.content || reasoning) {
		items.push({ role: "assistant", content: message.content, ...(reasoning ? { reasoning_content: reasoning.text } : {}) });
	}
	items.push(...toolCalls.map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input ?? {}) })));
	return items;
}

function toOpenAITool(tool: ModelToolDefinition): unknown {
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema ?? emptySchema(),
	};
}

function outputItems(response: OpenAIResponseLike): OpenAIOutputItemLike[] {
	if (Array.isArray(response.output)) return response.output;
	return response.output ? [response.output] : [];
}

function parseToolCalls(response: OpenAIResponseLike): ModelToolCall[] {
	const calls: ModelToolCall[] = [];
	for (const item of outputItems(response)) {
		if (item.type !== "function_call" || !item.name) continue;
		const id = item.call_id ?? item.id;
		if (!id) continue;
		calls.push({
			id,
			name: item.name,
			...(item.arguments === undefined ? {} : { input: parseArguments(item.arguments) }),
		});
	}
	for (const call of response.choices?.[0]?.message?.tool_calls ?? []) {
		if (!call.id || !call.function?.name) continue;
		calls.push({
			id: call.id,
			name: call.function.name,
			...(call.function.arguments === undefined ? {} : { input: parseArguments(call.function.arguments) }),
		});
	}
	return calls;
}

function parseReasoning(response: OpenAIResponseLike): string | undefined {
	const parts: string[] = [];
	for (const item of outputItems(response)) {
		if (item.type === "reasoning") {
			if (item.reasoning_content) parts.push(item.reasoning_content);
			else if (typeof item.content === "string") parts.push(item.content);
			else if (item.summary?.length) parts.push(...item.summary.map((entry) => entry.text ?? "").filter((text) => text.length > 0));
		} else if (item.reasoning_content) parts.push(item.reasoning_content);
		if (Array.isArray(item.content)) parts.push(...reasoningContentParts(item.content));
	}
	const choiceReasoning = response.choices?.[0]?.message?.reasoning_content;
	if (choiceReasoning) parts.push(choiceReasoning);
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function parseResponseText(response: OpenAIResponseLike): string {
	return nonEmptyString(response.output_text) ?? parseChoiceText(response.choices?.[0]?.message?.content) ?? parseOutputText(response);
}

function parseChoiceText(content: OpenAIChatMessageLike["content"]): string | undefined {
	if (typeof content === "string") return nonEmptyString(content);
	if (Array.isArray(content)) return joinedText(content);
	return content ? joinedText([content]) : undefined;
}

function parseOutputText(response: OpenAIResponseLike): string {
	const parts: string[] = [];
	for (const item of outputItems(response)) {
		if (typeof item.content === "string" && item.type !== "reasoning") parts.push(item.content);
		else if (Array.isArray(item.content)) parts.push(...textContentParts(item.content));
		else if (item.content && typeof item.content === "object") parts.push(...textContentParts([item.content]));
	}
	return parts.join("");
}

function textContentParts(content: OpenAIOutputContentLike[]): string[] {
	return content.map((item) => item.text ?? item.content ?? "").filter((text) => text.length > 0);
}

function joinedText(content: OpenAIOutputContentLike[]): string | undefined {
	return nonEmptyString(textContentParts(content).join(""));
}

function nonEmptyString(value: string | null | undefined): string | undefined {
	return value && value.length > 0 ? value : undefined;
}

function reasoningContentParts(content: OpenAIOutputContentLike[]): string[] {
	return content.map((item) => item.reasoning_content ?? (item.type === "reasoning" ? item.text ?? item.content ?? "" : "")).filter((text) => text.length > 0);
}

function parseArguments(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return { raw: value };
	}
}

function normalizeUsage(value: unknown): ModelUsage | undefined {
	const usage = objectRecord(value);
	const rawInputTokens = numberAny(usage, ["input_tokens", "prompt_tokens", "inputTokens"]);
	const outputTokens = numberAny(usage, ["output_tokens", "completion_tokens", "outputTokens"]);
	const reasoningTokens = numberField(objectRecord(usage.output_tokens_details), "reasoning_tokens") ?? numberField(objectRecord(usage.completion_tokens_details), "reasoning_tokens") ?? numberField(usage, "reasoning_tokens");
	const cacheReadTokens = numberField(objectRecord(usage.input_tokens_details), "cached_tokens") ?? numberField(objectRecord(usage.prompt_tokens_details), "cached_tokens") ?? numberField(usage, "cached_tokens");
	const inputTokens = rawInputTokens === undefined ? undefined : Math.max(0, rawInputTokens - (cacheReadTokens ?? 0));
	const totalTokens = numberAny(usage, ["total_tokens", "totalTokens"]) ?? sumKnown([inputTokens, cacheReadTokens, outputTokens]);
	const costUsd = numberAny(usage, ["cost_usd", "costUsd", "cost"]);
	if ([inputTokens, outputTokens, totalTokens, reasoningTokens, cacheReadTokens, costUsd].every((item) => item === undefined)) return undefined;
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(totalTokens === undefined ? {} : { totalTokens }),
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(costUsd === undefined ? {} : { costUsd }),
	};
}

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function normalizeBaseURL(baseURL = "https://api.openai.com/v1"): string {
	return baseURL.replace(/\/+$/, "");
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
	const item = value[key];
	return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function numberAny(value: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const item = numberField(value, key);
		if (item !== undefined) return item;
	}
	return undefined;
}

function sumKnown(values: Array<number | undefined>): number | undefined {
	if (!values.some((value) => value !== undefined)) return undefined;
	return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function emptySchema(): Record<string, unknown> {
	return { type: "object", properties: {}, additionalProperties: false };
}
