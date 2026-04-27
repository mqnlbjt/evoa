import type { ModelClient, ModelRequest, ModelResponse } from "./types.js";

export interface AnthropicModelClientOptions {
	apiKey?: string;
	baseURL?: string;
	anthropicVersion?: string;
	maxTokens?: number;
	headers?: Record<string, string>;
	fetchFn?: typeof fetch;
}

interface AnthropicMessageResponse {
	id?: string;
	content?: Array<{ type: string; text?: string }>;
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

		const init: RequestInit = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": this.options.anthropicVersion ?? "2023-06-01",
				...this.options.headers,
			},
			body: JSON.stringify({
				model: request.agent.model.model,
				max_tokens: this.options.maxTokens ?? request.agent.model.options?.maxTokens ?? 1024,
				system: request.agent.prompts.system,
				messages: request.messages
					.filter((message) => message.role !== "system")
					.map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content })),
			}),
			...(signal ? { signal } : {}),
		};
		const response = await this.fetchFn(`${normalizeBaseURL(this.options.baseURL)}/messages`, init);

		const body = (await response.json()) as AnthropicMessageResponse | { error?: { message?: string } };
		if (!response.ok) {
			const message = "error" in body ? body.error?.message : undefined;
			throw new Error(message ?? `Anthropic messages request failed with status ${response.status}`);
		}

		const data = body as AnthropicMessageResponse;
		return {
			text: data.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("") ?? "",
			metadata: {
				id: data.id,
				model: data.model,
				stopReason: data.stop_reason,
				usage: data.usage,
			},
		};
	}
}

function normalizeBaseURL(baseURL = "https://api.anthropic.com/v1"): string {
	return baseURL.replace(/\/+$/, "");
}
