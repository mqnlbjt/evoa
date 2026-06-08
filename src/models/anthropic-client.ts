import {
	anthropicCacheControl,
	resolveCacheRetention,
	type AnthropicCacheControl,
} from "./cache.js";
import { resolveReasoningPolicy, shouldReturnReasoning } from "./reasoning.js";
import type {
	CacheRetention,
	ModelClient,
	ModelContentBlock,
	ModelMessage,
	ModelRequest,
	ModelResponse,
	ModelToolCall,
	ModelToolDefinition,
	ModelUsage,
} from "./types.js";

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
	thinking?: string;
	signature?: string;
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

	async complete(
		request: ModelRequest,
		signal?: AbortSignal,
	): Promise<ModelResponse> {
		if (request.stream) return this.streamComplete(request, signal);

		const apiKey =
			this.options.apiKey ??
			process.env.ANTHROPIC_API_KEY ??
			process.env.OPENAI_API_KEY;
		if (!apiKey) {
			throw new Error(
				"Anthropic API key is required. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or pass apiKey.",
			);
		}

		const requestBody = buildBody(
			request,
			this.options.maxTokens ??
				numberOption(request.agent.model.options?.maxTokens) ??
				8192,
			this.options.baseURL,
		);
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
		const response = await this.fetchFn(
			`${normalizeBaseURL(this.options.baseURL)}/messages`,
			init,
		);

		const body = (await response.json()) as
			| AnthropicMessageResponse
			| { error?: { message?: string } };
		if (!response.ok) {
			const message = "error" in body ? body.error?.message : undefined;
			throw new Error(
				message ??
					`Anthropic messages request failed with status ${response.status}`,
			);
		}

		const data = body as AnthropicMessageResponse;
		const toolCalls = parseToolCalls(data.content ?? []);
		const policy = resolveReasoningPolicy(request.agent.model, "anthropic");
		const thinkingSig = parseThinkingSignature(data.content ?? []);
		const reasoning = shouldReturnReasoning(policy, toolCalls)
			? parseThinking(data.content ?? [])
			: undefined;
		const usage = normalizeUsage(data.usage);
		return {
			text:
				data.content
					?.filter((block) => block.type === "text")
					.map((block) => block.text ?? "")
					.join("") ?? "",
			...(reasoning !== undefined ? { reasoning } : {}),
			...(thinkingSig ? { reasoningSignature: thinkingSig } : {}),
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

	private async streamComplete(
		request: ModelRequest,
		signal?: AbortSignal,
	): Promise<ModelResponse> {
		const apiKey =
			this.options.apiKey ??
			process.env.ANTHROPIC_API_KEY ??
			process.env.OPENAI_API_KEY;
		if (!apiKey) {
			throw new Error(
				"Anthropic API key is required. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or pass apiKey.",
			);
		}

		const maxTokens =
			this.options.maxTokens ??
			numberOption(request.agent.model.options?.maxTokens) ??
			8192;
		const requestBody = {
			...buildBody(request, maxTokens, this.options.baseURL),
			stream: true,
		};
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

		const response = await this.fetchFn(
			`${normalizeBaseURL(this.options.baseURL)}/messages`,
			init,
		);
		if (!response.ok) {
			const errorBody = await response.text();
			let message = `Anthropic streaming request failed with status ${response.status}`;
			try {
				const parsed = JSON.parse(errorBody);
				if (parsed.error?.message) message = parsed.error.message;
			} catch {
				/* use default message */
			}
			throw new Error(message);
		}
		if (!response.body)
			throw new Error("Anthropic streaming response has no body");

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let requestId = "";
		let model = "";
		let stopReason = "";
		let inputTokens = 0;
		let outputTokens = 0;
		let fullText = "";
		let fullReasoning = "";
		let fullSignature = "";
		const toolUseBlocks = new Map<
			number,
			{ id: string; name: string; json: string }
		>();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const events = splitSSEEvents(buffer);
				buffer = events.remainder;
				for (const sseEvent of events.complete) {
					const parsed = parseSSEData(sseEvent);
					if (!parsed) continue;
					const data = parsed as Record<string, unknown>;
					const type = typeof data.type === "string" ? data.type : "";
					switch (type) {
						case "message_start": {
							const msg = (data.message ?? {}) as Record<string, unknown>;
							requestId = typeof msg.id === "string" ? msg.id : "";
							model = typeof msg.model === "string" ? msg.model : "";
							const msgUsage = (msg.usage ?? {}) as Record<string, unknown>;
							inputTokens =
								typeof msgUsage.input_tokens === "number"
									? msgUsage.input_tokens
									: 0;
							break;
						}
						case "content_block_start": {
							const block = (data.content_block ?? {}) as Record<
								string,
								unknown
							>;
							if (block.type === "tool_use") {
								const idx = typeof data.index === "number" ? data.index : 0;
								toolUseBlocks.set(idx, {
									id: typeof block.id === "string" ? block.id : "",
									name: typeof block.name === "string" ? block.name : "",
									json: "",
								});
							} else if (
								block.type === "thinking" ||
								block.type === "redacted_thinking"
							) {
								fullSignature =
									typeof block.signature === "string" ? block.signature : "";
							}
							break;
						}
						case "content_block_delta": {
							const delta = (data.delta ?? {}) as Record<string, unknown>;
							const deltaType =
								typeof delta.type === "string" ? delta.type : "";
							if (
								deltaType === "text_delta" &&
								typeof delta.text === "string"
							) {
								fullText += delta.text;
								request.streamCallbacks?.onTextDelta?.(delta.text, fullText);
							} else if (
								deltaType === "thinking_delta" &&
								typeof delta.thinking === "string"
							) {
								fullReasoning += delta.thinking;
								request.streamCallbacks?.onReasoningDelta?.(
									delta.thinking,
									fullReasoning,
								);
							} else if (
								deltaType === "signature_delta" &&
								typeof delta.signature === "string"
							) {
								fullSignature += delta.signature;
							} else if (
								deltaType === "input_json_delta" &&
								typeof delta.partial_json === "string"
							) {
								const idx = typeof data.index === "number" ? data.index : 0;
								const block = toolUseBlocks.get(idx);
								if (block) block.json += delta.partial_json;
							}
							break;
						}
						case "message_delta": {
							const delta = (data.delta ?? {}) as Record<string, unknown>;
							stopReason =
								typeof delta.stop_reason === "string" ? delta.stop_reason : "";
							const msgUsage = (data.usage ?? {}) as Record<string, unknown>;
							outputTokens =
								typeof msgUsage.output_tokens === "number"
									? msgUsage.output_tokens
									: 0;
							break;
						}
						case "error": {
							const err = (data.error ?? {}) as Record<string, unknown>;
							throw new Error(
								typeof err.message === "string"
									? err.message
									: "Anthropic streaming error",
							);
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		const toolCalls: ModelToolCall[] = [...toolUseBlocks.values()].map(
			(block) => ({
				id: block.id,
				name: block.name,
				input: parseToolCallInput(block.json),
			}),
		);

		const policy = resolveReasoningPolicy(request.agent.model, "anthropic");
		const reasoning =
			shouldReturnReasoning(policy, toolCalls) && fullReasoning
				? fullReasoning
				: undefined;
		const totalTokens = inputTokens + outputTokens;
		const usage: ModelUsage = { inputTokens, outputTokens, totalTokens };
		return {
			text: fullText,
			...(reasoning !== undefined ? { reasoning } : {}),
			...(fullSignature ? { reasoningSignature: fullSignature } : {}),
			...(toolCalls.length > 0 ? { toolCalls } : {}),
			...(requestId ? { requestId } : {}),
			usage,
			metadata: {
				...(requestId ? { id: requestId } : {}),
				...(model ? { model } : {}),
				...(stopReason ? { stopReason } : {}),
				usage: { input_tokens: inputTokens, output_tokens: outputTokens },
			},
		};
	}
}

function buildBody(
	request: ModelRequest,
	maxTokens: number,
	baseURL?: string,
): Record<string, unknown> {
	const messageRetention = resolveCacheRetention(request);
	const systemRetention: CacheRetention =
		messageRetention === "none" ? "none" : "long";
	const systemCacheControl = anthropicCacheControl(systemRetention, baseURL);
	const messageCacheControl = anthropicCacheControl(messageRetention, baseURL);
	const policy = resolveReasoningPolicy(request.agent.model, "anthropic");
	const alwaysIncludeReasoning =
		policy.providerStyle === "deepseek" || policy.providerStyle === "anthropic";
	return {
		model: request.agent.model.model,
		max_tokens: maxTokens,
		system: anthropicSystem(request.agent.prompts.system, systemCacheControl),
		messages: toAnthropicMessages(
			request.messages,
			messageCacheControl,
			alwaysIncludeReasoning,
		),
		...anthropicThinkingParams(request),
		...(request.tools?.length
			? {
					tools: request.tools.map((tool, index) =>
						toAnthropicTool(
							tool,
							index === request.tools!.length - 1
								? messageCacheControl
								: undefined,
						),
					),
				}
			: {}),
	};
}

function anthropicThinkingParams(
	request: ModelRequest,
): Record<string, unknown> {
	const policy = resolveReasoningPolicy(request.agent.model, "anthropic");
	if (!policy.enabled) return {};
	return {
		thinking: { type: policy.thinkingType },
		output_config: { effort: policy.effort },
	};
}

function anthropicSystem(
	system: string,
	cacheControl: AnthropicCacheControl | undefined,
): string | Array<Record<string, unknown>> {
	if (!cacheControl) return system;
	return [{ type: "text", text: system, cache_control: cacheControl }];
}

function toAnthropicMessages(
	messages: ModelMessage[],
	cacheControl: AnthropicCacheControl | undefined,
	alwaysIncludeReasoning = false,
): Record<string, unknown>[] {
	const filtered = messages.filter((message) => message.role !== "system");
	const cacheIndices = new Set<number>();
	if (cacheControl) {
		const lastUserIdx = lastUserMessageIndex(filtered);
		if (lastUserIdx >= 0) cacheIndices.add(lastUserIdx);
		for (let i = 0; i < filtered.length; i++) {
			if (filtered[i]?.cache) cacheIndices.add(i);
		}
	}
	return filtered.map((message, index) =>
		toAnthropicMessage(
			message,
			cacheIndices.has(index) ? cacheControl : undefined,
			alwaysIncludeReasoning,
		),
	);
}

function lastUserMessageIndex(messages: ModelMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

function toAnthropicMessage(
	message: ModelMessage,
	cacheControl?: AnthropicCacheControl,
	alwaysIncludeReasoning = false,
): Record<string, unknown> {
	if (message.role === "tool") {
		const result = message.contentBlocks?.find(
			(block): block is Extract<ModelContentBlock, { type: "tool_result" }> =>
				block.type === "tool_result",
		);
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
	if (message.role === "assistant") {
		const toolCalls =
			message.contentBlocks?.filter(
				(block): block is Extract<ModelContentBlock, { type: "tool_call" }> =>
					block.type === "tool_call",
			) ?? [];
		const reasoningBlocks =
			message.contentBlocks?.filter(
				(block): block is Extract<ModelContentBlock, { type: "reasoning" }> =>
					block.type === "reasoning",
			) ?? [];
		// Do NOT replay stored reasoning as Anthropic thinking blocks.
		// Replaying past reasoning as current thinking confuses the model;
		// the original thinking from the model response is already summarized
		// in the assistant's text content or preserved via context compaction.
		const thinkingBlocks: Array<Record<string, unknown>> = [];
		const textBlock = message.content
			? [{ type: "text", text: message.content }]
			: [];
		const toolUseBlocks = toolCalls.map((call) => ({
			type: "tool_use",
			id: call.id,
			name: call.name,
			input: call.input ?? {},
		}));
		const content = [...thinkingBlocks, ...textBlock, ...toolUseBlocks];
		// Simplify single-text content to plain string for backward compat
		if (content.length === 1 && content[0]?.type === "text") {
			return { role: "assistant", content: message.content };
		}
		if (content.length === 0) {
			const filler = cacheControl
				? { type: "text" as const, text: "", cache_control: cacheControl }
				: { type: "text" as const, text: "" };
			return {
				role: "assistant",
				content: alwaysIncludeReasoning
					? [{ type: "thinking", thinking: "" }, filler]
					: [filler],
			};
		}
		return { role: "assistant", content };
	}
	return {
		role: "user",
		content: cacheControl
			? [{ type: "text", text: message.content, cache_control: cacheControl }]
			: message.content,
	};
}

function toAnthropicTool(
	tool: ModelToolDefinition,
	cacheControl?: AnthropicCacheControl,
): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.inputSchema ?? emptySchema(),
		...(cacheControl ? { cache_control: cacheControl } : {}),
	};
}

function parseThinking(blocks: AnthropicContentBlock[]): string | undefined {
	const parts = blocks
		.filter((block) => block.type === "thinking")
		.map((block) => block.thinking ?? block.text ?? "")
		.filter((text) => text.length > 0);
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function parseThinkingSignature(
	blocks: AnthropicContentBlock[],
): string | undefined {
	for (const block of blocks) {
		if (
			(block.type === "thinking" || block.type === "redacted_thinking") &&
			block.signature
		) {
			return block.signature;
		}
	}
	return undefined;
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
	const reasoningTokens =
		numberField(
			objectRecord(usage.output_tokens_details),
			"reasoning_tokens",
		) ??
		numberField(
			objectRecord(usage.completion_tokens_details),
			"reasoning_tokens",
		) ??
		numberField(usage, "reasoning_tokens");
	if (
		[
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			reasoningTokens,
		].every((item) => item === undefined)
	)
		return undefined;
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
		...((inputTokens ?? outputTokens ?? cacheReadTokens ?? cacheWriteTokens) ===
		undefined
			? {}
			: { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }),
	};
}

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function numberField(
	value: Record<string, unknown>,
	key: string,
): number | undefined {
	const item = value[key];
	return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function numberOption(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function normalizeBaseURL(baseURL = "https://api.anthropic.com/v1"): string {
	return baseURL.replace(/\/+$/, "");
}

function splitSSEEvents(buffer: string): {
	complete: string[];
	remainder: string;
} {
	const parts = buffer.split("\n\n");
	const remainder = parts.pop() ?? "";
	return { complete: parts, remainder };
}

function parseSSEData(raw: string): Record<string, unknown> | undefined {
	const lines = raw.split("\n");
	const dataLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
	}
	if (dataLines.length === 0) return undefined;
	try {
		return JSON.parse(dataLines.join("\n"));
	} catch {
		return undefined;
	}
}

function parseToolCallInput(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return { raw: json };
	}
}
