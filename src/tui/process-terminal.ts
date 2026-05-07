import type { Terminal, TerminalInputHandler, TerminalResizeHandler, TerminalSize } from "./terminal.js";

interface TerminalInputStream {
	isTTY?: boolean;
	setRawMode?: (enabled: boolean) => void;
	resume: () => void;
	on: (event: "data", handler: (chunk: Buffer) => void) => unknown;
	off: (event: "data", handler: (chunk: Buffer) => void) => unknown;
}

interface TerminalOutputStream {
	columns?: number;
	rows?: number;
	write: (chunk: string) => unknown;
	on: (event: "resize", handler: () => void) => unknown;
	off: (event: "resize", handler: () => void) => unknown;
}

export class ProcessTerminal implements Terminal {
	private inputHandlers = new Set<TerminalInputHandler>();
	private resizeHandlers = new Set<TerminalResizeHandler>();
	private readonly onData = (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		for (const handler of this.inputHandlers) handler(text);
	};
	private readonly onOutputResize = () => {
		const size = { width: this.width, height: this.height };
		for (const handler of this.resizeHandlers) handler(size);
	};

	constructor(private readonly input: TerminalInputStream = process.stdin, private readonly output: TerminalOutputStream = process.stdout) {
		this.input.on("data", this.onData);
		this.output.on("resize", this.onOutputResize);
	}

	get width(): number {
		return this.output.columns ?? 80;
	}

	get height(): number {
		return this.output.rows ?? 24;
	}

	write(text: string): void {
		this.output.write(text);
	}

	clear(): void {
		this.output.write("\x1b[2J\x1b[H");
	}

	moveCursor(row: number, column: number): void {
		this.output.write(`\x1b[${Math.max(1, row)};${Math.max(1, column)}H`);
	}

	setRawMode(enabled: boolean): void {
		if (this.input.isTTY && typeof this.input.setRawMode === "function") this.input.setRawMode(enabled);
		if (enabled) this.input.resume();
	}

	onInput(handler: TerminalInputHandler): () => void {
		this.inputHandlers.add(handler);
		return () => this.inputHandlers.delete(handler);
	}

	onResize(handler: TerminalResizeHandler): () => void {
		this.resizeHandlers.add(handler);
		return () => this.resizeHandlers.delete(handler);
	}

	dispose(): void {
		this.setRawMode(false);
		this.input.off("data", this.onData);
		this.output.off("resize", this.onOutputResize);
		this.inputHandlers.clear();
		this.resizeHandlers.clear();
	}
}
