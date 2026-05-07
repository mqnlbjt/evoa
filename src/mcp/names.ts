const invalidNameCharacters = /[^a-zA-Z0-9_-]+/g;

export function normalizeMcpName(value: string): string {
	const normalized = value.trim().replace(invalidNameCharacters, "_").replace(/^_+|_+$/g, "");
	if (!normalized) throw new Error(`MCP name ${JSON.stringify(value)} normalizes to an empty name`);
	return normalized;
}

export function qualifiedMcpToolName(serverName: string, toolName: string): string {
	return `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(toolName)}`;
}

export function parseQualifiedMcpToolName(name: string): { serverName: string; toolName: string } | undefined {
	const match = /^mcp__([^_].*?)__(.+)$/.exec(name);
	if (!match?.[1] || !match[2]) return undefined;
	return { serverName: match[1], toolName: match[2] };
}
