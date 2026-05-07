import { renderTui } from "./renderer.js";
import { ScreenRenderer } from "./screen-renderer.js";
import type { TuiState } from "./state.js";
import type { InputEditor } from "./input-editor.js";
import type { Terminal } from "./terminal.js";

export interface TuiRenderSchedulerOptions {
	terminal: Terminal;
	state: TuiState;
	input: InputEditor;
	now: () => number;
	logScrollOffset: () => number;
	viewScrollOffset: () => number;
	inputBlocked: () => boolean;
	isStopped: () => boolean;
}

export class TuiRenderScheduler {
	private readonly screen: ScreenRenderer;
	private renderTimer: NodeJS.Timeout | undefined;
	private renderQueued = false;

	constructor(private readonly options: TuiRenderSchedulerOptions) {
		this.screen = new ScreenRenderer(options.terminal);
	}

	request(): void {
		if (this.options.isStopped()) return;
		if (this.renderQueued) return;
		this.renderQueued = true;
		this.renderTimer = setTimeout(() => {
			this.renderQueued = false;
			this.renderTimer = undefined;
			this.renderNow();
		}, 16);
	}

	resetScreen(): void {
		this.screen.reset();
	}

	renderNow(): void {
		if (this.options.isStopped()) return;
		const terminal = this.options.terminal;
		const snapshot = this.options.state.snapshot();
		const frame = renderTui(snapshot, this.options.input, {
			width: terminal.width,
			height: terminal.height,
			now: this.options.now(),
			logScrollOffset: this.options.logScrollOffset(),
			viewScrollOffset: this.options.viewScrollOffset(),
			inputBlocked: this.options.inputBlocked(),
		});
		this.screen.draw(frame, { row: frame.split("\n").length, column: this.options.input.cursorColumn(terminal.width) });
	}

	dispose(): void {
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
		this.renderQueued = false;
	}
}
