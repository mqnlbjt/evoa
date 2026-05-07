import type { TuiStateSnapshot, TuiView } from "./types.js";

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

export class TuiViewportController {
	private chatOffset = 0;
	private readonly viewOffsets: Record<Exclude<TuiView, "chat">, number> = { stats: 0, trace: 0 };

	logScrollOffset(): number {
		return this.chatOffset;
	}

	viewScrollOffset(view: TuiView): number {
		return view === "chat" ? 0 : this.viewOffsets[view];
	}

	reset(view: TuiView): void {
		if (view === "chat") this.chatOffset = 0;
		else this.viewOffsets[view] = 0;
	}

	handleScrollInput(chunk: string, snapshot: TuiStateSnapshot | undefined, terminalHeight: number): boolean {
		if (chunk !== PAGE_UP && chunk !== PAGE_DOWN) return false;
		const view = snapshot?.activeView ?? "chat";
		const delta = view === "chat" ? 1 : pageScrollDelta(terminalHeight, snapshot?.runningTools.length ?? 0);
		const direction = chunk === PAGE_UP ? delta : -delta;
		if (view === "chat") this.chatOffset = Math.max(0, this.chatOffset + direction);
		else this.viewOffsets[view] = Math.max(0, this.viewOffsets[view] + direction);
		return true;
	}
}

function pageScrollDelta(height: number, runningToolCount: number): number {
	return Math.max(1, height - 7 - runningToolCount);
}
