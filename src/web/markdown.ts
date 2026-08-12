export function renderMarkdown(text: string): string[] {
	const lines = text.split(/\r?\n/);
	const rendered: string[] = [];
	let inCode = false;
	for (const line of lines) {
		if (line.trim().startsWith("```")) {
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			rendered.push(`  ${line}`);
			continue;
		}
		if (line.startsWith("#")) {
			rendered.push(line.replace(/^#+\s*/, "").toUpperCase());
			continue;
		}
		if (/^\s*[-*]\s+/.test(line)) {
			rendered.push(line.replace(/^\s*[-*]\s+/, "• "));
			continue;
		}
		rendered.push(line.replace(/`([^`]+)`/g, "$1"));
	}
	return rendered;
}
