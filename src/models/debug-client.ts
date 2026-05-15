import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelClient, ModelMessage, ModelRequest, ModelResponse } from "./types.js";

export class DebugModelClient implements ModelClient {
	constructor(
		private readonly inner: ModelClient,
		private readonly logPath: string,
		private readonly now: () => number = Date.now,
	) {
		mkdirSync(dirname(logPath), { recursive: true });
	}

	async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
		const startedAt = this.now();
		const response = await this.inner.complete(request, signal);
		const endedAt = this.now();
		const entry = {
			ts: new Date(startedAt).toISOString(),
			durationMs: endedAt - startedAt,
			turn: request.turn,
			purpose: request.purpose ?? "main",
			sessionId: request.sessionId,
			in: {
				messageCount: request.messages.length,
				messages: request.messages.map(summarizeMessage),
				toolCount: request.tools?.length ?? 0,
				tools: request.tools?.map((t) => t.name) ?? [],
			},
			out: {
				text: truncate(response.text ?? "", 2000),
				reasoning: truncate(response.reasoning ?? "", 1000),
				toolCalls: response.toolCalls?.map((tc) => ({ id: tc.id, name: tc.name })) ?? [],
				usage: response.usage ?? null,
			},
		};
		appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`);
		return response;
	}
}

function summarizeMessage(m: ModelMessage) {
	return {
		role: m.role,
		content: truncate(m.content, 1000),
		toolCallId: m.toolCallId,
		toolName: m.toolName,
		blockTypes: m.contentBlocks?.map((b) => b.type) ?? [],
	};
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}
