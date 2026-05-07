import type { ChatCommand, TuiCommand } from "../cli/args.js";
import type { ChatServiceContext, ChatServiceDeps } from "../cli/chat-service.js";
import { createChatServiceContext } from "../cli/chat-service.js";
import { TuiState } from "./state.js";

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
	state = new TuiState({
		agentName: chat.agent.name,
		agentId: chat.agent.id,
		model: chat.agent.model.model,
		provider: chat.agent.model.provider,
		toolProfile: chat.command.toolProfile,
		cwd: process.cwd(),
		sessionId: chat.sessionId,
		...(chat.agent.tools.maxToolCalls === undefined ? {} : { maxToolCalls: chat.agent.tools.maxToolCalls }),
		...((options.now ?? options.deps.now) ? { now: (options.now ?? options.deps.now)! } : {}),
		...(options.deps.createId ? { createId: options.deps.createId } : {}),
	});
	return { chat, state };
}
