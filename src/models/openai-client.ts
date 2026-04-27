import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses.js";
import type { ModelClient, ModelRequest, ModelResponse } from "./types.js";

export interface OpenAIModelClientOptions {
	apiKey?: string;
	baseURL?: string;
	defaultHeaders?: Record<string, string>;
	temperature?: number;
	maxOutputTokens?: number;
	store?: boolean;
	client?: OpenAIResponsesClient;
}

export interface OpenAIResponseLike {
	output_text?: string | undefined;
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
			new OpenAI({
				apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
				baseURL: options.baseURL,
				defaultHeaders: options.defaultHeaders,
			});
	}

	async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
		const params = this.buildParams(request);
		const response = await this.client.responses.create(params, signal ? { signal } : undefined);
		return {
			text: response.output_text ?? "",
			...(response._request_id ? { metadata: { requestId: response._request_id } } : {}),
		};
	}

	private buildParams(request: ModelRequest): ResponseCreateParamsNonStreaming {
		const params: ResponseCreateParamsNonStreaming = {
			model: request.agent.model.model,
			instructions: request.agent.prompts.system,
			input: request.messages
				.filter((message) => message.role !== "system")
				.map((message) => `${message.role}: ${message.content}`)
				.join("\n\n"),
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

		return params;
	}
}
