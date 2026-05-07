export function displayWidth(value: string): number {
	return Array.from(stripAnsi(value)).reduce((width, character) => width + characterWidth(character), 0);
}

export function truncateDisplayWidth(value: string, width: number): string {
	if (width <= 0) return "";
	let output = "";
	let used = 0;
	for (let index = 0; index < value.length;) {
		const ansi = readAnsiSequence(value, index);
		if (ansi) {
			output += ansi.sequence;
			index = ansi.end;
			continue;
		}
		const character = Array.from(value.slice(index))[0] ?? "";
		const nextWidth = characterWidth(character);
		if (used + nextWidth > width) break;
		output += character;
		used += nextWidth;
		index += character.length;
	}
	return output;
}

export function wrapDisplayWidth(value: string, width: number): string[] {
	if (width <= 0) return [""];
	if (value.length === 0) return [""];
	const lines: string[] = [];
	let line = "";
	let used = 0;
	for (const character of Array.from(value)) {
		const nextWidth = characterWidth(character);
		if (used > 0 && used + nextWidth > width) {
			lines.push(line);
			line = "";
			used = 0;
		}
		line += character;
		used += nextWidth;
	}
	lines.push(line);
	return lines;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function readAnsiSequence(value: string, index: number): { sequence: string; end: number } | undefined {
	if (value[index] !== "\x1b" || value[index + 1] !== "[") return undefined;
	let end = index + 2;
	while (end < value.length) {
		const code = value.charCodeAt(end);
		end += 1;
		if (code >= 0x40 && code <= 0x7e) return { sequence: value.slice(index, end), end };
	}
	return undefined;
}

function characterWidth(character: string): number {
	const code = character.codePointAt(0) ?? 0;
	if (code === 0) return 0;
	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
	if (isWideCodePoint(code)) return 2;
	return 1;
}

function isWideCodePoint(code: number): boolean {
	return (code >= 0x1100 && code <= 0x115f) || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd);
}
