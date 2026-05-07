import type { Terminal, TerminalInputHandler, TerminalResizeHandler, TerminalSize } from "./terminal.js";

export class FakeTerminal implements Terminal {
	private inputHandlers = new Set<TerminalInputHandler>();
	private resizeHandlers = new Set<TerminalResizeHandler>();
	private chunks: string[] = [];
	private renderedFrames: string[] = [];
	private clears = 0;
	private cursor = { row: 1, column: 1 };
	private disposed = false;
	private rawMode = false;

	constructor(private size: TerminalSize = { width: 80, height: 24 }) {}

	get width(): number {
		return this.size.width;
	}

	get height(): number {
		return this.size.height;
	}

	write(text: string): void {
		if (this.disposed) return;
		this.chunks.push(text);
		if (!text.includes("\x1b")) this.renderedFrames.push(text);
	}

	clear(): void {
		if (this.disposed) return;
		this.clears += 1;
		this.chunks.push("\n--- clear ---\n");
	}

	moveCursor(row: number, column: number): void {
		if (this.disposed) return;
		this.cursor = { row, column };
		this.chunks.push(`\n--- cursor ${row},${column} ---\n`);
	}

	recordFrame(frame: string): void {
		if (this.disposed) return;
		if (this.renderedFrames.at(-1) !== frame) this.renderedFrames.push(frame);
	}

	setRawMode(enabled: boolean): void {
		this.rawMode = enabled;
	}

	onInput(handler: TerminalInputHandler): () => void {
		this.inputHandlers.add(handler);
		return () => this.inputHandlers.delete(handler);
	}

	onResize(handler: TerminalResizeHandler): () => void {
		this.resizeHandlers.add(handler);
		return () => this.resizeHandlers.delete(handler);
	}

	emitInput(chunk: string): void {
		if (this.disposed) return;
		for (const handler of this.inputHandlers) handler(chunk);
	}

	resize(size: TerminalSize): void {
		if (this.disposed) return;
		this.size = size;
		for (const handler of this.resizeHandlers) handler(size);
	}

	dispose(): void {
		this.disposed = true;
		this.rawMode = false;
		this.inputHandlers.clear();
		this.resizeHandlers.clear();
	}

	outputText(): string {
		return this.chunks.join("");
	}

	frames(): string[] {
		return [...this.renderedFrames];
	}

	lastFrame(): string {
		return this.renderedFrames.at(-1) ?? "";
	}

	cursorPosition(): { row: number; column: number } {
		return this.cursor;
	}

	clearCount(): number {
		return this.clears;
	}

	isRawMode(): boolean {
		return this.rawMode;
	}

	isDisposed(): boolean {
		return this.disposed;
	}
}
