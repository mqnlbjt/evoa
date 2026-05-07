import type { Terminal } from "./terminal.js";

export interface CursorPosition {
	row: number;
	column: number;
}

export interface FrameRecordingTerminal extends Terminal {
	recordFrame?: (frame: string) => void;
}

export class ScreenRenderer {
	private previousLines: string[] = [];
	private needsFullRedraw = true;

	constructor(private readonly terminal: FrameRecordingTerminal) {}

	reset(): void {
		this.previousLines = [];
		this.needsFullRedraw = true;
	}

	draw(frame: string, cursor: CursorPosition): void {
		const lines = frame.split("\n");
		if (this.needsFullRedraw) {
			this.terminal.clear();
			this.terminal.write(frame);
			this.terminal.recordFrame?.(frame);
			this.terminal.moveCursor(cursor.row, cursor.column);
			this.previousLines = lines;
			this.needsFullRedraw = false;
			return;
		}
		const output = diffOutput(this.previousLines, lines);
		if (output) this.terminal.write(syncOutput(output));
		this.terminal.recordFrame?.(frame);
		this.terminal.moveCursor(cursor.row, cursor.column);
		this.previousLines = lines;
	}
}

function diffOutput(previous: string[], next: string[]): string {
	const max = Math.max(previous.length, next.length);
	let output = "";
	for (let index = 0; index < max; index += 1) {
		if ((previous[index] ?? "") === (next[index] ?? "")) continue;
		output += `\x1b[${index + 1};1H\x1b[2K${next[index] ?? ""}`;
	}
	return output;
}

function syncOutput(output: string): string {
	return `\x1b[?2026h${output}\x1b[?2026l`;
}
