export type ToolOutputTruncationStrategy = "none" | "head-tail" | "head-only";

export interface ToolOutputTruncationMetadata {
	truncated: boolean;
	strategy: ToolOutputTruncationStrategy;
	originalBytes: number;
	visibleBytes: number;
	maxBytes: number;
	headBytes?: number;
	tailBytes?: number;
	omittedBytes?: number;
}

export interface TruncateToolOutputOptions {
	maxBytes: number;
	strategy?: "head-tail" | "head-only";
	headBytes?: number;
	tailBytes?: number;
	includeMetadata?: boolean;
}

export interface TruncatedToolOutput {
	content: string;
	metadata: ToolOutputTruncationMetadata;
}

export function truncateToolOutput(value: string, options: TruncateToolOutputOptions): TruncatedToolOutput {
	const originalBytes = byteLength(value);
	const strategy = options.strategy ?? "head-tail";
	if (originalBytes <= options.maxBytes) {
		return {
			content: value,
			metadata: { truncated: false, strategy: "none", originalBytes, visibleBytes: originalBytes, maxBytes: options.maxBytes },
		};
	}

	if (strategy === "head-only") return truncateHeadOnly(value, originalBytes, options);
	return truncateHeadTail(value, originalBytes, options);
}

export function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8Head(value: string, maxBytes: number): string {
	let bytes = 0;
	let output = "";
	for (const char of value) {
		const next = byteLength(char);
		if (bytes + next > maxBytes) break;
		bytes += next;
		output += char;
	}
	return output;
}

export function truncateUtf8Tail(value: string, maxBytes: number): string {
	let bytes = 0;
	let output = "";
	for (let index = value.length - 1; index >= 0; index -= 1) {
		const char = value[index]!;
		if (isLowSurrogate(char) && index > 0) {
			const pair = `${value[index - 1]!}${char}`;
			const next = byteLength(pair);
			if (bytes + next > maxBytes) break;
			bytes += next;
			output = pair + output;
			index -= 1;
			continue;
		}
		const next = byteLength(char);
		if (bytes + next > maxBytes) break;
		bytes += next;
		output = char + output;
	}
	return output;
}

function truncateHeadOnly(value: string, originalBytes: number, options: TruncateToolOutputOptions): TruncatedToolOutput {
	const maxBytes = options.maxBytes;
	const headBytes = Math.min(options.headBytes ?? maxBytes, maxBytes);

	if (options.includeMetadata === false) {
		const head = truncateUtf8Head(value, headBytes);
		return headOnlyResult(head, originalBytes, maxBytes, head);
	}

	return fitHeadOnly(value, originalBytes, maxBytes, headBytes);
}

function fitHeadOnly(value: string, originalBytes: number, maxBytes: number, headBytes: number): TruncatedToolOutput {
	const fitted = fitHead(value, maxBytes, headBytes, (head) => buildHeadOnlyJson(originalBytes, head));
	return headOnlyResult(fitted.content, originalBytes, maxBytes, fitted.head);
}

function buildHeadOnlyJson(originalBytes: number, head: string): string {
	return JSON.stringify({
		truncated: true,
		strategy: "head-only",
		originalBytes,
		visibleBytes: byteLength(head),
		head,
		omittedBytes: originalBytes - byteLength(head),
	});
}

function headOnlyResult(content: string, originalBytes: number, maxBytes: number, head: string): TruncatedToolOutput {
	return {
		content,
		metadata: {
			truncated: true,
			strategy: "head-only",
			originalBytes,
			visibleBytes: byteLength(content),
			maxBytes,
			headBytes: byteLength(head),
			omittedBytes: Math.max(0, originalBytes - byteLength(head)),
		},
	};
}

