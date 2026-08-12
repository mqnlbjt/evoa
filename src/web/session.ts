import type { ChatCommand, WebCommand } from "../cli/args.js";
import type { ChatServiceContext, ChatServiceDeps } from "../cli/chat-service.js";
import { createChatServiceContext } from "../cli/chat-service.js";
import { ChatState } from "./state.js";
import type { ChatStateOptions } from "./types.js";

export interface ChatSessionOptions {
	command: ChatCommand | WebCommand;
	deps: ChatServiceDeps;
	now?: () => number;
	onTraceEvent: () => void;
}

export interface ChatSession {
	chat: ChatServiceContext;
	state: ChatState;
}

export async function createChatSession(options: ChatSessionOptions): Promise<ChatSession> {
	let state: ChatState | undefined;
	const chat = await createChatServiceContext(options.command, options.deps, {
		eventObserver: (event) => {
			state?.applyTraceEvent(event);
			options.onTraceEvent();
		},
	});
	state = new ChatState(chatStateOptions(chat, options));
	return { chat, state };
}

export function resetChatState(state: ChatState, chat: ChatServiceContext, options: ChatSessionOptions): void {
	state.reset(chatStateOptions(chat, options));
}

function chatStateOptions(chat: ChatServiceContext, options: ChatSessionOptions): ChatStateOptions {
	return {
		agentName: chat.agent.name,
		agentId: chat.agent.id,
		model: chat.agent.model.model,
		provider: chat.agent.model.provider,
		...(chat.agent.model.reasoningLevel ? { reasoningLevel: chat.agent.model.reasoningLevel } : {}),
		toolProfile: chat.command.toolProfile,
		mcpServerCount: Object.keys(chat.command.mcpServers ?? {}).length,
		cwd: process.cwd(),
		sessionId: chat.sessionId,
		...(chat.agent.tools.maxToolCalls === undefined ? {} : { maxToolCalls: chat.agent.tools.maxToolCalls }),
		...((options.now ?? options.deps.now) ? { now: (options.now ?? options.deps.now)! } : {}),
		...(options.deps.createId ? { createId: options.deps.createId } : {}),
	};
}
