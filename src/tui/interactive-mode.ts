import type { ChatCommand, TuiCommand } from "../cli/args.js";
import { startNewChatSession, type ChatServiceDeps } from "../cli/chat-service.js";
import { InputEditor } from "./input-editor.js";
import { TuiRenderScheduler } from "./render-scheduler.js";
import type { Terminal } from "./terminal.js";
import { createTuiSession, resetTuiStateForChat } from "./tui-session.js";
import type { TuiStateSnapshot } from "./types.js";
import { TuiTurnController } from "./turn-controller.js";
import { TuiViewportController } from "./viewport-controller.js";

export interface InteractiveModeOptions {
	command: ChatCommand | TuiCommand;
	deps: ChatServiceDeps;
	terminal: Terminal;
	now?: () => number;
}

export class InteractiveMode {
	private readonly input = new InputEditor();
	private readonly viewport = new TuiViewportController();
	private stopped = false;
	private renderScheduler?: TuiRenderScheduler;
	private turnController?: TuiTurnController;
	private resolveExit?: (exitCode: number) => void;
	private unsubscribers: Array<() => void> = [];

	constructor(private readonly options: InteractiveModeOptions) {}

	async start(): Promise<number> {
		const terminal = this.options.terminal;
		terminal.setRawMode(true);
		try {
			const session = await createTuiSession({ command: this.options.command, deps: this.options.deps, ...(this.options.now ? { now: this.options.now } : {}), onTraceEvent: () => this.renderScheduler?.request() });
			this.renderScheduler = new TuiRenderScheduler({
				terminal,
				state: session.state,
				input: this.input,
				now: () => (this.options.now ?? this.options.deps.now ?? Date.now)(),
				logScrollOffset: () => this.viewport.logScrollOffset(),
				viewScrollOffset: () => this.viewport.viewScrollOffset(session.state.snapshot().activeView),
				inputBlocked: () => this.turnController?.isBusy() ?? false,
				isStopped: () => this.stopped,
			});
			this.turnController = new TuiTurnController({
				chat: session.chat,
				state: session.state,
				onRenderRequested: () => this.renderScheduler?.request(),
				onStopRequested: () => this.stop(),
				onViewChanged: (view) => this.viewport.reset(view),
				onNewSessionRequested: async () => {
					const sessionId = startNewChatSession(session.chat);
					resetTuiStateForChat(session.state, session.chat, { command: this.options.command, deps: this.options.deps, ...(this.options.now ? { now: this.options.now } : {}), onTraceEvent: () => this.renderScheduler?.request() });
					this.viewport.reset("chat");
					return sessionId;
				},
			});
			this.unsubscribers = [
				terminal.onInput((chunk) => { void this.handleInput(chunk, session.state.snapshot()); }),
				terminal.onResize(() => {
					this.renderScheduler?.resetScreen();
					this.renderScheduler?.request();
				}),
			];
			this.renderScheduler.renderNow();
		} catch (error) {
			terminal.dispose();
			throw error;
		}
		return new Promise((resolve) => {
			this.resolveExit = resolve;
		});
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.renderScheduler?.dispose();
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.options.terminal.dispose();
		this.resolveExit?.(0);
	}

	private async handleInput(chunk: string, snapshot: TuiStateSnapshot): Promise<void> {
		if (this.viewport.handleScrollInput(chunk, snapshot, this.options.terminal.height)) {
			this.renderScheduler?.request();
			return;
		}
		for (const action of this.input.handleInput(chunk)) {
			if (action.type === "changed") this.renderScheduler?.request();
			else if (action.type === "cancel") this.turnController?.cancelInput();
			else if (action.type === "exit") this.stop();
			else if (action.type === "submit") await this.turnController?.submit(action.value.trim());
		}
	}
}
