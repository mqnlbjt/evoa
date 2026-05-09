import { estimateTextTokens, type ResolvedContextBudget } from "./budget.js";
import { ensureSessionEntries, type AgentSession } from "./session.js";

export interface ContextCategory {
	name: string;
	tokens: number;
	percentage: number;
	entryCount: number;
}

export interface ContextAnalysis {
	categories: ContextCategory[];
	totalTokens: number;
	budgetMaxTokens: number;
	effectiveLimit: number;
	usageFraction: number;
	entryCount: number;
	turnCount: number;
}

export function analyzeContext(session: AgentSession, budget: ResolvedContextBudget): ContextAnalysis {
	const entries = ensureSessionEntries(session);
	const totalTokens = entries.reduce((sum, e) => sum + estimateTextTokens(e.message.role) + estimateTextTokens(e.message.content), 0);
	const effectiveLimit = budget.maxInputTokens - budget.reserveTokens;

	const systemEntries = entries.filter((e) => e.kind === "system");
	const userEntries = entries.filter((e) => e.kind === "user");
	const assistantEntries = entries.filter((e) => e.kind === "assistant");
	const toolEntries = entries.filter((e) => e.kind === "tool_result");
	const compactionEntries = entries.filter((e) => e.kind === "compaction");

	const categories: ContextCategory[] = [
		{ name: "System Prompt", tokens: entryTokens(systemEntries), percentage: 0, entryCount: systemEntries.length },
		{ name: "User Messages", tokens: entryTokens(userEntries), percentage: 0, entryCount: userEntries.length },
		{ name: "Assistant Messages", tokens: entryTokens(assistantEntries), percentage: 0, entryCount: assistantEntries.length },
		{ name: "Tool Results", tokens: entryTokens(toolEntries), percentage: 0, entryCount: toolEntries.length },
		{ name: "Compaction Summaries", tokens: entryTokens(compactionEntries), percentage: 0, entryCount: compactionEntries.length },
	];

	for (const cat of categories) {
		cat.percentage = totalTokens > 0 ? Math.round((cat.tokens / totalTokens) * 100) : 0;
	}

	return {
		categories,
		totalTokens,
		budgetMaxTokens: budget.maxInputTokens,
		effectiveLimit,
		usageFraction: totalTokens > 0 ? parseFloat((totalTokens / effectiveLimit).toFixed(2)) : 0,
		entryCount: entries.length,
		turnCount: session.turnCount,
	};
}

export function formatContextAnalysis(analysis: ContextAnalysis): string {
	const lines = [
		`Context Usage: ${analysis.totalTokens} / ${analysis.effectiveLimit} tokens (${(analysis.usageFraction * 100).toFixed(1)}%)`,
		`Total entries: ${analysis.entryCount} | Turns: ${analysis.turnCount}`,
		"",
		"Breakdown:",
	];
	for (const cat of analysis.categories) {
		const bar = renderBar(cat.percentage, 20);
		lines.push(`  ${cat.name.padEnd(20)} ${String(cat.tokens).padStart(7)} tokens (${String(cat.percentage).padStart(3)}%) ${bar}`);
	}
	return lines.join("\n");
}

function entryTokens(entries: { message: { role: string; content: string } }[]): number {
	if (entries.length === 0) return 0;
	return entries.reduce((sum, e) => sum + estimateTextTokens(e.message.role) + estimateTextTokens(e.message.content), 0);
}

function renderBar(percent: number, width: number): string {
	const filled = Math.round((percent / 100) * width);
	return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}
