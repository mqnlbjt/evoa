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

		const requestBody = buildBody(request, this.options.maxTokens ?? numberOption(request.agent.model.options?.maxTokens) ?? 1024);
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

function buildBody(request: ModelRequest, maxTokens: number): Record<string, unknown> {
	return {
		model: request.agent.model.model,
		max_tokens: maxTokens,
		system: request.agent.prompts.system,
		messages: request.messages.filter((message) => message.role !== "system").map(toAnthropicMessage),
		...(request.tools?.length ? { tools: request.tools.map(toAnthropicTool) } : {}),
	};
}

function toAnthropicMessage(message: ModelMessage): Record<string, unknown> {
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
	return { role: message.role === "assistant" ? "assistant" : "user", content: message.content };
}

function toAnthropicTool(tool: ModelToolDefinition): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.inputSchema ?? emptySchema(),
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
	if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every((item) => item === undefined)) return undefined;
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
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
