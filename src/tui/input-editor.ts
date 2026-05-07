import { displayWidth, truncateDisplayWidth } from "./text-width.js";

export interface InputEditorState {
	value: string;
	cursor: number;
	historyIndex?: number;
}

export type InputEditorAction =
	| { type: "submit"; value: string }
	| { type: "cancel" }
	| { type: "exit" }
	| { type: "changed" };

export class InputEditor {
	readonly state: InputEditorState = { value: "", cursor: 0 };
	private readonly history: string[] = [];

	handleInput(chunk: string): InputEditorAction[] {
		if (chunk === "\r" || chunk === "\n") return this.submit();
		if (chunk === "\u0003") return this.cancelOrExit();
		if (chunk === "\u007f" || chunk === "\b") return this.backspace();
		if (chunk === "\x1b[3~") return this.deleteForward();
		if (chunk === "\x1b[A") return this.historyUp();
		if (chunk === "\x1b[B") return this.historyDown();
		if (chunk === "\x1b[D") return this.moveCursor(-1);
		if (chunk === "\x1b[C") return this.moveCursor(1);
		if (chunk === "\x1b[H" || chunk === "\x1b[1~") return this.moveCursorToStart();
		if (chunk === "\x1b[F" || chunk === "\x1b[4~") return this.moveCursorToEnd();
		this.insert(chunk.replace(/[\r\n]/g, " "));
		return [{ type: "changed" }];
	}

	clear(): void {
		this.state.value = "";
		this.state.cursor = 0;
		delete this.state.historyIndex;
	}

	pushHistory(value: string): void {
		if (value.trim()) this.history.push(value);
		delete this.state.historyIndex;
	}

	renderPrompt(width: number): string {
		return truncateLine(`> ${this.state.value}`, width);
	}

	cursorColumn(width: number): number {
		const column = displayWidth(this.state.value.slice(0, this.state.cursor)) + 3;
		return Math.max(1, Math.min(Math.max(1, width), column));
	}

	private submit(): InputEditorAction[] {
		const value = this.state.value;
		this.pushHistory(value);
		this.clear();
		return [{ type: "submit", value }];
	}

	private cancelOrExit(): InputEditorAction[] {
		if (!this.state.value) return [{ type: "exit" }];
		this.clear();
		return [{ type: "cancel" }];
	}

	private backspace(): InputEditorAction[] {
		if (this.state.cursor === 0) return [{ type: "changed" }];
		const previous = previousBoundary(this.state.value, this.state.cursor);
		this.state.value = this.state.value.slice(0, previous) + this.state.value.slice(this.state.cursor);
		this.state.cursor = previous;
		return [{ type: "changed" }];
	}

	private deleteForward(): InputEditorAction[] {
		if (this.state.cursor >= this.state.value.length) return [{ type: "changed" }];
		this.state.value = this.state.value.slice(0, this.state.cursor) + this.state.value.slice(nextBoundary(this.state.value, this.state.cursor));
		return [{ type: "changed" }];
	}

	private moveCursor(delta: number): InputEditorAction[] {
		this.state.cursor = delta < 0 ? previousBoundary(this.state.value, this.state.cursor) : nextBoundary(this.state.value, this.state.cursor);
		return [{ type: "changed" }];
	}

	private moveCursorToStart(): InputEditorAction[] {
		this.state.cursor = 0;
		return [{ type: "changed" }];
	}

	private moveCursorToEnd(): InputEditorAction[] {
		this.state.cursor = this.state.value.length;
		return [{ type: "changed" }];
	}

	private historyUp(): InputEditorAction[] {
		if (this.history.length === 0) return [{ type: "changed" }];
		const index = this.state.historyIndex === undefined ? this.history.length - 1 : Math.max(0, this.state.historyIndex - 1);
		this.setFromHistory(index);
		return [{ type: "changed" }];
	}

	private historyDown(): InputEditorAction[] {
		if (this.state.historyIndex === undefined) return [{ type: "changed" }];
		const index = this.state.historyIndex + 1;
		if (index >= this.history.length) this.clear();
		else this.setFromHistory(index);
		return [{ type: "changed" }];
	}

	private insert(value: string): void {
		this.state.value = this.state.value.slice(0, this.state.cursor) + value + this.state.value.slice(this.state.cursor);
		this.state.cursor += value.length;
	}

	private setFromHistory(index: number): void {
		const value = this.history[index] ?? "";
		this.state.value = value;
		this.state.cursor = value.length;
		this.state.historyIndex = index;
	}
}

function truncateLine(value: string, width: number): string {
	return truncateDisplayWidth(value, width);
}

function previousBoundary(value: string, cursor: number): number {
	return Array.from(value.slice(0, cursor)).slice(0, -1).join("").length;
}

function nextBoundary(value: string, cursor: number): number {
	const next = Array.from(value.slice(cursor))[0];
	return next === undefined ? value.length : cursor + next.length;
}

