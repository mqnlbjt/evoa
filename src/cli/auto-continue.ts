import type { ModelResponse } from "../models/types.js";
import type { FollowUpMessage, FollowUpMessageProvider } from "../runtime/loop.js";

const autoContinueFollowUp = "Continue the task if it is not complete.";

export function createAutoContinueFollowUpProvider(defaultMaxFollowUps = 2): FollowUpMessageProvider {
	return (session, response) => {
		const ac = session.agent.runtime.autoContinue;
		if (ac === false) return [];

		const maxFollowUps = typeof ac === "object" ? (ac.maxFollowUps ?? defaultMaxFollowUps) : defaultMaxFollowUps;
		const alreadySent = session.messages.filter(
			(m) => m.role === "user" && m.content === autoContinueFollowUp,
		).length;
		if (alreadySent >= maxFollowUps) return [];

		if (isTruncatedResponse(response)) return [autoContinueMessage()];
		if (isEmptyOutput(response)) return [autoContinueMessage()];
		if (hasContinueSignal(response)) return [autoContinueMessage()];
		if (ac === true) return [autoContinueMessage()];

		return [];
	};
}

function autoContinueMessage(): FollowUpMessage {
	return { role: "user", content: autoContinueFollowUp, contentBlocks: [{ type: "text", text: autoContinueFollowUp }] };
}

function isTruncatedResponse(response: ModelResponse): boolean {
	const meta = response.metadata;
	if (!meta || typeof meta !== "object") return false;
	const record = meta as Record<string, unknown>;
	return record.stopReason === "max_tokens" || record.finishReason === "length";
}

function isEmptyOutput(response: ModelResponse): boolean {
	return !response.text?.trim() && (!response.toolCalls || response.toolCalls.length === 0);
}

function hasContinueSignal(response: ModelResponse): boolean {
	const meta = response.metadata;
	if (!meta || typeof meta !== "object") return false;
	return (meta as Record<string, unknown>).autoContinue === true;
}
