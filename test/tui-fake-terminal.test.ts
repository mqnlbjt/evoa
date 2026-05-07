import { describe, expect, it } from "vitest";
import { FakeTerminal } from "../src/tui/fake-terminal.js";

describe("FakeTerminal", () => {
	it("records output and frame writes", () => {
		const terminal = new FakeTerminal();
		terminal.write("one");
		terminal.clear();
		terminal.write("two");
		expect(terminal.outputText()).toContain("one");
		expect(terminal.outputText()).toContain("--- clear ---");
		expect(terminal.lastFrame()).toBe("two");
		terminal.moveCursor(2, 3);
		expect(terminal.cursorPosition()).toEqual({ row: 2, column: 3 });
	});

	it("emits input and resize until disposed", () => {
		const terminal = new FakeTerminal();
		const input: string[] = [];
		const sizes: string[] = [];
		const offInput = terminal.onInput((chunk) => input.push(chunk));
		terminal.onResize((size) => sizes.push(`${size.width}x${size.height}`));
		terminal.emitInput("a");
		terminal.resize({ width: 40, height: 10 });
		offInput();
		terminal.emitInput("b");
		terminal.dispose();
		terminal.resize({ width: 80, height: 20 });
		expect(input).toEqual(["a"]);
		expect(sizes).toEqual(["40x10"]);
		expect(terminal.isDisposed()).toBe(true);
	});
});
