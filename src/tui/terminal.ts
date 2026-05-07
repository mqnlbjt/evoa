export interface TerminalSize {
	width: number;
	height: number;
}

export type TerminalInputHandler = (chunk: string) => void;
export type TerminalResizeHandler = (size: TerminalSize) => void;

export interface Terminal {
	readonly width: number;
	readonly height: number;
	write(text: string): void;
	clear(): void;
	moveCursor(row: number, column: number): void;
	setRawMode(enabled: boolean): void;
	onInput(handler: TerminalInputHandler): () => void;
	onResize(handler: TerminalResizeHandler): () => void;
	dispose(): void;
}
