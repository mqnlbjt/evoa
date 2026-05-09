export class McpToolCallError extends Error {
	constructor(readonly result: unknown) {
		super("MCP tool returned an error result");
		this.name = "McpToolCallError";
	}
}

export function normalizeMcpToolResult(result: unknown): unknown {
	if (!isRecord(result)) return result;
	if ("toolResult" in result) return normalizeMcpToolResult(result.toolResult);
	const normalized = normalizeContentResult(result);
	if (result.isError === true) throw new McpToolCallError(normalized);
	return normalized;
}

export function normalizeMcpResourceResult(result: unknown): unknown {
	if (!isRecord(result) || !Array.isArray(result.contents)) return result;
	const contents = result.contents.map((content) => {
		if (!isRecord(content)) return content;
		if (typeof content.text === "string") return pickDefined({ uri: content.uri, mimeType: content.mimeType, text: content.text });
		if (typeof content.blob === "string") return unsupportedBinary("resource blob", content.mimeType);
		return content;
	});
	return { contents, ...(isRecord(result._meta) ? { meta: result._meta } : {}) };
}

function normalizeContentResult(result: Record<string, unknown>): unknown {
	const output: Record<string, unknown> = {};
	if (isRecord(result.structuredContent)) output.structuredContent = result.structuredContent;
	if (Array.isArray(result.content)) output.content = result.content.map(normalizeContentBlock);
	if (isRecord(result._meta)) output.meta = result._meta;
	return Object.keys(output).length > 0 ? output : result;
}

function normalizeContentBlock(block: unknown): unknown {
	if (!isRecord(block)) return block;
	if (block.type === "text" && typeof block.text === "string") return pickDefined({ type: "text", text: block.text });
	if (block.type === "resource" && isRecord(block.resource)) {
		if (typeof block.resource.text === "string") return pickDefined({ type: "resource", uri: block.resource.uri, mimeType: block.resource.mimeType, text: block.resource.text });
		if (typeof block.resource.blob === "string") return unsupportedBinary("embedded resource blob", block.resource.mimeType);
	}
	if (block.type === "resource_link") return pickDefined({ type: "resource_link", uri: block.uri, name: block.name, description: block.description, mimeType: block.mimeType });
	if (block.type === "image" || block.type === "audio") return unsupportedBinary(`MCP ${block.type} content`, block.mimeType);
	return block;
}

function unsupportedBinary(kind: string, mimeType: unknown): Record<string, unknown> {
	return pickDefined({ status: "unsupported", kind, mimeType, error: "binary MCP content is not supported in this initial implementation" });
}

function pickDefined(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, unknown] => entry[1] !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
