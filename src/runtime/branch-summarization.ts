import type { ModelMessage } from "../models/types.js";
import { estimateTextTokens } from "./budget.js";
import { appendBranchSummaryEntry, type AgentSession } from "./session.js";

export interface BranchSummaryInput {
	subagentId: string;
	task: string;
	answer: string;
	status: "completed" | "errored";
	errorMessage?: string;
	turnCount: number;
	durationMs: number;
}

export interface BranchSummaryOutput {
	summary: string;
	tokens: number;
	entryId: string;
}

export function summarizeBranch(session: AgentSession, input: BranchSummaryInput, createId: () => string, now: () => number): BranchSummaryOutput {
	const summary = buildBranchSummary(input);
	const tokens = estimateTextTokens(summary);
	const entry = appendBranchSummaryEntry(session, {
		branchId: input.subagentId,
		subagentId: input.subagentId,
		task: input.task,
		answer: input.answer,
		status: input.status,
		...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
		turnCount: input.turnCount,
		durationMs: input.durationMs,
		id: createId(),
		createdAt: now(),
	});
	return { summary, tokens, entryId: entry.id };
}

function buildBranchSummary(input: BranchSummaryInput): string {
	const status = input.status === "completed" ? "completed successfully" : "errored";
	const lines = [
		`[Subagent branch summary: ${input.subagentId}]`,
		`Status: ${status}`,
		`Task: ${input.task}`,
		`Turns: ${input.turnCount}`,
		`Duration: ${input.durationMs}ms`,
	];
	if (input.answer) {
		const trimmed = input.answer.length > 2000 ? `${input.answer.slice(0, 2000)}...[truncated]` : input.answer;
		lines.push(`Answer: ${trimmed}`);
	}
	if (input.errorMessage) {
		lines.push(`Error: ${input.errorMessage}`);
	}
	return lines.join("\n");
}

export function buildBranchSummaryMessage(input: BranchSummaryInput): ModelMessage {
	const content = buildBranchSummary(input);
	return {
		role: "user",
		content,
		contentBlocks: [{ type: "text", text: content }],
	};
}