function truncateHeadTail(value: string, originalBytes: number, options: TruncateToolOutputOptions): TruncatedToolOutput {
	const maxBytes = options.maxBytes;
	const fallbackHeadBytes = Math.floor(maxBytes / 2);
	const headBytes = Math.min(options.headBytes ?? fallbackHeadBytes, maxBytes);
	const tailBytes = Math.min(options.tailBytes ?? maxBytes - headBytes, Math.max(0, maxBytes - headBytes));

	if (options.includeMetadata === false) {
		return fitHeadTail(value, originalBytes, maxBytes, headBytes, tailBytes, buildPlainHeadTail);
	}

	return fitHeadTail(value, originalBytes, maxBytes, headBytes, tailBytes, buildHeadTailJson);
}

function fitHeadTail(value: string, originalBytes: number, maxBytes: number, headBytes: number, tailBytes: number, build: (originalBytes: number, head: string, tail: string) => string): TruncatedToolOutput {
	const fitted = fitHeadAndTail(value, maxBytes, headBytes, tailBytes, (head, tail) => build(originalBytes, head, tail));
	const kept = byteLength(fitted.head) + byteLength(fitted.tail);
	return {
		content: fitted.content,
		metadata: {
			truncated: true,
			strategy: "head-tail",
			originalBytes,
			visibleBytes: byteLength(fitted.content),
			maxBytes,
			headBytes: byteLength(fitted.head),
			tailBytes: byteLength(fitted.tail),
			omittedBytes: Math.max(0, originalBytes - kept),
		},
	};
}

function fitHead(value: string, maxBytes: number, headBytes: number, build: (head: string) => string): { head: string; content: string } {
	let low = 0;
	let high = Math.max(0, headBytes);
	let best = { head: "", content: truncateUtf8Head(build(""), maxBytes) };
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const head = truncateUtf8Head(value, mid);
		const content = build(head);
		if (byteLength(content) <= maxBytes) {
			best = { head, content };
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best;
}

function fitHeadAndTail(value: string, maxBytes: number, headBytes: number, tailBytes: number, build: (head: string, tail: string) => string): { head: string; tail: string; content: string } {
	let low = 0;
	let high = Math.max(0, headBytes + tailBytes);
	let best = { head: "", tail: "", content: truncateUtf8Head(build("", ""), maxBytes) };
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const split = splitBytes(mid, headBytes, tailBytes);
		const head = truncateUtf8Head(value, split.headBytes);
		const tail = truncateUtf8Tail(value, split.tailBytes);
		const content = build(head, tail);
		if (byteLength(content) <= maxBytes) {
			best = { head, tail, content };
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best;
}

function splitBytes(total: number, headLimit: number, tailLimit: number): { headBytes: number; tailBytes: number } {
	const ratio = headLimit / Math.max(1, headLimit + tailLimit);
	let headBytes = Math.min(headLimit, Math.floor(total * ratio));
	let tailBytes = Math.min(tailLimit, total - headBytes);
	let remaining = total - headBytes - tailBytes;
	const addHead = Math.min(headLimit - headBytes, remaining);
	headBytes += addHead;
	remaining -= addHead;
	tailBytes += Math.min(tailLimit - tailBytes, remaining);
	return { headBytes, tailBytes };
}

function buildHeadTailJson(originalBytes: number, head: string, tail: string): string {
	return JSON.stringify({
		truncated: true,
		strategy: "head-tail",
		originalBytes,
		visibleBytes: byteLength(head) + byteLength(tail),
		head,
		tail,
		omittedBytes: originalBytes - (byteLength(head) + byteLength(tail)),
	});
}

function buildPlainHeadTail(originalBytes: number, head: string, tail: string): string {
	const keptBytes = byteLength(head) + byteLength(tail);
	return `${head}\n[truncated: omitted ${Math.max(0, originalBytes - keptBytes)} bytes]\n${tail}`;
}

function isLowSurrogate(value: string): boolean {
	const code = value.charCodeAt(0);
	return code >= 0xdc00 && code <= 0xdfff;
}
