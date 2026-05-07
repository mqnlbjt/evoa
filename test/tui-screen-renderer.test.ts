import { describe, expect, it } from "vitest";
import { FakeTerminal } from "../src/tui/fake-terminal.js";
import { ScreenRenderer } from "../src/tui/screen-renderer.js";

describe("ScreenRenderer", () => {
	it("clears only on the first draw and diffs later frames", () => {
		const terminal = new FakeTerminal();
		const screen = new ScreenRenderer(terminal);
		screen.draw("one\ntwo", { row: 2, column: 4 });
		screen.draw("one\nchanged", { row: 2, column: 8 });
		expect(terminal.clearCount()).toBe(1);
		expect(terminal.outputText()).toContain("\x1b[?2026h");
		expect(terminal.outputText()).toContain("\x1b[2;1H\x1b[2Kchanged");
		expect(terminal.cursorPosition()).toEqual({ row: 2, column: 8 });
	});

	it("clears stale tail lines when the next frame is shorter", () => {
		const terminal = new FakeTerminal();
		const screen = new ScreenRenderer(terminal);
		screen.draw("one\ntwo\nthree", { row: 3, column: 1 });
		screen.draw("one", { row: 1, column: 1 });
		expect(terminal.outputText()).toContain("\x1b[2;1H\x1b[2K");
		expect(terminal.outputText()).toContain("\x1b[3;1H\x1b[2K");
	});

	it("uses a full redraw after reset", () => {
		const terminal = new FakeTerminal();
		const screen = new ScreenRenderer(terminal);
		screen.draw("one", { row: 1, column: 1 });
		screen.reset();
		screen.draw("two", { row: 1, column: 1 });
		expect(terminal.clearCount()).toBe(2);
	});
});
