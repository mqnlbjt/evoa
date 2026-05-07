import { anthropicCacheControl, resolveCacheRetention, type AnthropicCacheControl } from "./cache.js";
import type { ModelClient, ModelContentBlock, ModelMessage, ModelRequest, ModelResponse, ModelToolCall, ModelToolDefinition, ModelUsage } from "./types.js";

export interface AnthropicModelClientOptions {
	apiKey?: string;
	baseURL?: string;
	anthropicVersion?: string;
	maxTokens?: number;
	headers?: Record<string, string>;
	fetchFn?: typeof fetch;
}

interface AnthropicContentBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

interface AnthropicMessageResponse {
	id?: string;
	content?: AnthropicContentBlock[];
	model?: string;
	stop_reason?: string;
	usage?: unknown;
}

export class AnthropicModelClient implements ModelClient {
	private readonly fetchFn: typeof fetch;

	constructor(private readonly options: AnthropicModelClientOptions = {}) {
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
		const apiKey = this.options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
		if (!apiKey) {
			throw new Error("Anthropic API key is required. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or pass apiKey.");
		}

		const requestBody = buildBody(request, this.options.maxTokens ?? numberOption(request.agent.model.options?.maxTokens) ?? 1024, this.options.baseURL);
		const init: RequestInit = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": this.options.anthropicVersion ?? "2023-06-01",
				...this.options.headers,
			},
			body: JSON.stringify(requestBody),
			...(signal ? { signal } : {}),
		};
		const response = await this.fetchFn(`${normalizeBaseURL(this.options.baseURL)}/messages`, init);

		const body = (await response.json()) as AnthropicMessageResponse | { error?: { message?: string } };
		if (!response.ok) {
			const message = "error" in body ? body.error?.message : undefined;
			throw new Error(message ?? `Anthropic messages request failed with status ${response.status}`);
		}

		const data = body as AnthropicMessageResponse;
		const toolCalls = parseToolCalls(data.content ?? []);
		const usage = normalizeUsage(data.usage);
		return {
			text: data.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("") ?? "",
			...(toolCalls.length > 0 ? { toolCalls } : {}),
			...(data.id ? { requestId: data.id } : {}),
			...(usage ? { usage } : {}),
			metadata: {
				...(data.id ? { id: data.id } : {}),
				...(data.model ? { model: data.model } : {}),
				...(data.stop_reason ? { stopReason: data.stop_reason } : {}),
				...(data.usage ? { usage: data.usage } : {}),
			},
		};
	}
}

function buildBody(request: ModelRequest, maxTokens: number, baseURL?: string): Record<string, unknown> {
	const cacheControl = anthropicCacheControl(resolveCacheRetention(request), baseURL);
	return {
		model: request.agent.model.model,
		max_tokens: maxTokens,
		system: anthropicSystem(request.agent.prompts.system, cacheControl),
		messages: toAnthropicMessages(request.messages, cacheControl),
		...(request.tools?.length ? { tools: request.tools.map((tool, index) => toAnthropicTool(tool, index === request.tools!.length - 1 ? cacheControl : undefined)) } : {}),
	};
}

function anthropicSystem(system: string, cacheControl: AnthropicCacheControl | undefined): string | Array<Record<string, unknown>> {
	if (!cacheControl) return system;
	return [{ type: "text", text: system, cache_control: cacheControl }];
}

function toAnthropicMessages(messages: ModelMessage[], cacheControl: AnthropicCacheControl | undefined): Record<string, unknown>[] {
	const filtered = messages.filter((message) => message.role !== "system");
	const cacheIndex = cacheControl ? lastUserMessageIndex(filtered) : -1;
	return filtered.map((message, index) => toAnthropicMessage(message, index === cacheIndex ? cacheControl : undefined));
}

function lastUserMessageIndex(messages: ModelMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

function toAnthropicMessage(message: ModelMessage, cacheControl?: AnthropicCacheControl): Record<string, unknown> {
	if (message.role === "tool") {
		const result = message.contentBlocks?.find((block): block is Extract<ModelContentBlock, { type: "tool_result" }> => block.type === "tool_result");
		return {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: result?.toolCallId ?? message.toolCallId ?? "",
					content: result?.content ?? message.content,
				},
			],
		};
	}
	const toolCalls = message.contentBlocks?.filter((block): block is Extract<ModelContentBlock, { type: "tool_call" }> => block.type === "tool_call") ?? [];
	if (message.role === "assistant" && toolCalls.length > 0) {
		return {
			role: "assistant",
			content: [
				...(message.content ? [{ type: "text", text: message.content }] : []),
				...toolCalls.map((call) => ({
					type: "tool_use",
					id: call.id,
					name: call.name,
					input: call.input ?? {},
				})),
			],
		};
	}
	return { role: message.role === "assistant" ? "assistant" : "user", content: cacheControl ? [{ type: "text", text: message.content, cache_control: cacheControl }] : message.content };
}

function toAnthropicTool(tool: ModelToolDefinition, cacheControl?: AnthropicCacheControl): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.inputSchema ?? emptySchema(),
		...(cacheControl ? { cache_control: cacheControl } : {}),
	};
}

function parseToolCalls(blocks: AnthropicContentBlock[]): ModelToolCall[] {
	return blocks
		.filter((block) => block.type === "tool_use" && block.id && block.name)
		.map((block) => ({
			id: block.id as string,
			name: block.name as string,
			...(block.input === undefined ? {} : { input: block.input }),
		}));
}

function emptySchema(): Record<string, unknown> {
	return { type: "object", properties: {}, additionalProperties: false };
}

function normalizeUsage(value: unknown): ModelUsage | undefined {
	const usage = objectRecord(value);
	const inputTokens = numberField(usage, "input_tokens");
	const outputTokens = numberField(usage, "output_tokens");
	const cacheReadTokens = numberField(usage, "cache_read_input_tokens");
	const cacheWriteTokens = numberField(usage, "cache_creation_input_tokens");
	const reasoningTokens = numberField(objectRecord(usage.output_tokens_details), "reasoning_tokens") ?? numberField(objectRecord(usage.completion_tokens_details), "reasoning_tokens") ?? numberField(usage, "reasoning_tokens");
	if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens].every((item) => item === undefined)) return undefined;
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
		...((inputTokens ?? outputTokens ?? cacheReadTokens ?? cacheWriteTokens) === undefined ? {} : { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }),
	};
}

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
	const item = value[key];
	return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function numberOption(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function normalizeBaseURL(baseURL = "https://api.anthropic.com/v1"): string {
	return baseURL.replace(/\/+$/, "");
}
