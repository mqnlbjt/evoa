import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses.js";
import type { ModelClient, ModelContentBlock, ModelRequest, ModelResponse, ModelToolCall, ModelToolDefinition } from "./types.js";

export interface OpenAIModelClientOptions {
	apiKey?: string;
	baseURL?: string;
	defaultHeaders?: Record<string, string>;
	temperature?: number;
	maxOutputTokens?: number;
	store?: boolean;
	client?: OpenAIResponsesClient;
}

interface OpenAIOutputItemLike {
	type?: string;
	id?: string;
	call_id?: string | null;
	name?: string;
	arguments?: string;
}

export interface OpenAIResponseLike {
	output_text?: string | undefined;
	output?: OpenAIOutputItemLike[] | undefined;
	_request_id?: string | null | undefined;
}

export interface OpenAIResponsesClient {
	responses: {
		create(
			params: ResponseCreateParamsNonStreaming,
			options?: { signal?: AbortSignal },
		): Promise<OpenAIResponseLike>;
	};
}

export class OpenAIModelClient implements ModelClient {
	private readonly client: OpenAIResponsesClient;

	constructor(private readonly options: OpenAIModelClientOptions = {}) {
		this.client =
			options.client ??
			(new OpenAI({
				apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
				baseURL: options.baseURL,
				defaultHeaders: options.defaultHeaders,
			}) as unknown as OpenAIResponsesClient);
	}

	async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
		const params = this.buildParams(request);
		const response = await this.client.responses.create(params, signal ? { signal } : undefined);
		const toolCalls = parseToolCalls(response);
		return {
			text: response.output_text ?? "",
			...(toolCalls.length > 0 ? { toolCalls } : {}),
			...(response._request_id ? { metadata: { requestId: response._request_id } } : {}),
		};
	}

	private buildParams(request: ModelRequest): ResponseCreateParamsNonStreaming {
		const params: ResponseCreateParamsNonStreaming = {
			model: request.agent.model.model,
			instructions: request.agent.prompts.system,
			input: buildInput(request),
			store: this.options.store ?? false,
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
			});
			continue;
		}
		const toolCalls = message.contentBlocks?.filter((block): block is Extract<ModelContentBlock, { type: "tool_call" }> => block.type === "tool_call") ?? [];
		if (message.role === "assistant" && toolCalls.length > 0) {
			if (message.content) {
				input.push({ role: "assistant", content: message.content });
			}
			for (const call of toolCalls) {
				input.push({
					type: "function_call",
					call_id: call.id,
					name: call.name,
					arguments: JSON.stringify(call.input ?? {}),
				});
			}
			continue;
		}
		input.push({ role: message.role, content: message.content });
	}
	return input as NonNullable<ResponseCreateParamsNonStreaming["input"]>;
}

function toOpenAITool(tool: ModelToolDefinition): unknown {
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema ?? emptySchema(),
	};
}

function parseToolCalls(response: OpenAIResponseLike): ModelToolCall[] {
	const calls: ModelToolCall[] = [];
	for (const item of response.output ?? []) {
		if (item.type !== "function_call" || !item.name) continue;
		const id = item.call_id ?? item.id;
		if (!id) continue;
		calls.push({
			id,
			name: item.name,
			...(item.arguments === undefined ? {} : { input: parseArguments(item.arguments) }),
		});
	}
	return calls;
}

function parseArguments(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return { raw: value };
	}
}

function emptySchema(): Record<string, unknown> {
	return { type: "object", properties: {}, additionalProperties: false };
}
