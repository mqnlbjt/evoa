import type { ChatCommand, TuiCommand } from "../cli/args.js";
import type { ChatServiceDeps } from "../cli/chat-service.js";
import { createChatServiceContext, runChatTurn } from "../cli/chat-service.js";
import { InputEditor } from "./input-editor.js";
import { renderTui } from "./renderer.js";
import { ScreenRenderer } from "./screen-renderer.js";
import { TuiState } from "./state.js";
import { handleSlashCommand } from "./slash-commands.js";
import type { Terminal } from "./terminal.js";

export interface InteractiveModeOptions {
	command: ChatCommand | TuiCommand;
	deps: ChatServiceDeps;
	terminal: Terminal;
	now?: () => number;
}

export class InteractiveMode {
	private readonly input = new InputEditor();
	private state?: TuiState;
	private screen?: ScreenRenderer;
	private stopped = false;
	private busy = false;
	private busyNoticeShown = false;
	private logScrollOffset = 0;
	private viewScrollOffsets = { stats: 0, trace: 0 };
	private renderTimer: NodeJS.Timeout | undefined;
	private renderQueued = false;
	private resolveExit?: (exitCode: number) => void;
	private unsubscribers: Array<() => void> = [];

	constructor(private readonly options: InteractiveModeOptions) {}

	async start(): Promise<number> {
		const terminal = this.options.terminal;
		terminal.setRawMode(true);
		let chat: Awaited<ReturnType<typeof createChatServiceContext>>;
		try {
			chat = await createChatServiceContext(this.options.command, this.options.deps, {
				eventObserver: (event) => {
					this.state?.applyTraceEvent(event);
					this.requestRender();
				},
			});
		} catch (error) {
			terminal.dispose();
			throw error;
		}
		this.screen = new ScreenRenderer(terminal);
		this.state = new TuiState({
			agentName: chat.agent.name,
			agentId: chat.agent.id,
			model: chat.agent.model.model,
			provider: chat.agent.model.provider,
			toolProfile: chat.command.toolProfile,
			cwd: process.cwd(),
			sessionId: chat.sessionId,
			...(chat.agent.tools.maxToolCalls === undefined ? {} : { maxToolCalls: chat.agent.tools.maxToolCalls }),
			...((this.options.now ?? this.options.deps.now) ? { now: (this.options.now ?? this.options.deps.now)! } : {}),
			...(this.options.deps.createId ? { createId: this.options.deps.createId } : {}),
		});
		this.unsubscribers = [
			terminal.onInput((chunk) => { void this.handleInput(chunk, chat); }),
			terminal.onResize(() => {
				this.screen?.reset();
				this.requestRender();
			}),
		];
		this.renderNow();
		return new Promise((resolve) => {
			this.resolveExit = resolve;
		});
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
		this.renderQueued = false;
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.options.terminal.dispose();
		this.resolveExit?.(0);
	}

	private async handleInput(chunk: string, chat: Awaited<ReturnType<typeof createChatServiceContext>>): Promise<void> {
		if (this.handleScrollInput(chunk)) return;
		for (const action of this.input.handleInput(chunk)) {
			if (action.type === "changed") this.requestRender();
			else if (action.type === "cancel") this.cancelInput();
			else if (action.type === "exit") this.stop();
			else if (action.type === "submit") await this.submitInput(action.value.trim(), chat);
		}
	}

	private handleScrollInput(chunk: string): boolean {
		if (chunk !== "\x1b[5~" && chunk !== "\x1b[6~") return false;
		const delta = Math.max(5, Math.floor(this.options.terminal.height / 2));
		const direction = chunk === "\x1b[5~" ? delta : -delta;
		const view = this.state?.snapshot().activeView ?? "chat";
		if (view === "chat") this.logScrollOffset = Math.max(0, this.logScrollOffset + direction);
		else this.viewScrollOffsets[view] = Math.max(0, this.viewScrollOffsets[view] + direction);
		this.requestRender();
		return true;
	}

	private cancelInput(): void {
		this.state?.addSystemMessage("Input cancelled");
		this.requestRender();
	}

	private async submitInput(input: string, chat: Awaited<ReturnType<typeof createChatServiceContext>>): Promise<void> {
		if (!input) {
			this.requestRender();
			return;
		}
		if (input.startsWith("/")) {
			const beforeView = this.requireState().snapshot().activeView;
			const result = await handleSlashCommand(input, { state: this.requireState(), chat, stop: () => this.stop() });
			const afterView = this.requireState().snapshot().activeView;
			if (beforeView !== afterView) this.resetViewScroll(afterView);
			if (result.message) this.state?.addSystemMessage(result.message);
			this.requestRender();
			return;
		}
		if (this.busy) {
			if (!this.busyNoticeShown) this.state?.addSystemMessage("A turn is already running");
			this.busyNoticeShown = true;
			this.requestRender();
			return;
		}
		this.logScrollOffset = 0;
		this.busy = true;
		this.busyNoticeShown = false;
		this.state?.addUserMessage(input);
		this.requestRender();
		try {
			await runChatTurn(chat, input);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!this.state?.hasErrorMessage(message)) this.state?.addError(message);
		} finally {
			this.busy = false;
			this.busyNoticeShown = false;
			this.requestRender();
		}
	}

	private requestRender(): void {
		if (this.stopped || !this.state) return;
		if (this.renderQueued) return;
		this.renderQueued = true;
		this.renderTimer = setTimeout(() => {
			this.renderQueued = false;
			this.renderTimer = undefined;
			this.renderNow();
		}, 16);
	}

	private resetViewScroll(view: "chat" | "stats" | "trace"): void {
		if (view === "chat") this.logScrollOffset = 0;
		else this.viewScrollOffsets[view] = 0;
	}

	private renderNow(): void {
		if (this.stopped || !this.state) return;
		const terminal = this.options.terminal;
		const snapshot = this.state.snapshot();
		const frame = renderTui(snapshot, this.input, { width: terminal.width, height: terminal.height, now: (this.options.now ?? this.options.deps.now ?? Date.now)(), logScrollOffset: this.logScrollOffset, viewScrollOffset: snapshot.activeView === "chat" ? 0 : this.viewScrollOffsets[snapshot.activeView], inputBlocked: this.busy });
		this.screen?.draw(frame, { row: frame.split("\n").length, column: this.input.cursorColumn(terminal.width) });
	}

	private requireState(): TuiState {
		if (!this.state) throw new Error("TUI state is not initialized");
		return this.state;
	}
}
