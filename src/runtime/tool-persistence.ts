import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PREVIEW_BYTES = 2000;
const TOOL_RESULTS_SUBDIR = "tool-results";
const DEFAULT_MIN_BYTES = 32 * 1024;

const NON_PERSISTABLE_TOOLS = new Set(["Read", "read_file", "read"]);

export interface PersistLargeOutputResult {
	content: string;
	persistedPath?: string;
}

export async function persistLargeToolOutput(
	output: string,
	toolCallId: string,
	toolName: string,
	storageRoot: string,
	sessionId: string,
	minBytes: number = DEFAULT_MIN_BYTES,
): Promise<PersistLargeOutputResult> {
	const bytes = Buffer.byteLength(output, "utf8");
	if (bytes < minBytes) return { content: output };
	if (NON_PERSISTABLE_TOOLS.has(toolName)) return { content: output };

	const dir = path.join(storageRoot, TOOL_RESULTS_SUBDIR, safeSessionId(sessionId));
	try {
		await mkdir(dir, { recursive: true });
	} catch {
		return { content: output };
	}

	const filePath = path.join(dir, `${safeToolCallId(toolCallId)}.txt`);
	try {
		await writeFile(filePath, output, { flag: "wx" });
	} catch (error) {
		if (!isFileExistsError(error)) return { content: output };
	}

	const preview = truncatePreview(output, PREVIEW_BYTES);
	return {
		content: buildPersistedMessage(preview, filePath, bytes, toolName),
		persistedPath: filePath,
	};
}

function buildPersistedMessage(preview: string, filePath: string, originalBytes: number, _toolName: string): string {
	return `<tool-result-preview>
The full output (${originalBytes} bytes) was saved to:
${filePath}
Preview (first ${PREVIEW_BYTES} bytes):
${preview}
</tool-result-preview>`;
}

function truncatePreview(output: string, maxBytes: number): string {
	const buf = Buffer.from(output, "utf8");
	if (buf.length <= maxBytes) return output;
	return buf.subarray(0, maxBytes).toString();
}

function isFileExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function safeSessionId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function safeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
