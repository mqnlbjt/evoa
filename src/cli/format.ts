export function formatTable(rows: string[][]): string {
	if (rows.length === 0) return "";
	const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
	return rows
		.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  ").trimEnd())
		.join("\n");
}

export function formatPercent(value: number): string {
	return `${(value * 100).toFixed(2)}%`;
}

export function formatJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}
