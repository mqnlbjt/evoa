import type { ChatServiceContext } from "../cli/chat-service.js";
import { runChatTurn } from "../cli/chat-service.js";
import { isAbortError } from "../runtime/timeout.js";
import type { EvolutionHistoryRecord } from "../evolution/history-store.js";
import type { TuiState } from "./state.js";
import { handleSlashCommand } from "./slash-commands.js";
import type { TuiView } from "./types.js";

export interface TuiTurnControllerOptions {
	chat: ChatServiceContext;
	state: TuiState;
	onRenderRequested: () => void;
	onStopRequested: () => void;
	onViewChanged: (view: TuiView) => void;
	onNewSessionRequested?: () => Promise<string>;
	loadEvolutionHistory?: (historyPath: string) => Promise<EvolutionHistoryRecord[]>;
}

export class TuiTurnController {
	private busy = false;
	private busyNoticeShown = false;
	private activeTurnController: AbortController | undefined;

	constructor(private readonly options: TuiTurnControllerOptions) {}

	isBusy(): boolean {
		return this.busy;
	}

	cancelInput(): void {
		this.options.state.addSystemMessage("Input cancelled");
		this.options.onRenderRequested();
	}

	interruptTurn(): boolean {
		if (!this.busy || !this.activeTurnController) return false;
		this.activeTurnController.abort(new Error("User interrupted"));
		this.options.onRenderRequested();
		return true;
	}

	async submit(input: string): Promise<void> {
		if (!input) {
			this.options.onRenderRequested();
			return;
		}
		if (input.startsWith("/")) {
			await this.submitSlashCommand(input);
			return;
		}
		await this.submitTurn(input);
	}

	private async submitSlashCommand(input: string): Promise<void> {
		if (isNewSessionCommand(input) && this.busy) {
			this.showBusyNotice();
			return;
		}
		const beforeView = this.options.state.snapshot().activeView;
		const result = await handleSlashCommand(input, { state: this.options.state, chat: this.options.chat, stop: this.options.onStopRequested, ...(this.options.onNewSessionRequested ? { newSession: this.options.onNewSessionRequested } : {}), ...(this.options.loadEvolutionHistory ? { loadEvolutionHistory: this.options.loadEvolutionHistory } : {}) });
		const afterView = this.options.state.snapshot().activeView;
		if (beforeView !== afterView) this.options.onViewChanged(afterView);
		if (result.message) this.options.state.addSystemMessage(result.message);
		this.options.onRenderRequested();
	}

	private showBusyNotice(): void {
		if (!this.busyNoticeShown) this.options.state.addSystemMessage("A turn is already running");
		this.busyNoticeShown = true;
		this.options.onRenderRequested();
	}

	private async submitTurn(input: string): Promise<void> {
		if (this.busy) {
			this.showBusyNotice();
			return;
		}
		this.busy = true;
		this.busyNoticeShown = false;
		this.options.onViewChanged("chat");
		this.options.state.addUserMessage(input);
		this.options.onRenderRequested();
		this.activeTurnController = new AbortController();
		try {
			await runChatTurn(this.options.chat, input, this.activeTurnController.signal);
		} catch (error) {
			if (!isAbortError(error, this.activeTurnController.signal)) {
				const message = error instanceof Error ? error.message : String(error);
				if (!this.options.state.hasErrorMessage(message)) this.options.state.addError(message);
			}
		} finally {
			this.busy = false;
			this.busyNoticeShown = false;
			this.activeTurnController = undefined;
			this.options.onRenderRequested();
		}
	}
}

function isNewSessionCommand(input: string): boolean {
	return input.trim().split(/\s+/, 1)[0] === "/new";
}
