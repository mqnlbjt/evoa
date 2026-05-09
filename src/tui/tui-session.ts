import type { ChatCommand, TuiCommand } from "../cli/args.js";
import type { ChatServiceContext, ChatServiceDeps } from "../cli/chat-service.js";
import { createChatServiceContext } from "../cli/chat-service.js";
import { TuiState } from "./state.js";
import type { TuiStateOptions } from "./types.js";

export interface TuiSessionOptions {
	command: ChatCommand | TuiCommand;
	deps: ChatServiceDeps;
	now?: () => number;
	onTraceEvent: () => void;
}

export interface TuiSession {
	chat: ChatServiceContext;
	state: TuiState;
}

export async function createTuiSession(options: TuiSessionOptions): Promise<TuiSession> {
	let state: TuiState | undefined;
	const chat = await createChatServiceContext(options.command, options.deps, {
		eventObserver: (event) => {
			state?.applyTraceEvent(event);
			options.onTraceEvent();
		},
	});
	state = new TuiState(tuiStateOptions(chat, options));
	return { chat, state };
}

export function resetTuiStateForChat(state: TuiState, chat: ChatServiceContext, options: TuiSessionOptions): void {
	state.reset(tuiStateOptions(chat, options));
}

function tuiStateOptions(chat: ChatServiceContext, options: TuiSessionOptions): TuiStateOptions {
	return {
		agentName: chat.agent.name,
		agentId: chat.agent.id,
		model: chat.agent.model.model,
		provider: chat.agent.model.provider,
		toolProfile: chat.command.toolProfile,
		mcpServerCount: Object.keys(chat.command.mcpServers ?? {}).length,
		cwd: process.cwd(),
		sessionId: chat.sessionId,
		...(chat.agent.tools.maxToolCalls === undefined ? {} : { maxToolCalls: chat.agent.tools.maxToolCalls }),
		...((options.now ?? options.deps.now) ? { now: (options.now ?? options.deps.now)! } : {}),
		...(options.deps.createId ? { createId: options.deps.createId } : {}),
	};
}
