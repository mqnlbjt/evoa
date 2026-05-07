import { describe, expect, it } from "vitest";
import { InputEditor } from "../src/tui/input-editor.js";

describe("InputEditor", () => {
	it("submits typed text", () => {
		const editor = new InputEditor();
		editor.handleInput("hello");
		expect(editor.handleInput("\n")).toEqual([{ type: "submit", value: "hello" }]);
		expect(editor.state.value).toBe("");
	});

	it("handles backspace and ctrl-c", () => {
		const editor = new InputEditor();
		editor.handleInput("ab");
		editor.handleInput("\u007f");
		expect(editor.state.value).toBe("a");
		expect(editor.handleInput("\u0003")).toEqual([{ type: "cancel" }]);
		expect(editor.handleInput("\u0003")).toEqual([{ type: "exit" }]);
	});

	it("navigates history", () => {
		const editor = new InputEditor();
		editor.handleInput("first");
		editor.handleInput("\n");
		editor.handleInput("second");
		editor.handleInput("\n");
		editor.handleInput("\x1b[A");
		expect(editor.state.value).toBe("second");
		editor.handleInput("\x1b[A");
		expect(editor.state.value).toBe("first");
		editor.handleInput("\x1b[B");
		expect(editor.state.value).toBe("second");
	});

	it("moves the cursor and inserts text at the cursor", () => {
		const editor = new InputEditor();
		editor.handleInput("helo");
		editor.handleInput("\x1b[D");
		editor.handleInput("l");
		expect(editor.state).toMatchObject({ value: "hello", cursor: 4 });
		editor.handleInput("\x1b[C");
		expect(editor.state.cursor).toBe(5);
	});

	it("places the cursor after wide input characters", () => {
		const editor = new InputEditor();
		editor.handleInput("你好");
		expect(editor.state.cursor).toBe(2);
		expect(editor.cursorColumn(80)).toBe(7);
		editor.handleInput("\x1b[D");
		expect(editor.cursorColumn(80)).toBe(5);
	});

	it("handles delete home end and pasted multiline text", () => {
		const editor = new InputEditor();
		editor.handleInput("abde");
		editor.handleInput("\x1b[H");
		expect(editor.state.cursor).toBe(0);
		editor.handleInput("\x1b[F");
		expect(editor.state.cursor).toBe(4);
		editor.handleInput("\x1b[D");
		editor.handleInput("\x1b[3~");
		expect(editor.state.value).toBe("abd");
		editor.handleInput("\x1b[1~");
		editor.handleInput("x\ny");
		expect(editor.state).toMatchObject({ value: "x yabd", cursor: 3 });
		editor.handleInput("\x1b[4~");
		expect(editor.state.cursor).toBe(6);
	});
});
