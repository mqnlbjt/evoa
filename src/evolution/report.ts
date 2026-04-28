import type { BenchmarkSummary, SuiteRunResult } from "../benchmark/types.js";
import { verifyEvolutionComparison, type VerificationReport } from "../verification/verifier.js";
import type { EvolutionCandidate, EvolutionComparison } from "./types.js";

export type EvolutionReportFormat = "json" | "markdown";

export interface EvolutionReportOptions {
	generatedAt?: string;
	candidate?: EvolutionCandidate;
	verification?: VerificationReport;
}

export interface EvolutionReport {
	version: 1;
	generatedAt: string;
	suite: {
		id: string;
		name: string;
		description?: string;
		taskCount: number;
	};
	baselineAgent: EvolutionReportAgent;
	candidateAgent: EvolutionReportAgent;
	candidate?: EvolutionReportCandidate;
	summary: {
		baseline: BenchmarkSummary;
		candidate: BenchmarkSummary;
		deltaScore: number;
		deltaPassRate: number;
		regressions: string[];
		improvements: string[];
		recommendation: EvolutionComparison["recommendation"];
	};
	verification: VerificationReport;
}

export interface EvolutionReportAgent {
	id: string;
	version: string;
	name: string;
	kind: string;
}

export interface EvolutionReportCandidate {
	id: string;
	kind: string;
	parentAgentId: string;
	description: string;
	patch?: string;
	metadata?: Record<string, unknown>;
}

export function createEvolutionReport(comparison: EvolutionComparison, options: EvolutionReportOptions = {}): EvolutionReport {
	return {
		version: 1,
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		suite: suiteReport(comparison.candidate),
		baselineAgent: agentReport(comparison.baseline),
		candidateAgent: agentReport(comparison.candidate),
		...(options.candidate ? { candidate: candidateReport(options.candidate) } : {}),
		summary: {
			baseline: comparison.baseline.summary,
			candidate: comparison.candidate.summary,
			deltaScore: comparison.deltaScore,
			deltaPassRate: comparison.deltaPassRate,
			regressions: comparison.regressions,
			improvements: comparison.improvements,
			recommendation: comparison.recommendation,
		},
		verification: options.verification ?? verifyEvolutionComparison(comparison.baseline, comparison.candidate),
	};
}

export function formatEvolutionReportMarkdown(report: EvolutionReport): string {
	const lines = [
		`# Evolution Report: ${escapeMarkdown(report.suite.name)}`,
		"",
		`Generated: ${report.generatedAt}`,
		"",
		"## Suite",
		"",
		`- ID: \`${report.suite.id}\``,
		`- Tasks: ${report.suite.taskCount}`,
		...(report.suite.description ? [`- Description: ${escapeMarkdown(report.suite.description)}`] : []),
		"",
		"## Agents",
		"",
		`- Baseline: ${escapeMarkdown(report.baselineAgent.name)} (\`${report.baselineAgent.id}@${report.baselineAgent.version}\`)`,
		`- Candidate: ${escapeMarkdown(report.candidateAgent.name)} (\`${report.candidateAgent.id}@${report.candidateAgent.version}\`)`,
		...(report.candidate ? [`- Candidate description: ${escapeMarkdown(report.candidate.description)}`] : []),
		"",
		"## Summary",
		"",
		`- Recommendation: \`${report.summary.recommendation}\``,
		`- Delta score: ${formatSignedNumber(report.summary.deltaScore)}`,
		`- Delta pass rate: ${formatSignedNumber(report.summary.deltaPassRate * 100)}%`,
		`- Baseline score: ${report.summary.baseline.totalScore}/${report.summary.baseline.maxScore}`,
		`- Candidate score: ${report.summary.candidate.totalScore}/${report.summary.candidate.maxScore}`,
		`- Baseline pass rate: ${formatPercent(report.summary.baseline.passRate)}`,
		`- Candidate pass rate: ${formatPercent(report.summary.candidate.passRate)}`,
		"",
		"## Changes",
		"",
		`- Improvements: ${formatTaskList(report.summary.improvements)}`,
		`- Regressions: ${formatTaskList(report.summary.regressions)}`,
		"",
		"## Verification",
		"",
		`- Verdict: \`${report.verification.verdict}\``,
		`- Gate: ${report.verification.blocking ? "blocked" : "passed"}`,
		`- Summary: ${escapeMarkdown(report.verification.summary)}`,
	];
	if (report.verification.issues.length > 0) {
		lines.push("", "| Type | Severity | Task | Message |", "| --- | --- | --- | --- |");
		for (const issue of report.verification.issues) {
			lines.push(`| ${escapeTable(issue.type)} | ${escapeTable(issue.severity)} | ${escapeTable(issue.taskId)} | ${escapeTable(issue.message)} |`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function suiteReport(result: SuiteRunResult): EvolutionReport["suite"] {
	return {
		id: result.suite.id,
		name: result.suite.name,
		...(result.suite.description ? { description: result.suite.description } : {}),
		taskCount: result.suite.tasks.length,
	};
}

function agentReport(result: SuiteRunResult): EvolutionReportAgent {
	return {
		id: result.agent.id,
		version: result.agent.version,
		name: result.agent.name,
		kind: result.agent.kind,
	};
}

function candidateReport(candidate: EvolutionCandidate): EvolutionReportCandidate {
	return {
		id: candidate.id,
		kind: candidate.kind,
		parentAgentId: candidate.parentAgentId,
		description: candidate.description,
		...(candidate.patch ? { patch: candidate.patch } : {}),
		...(candidate.metadata ? { metadata: candidate.metadata } : {}),
	};
}

function formatTaskList(taskIds: string[]): string {
	return taskIds.length === 0 ? "none" : taskIds.map((id) => `\`${escapeMarkdown(id)}\``).join(", ");
}

function formatPercent(value: number): string {
	return `${formatNumber(value * 100)}%`;
}

function formatSignedNumber(value: number): string {
	if (value === 0) return "0";
	return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function escapeMarkdown(value: string): string {
	return value.replace(/[\\`*_{}[\]()#+\-.!|]/g, "\\$&");
}

function escapeTable(value: string): string {
	return escapeMarkdown(value).replace(/\r?\n/g, "<br>");
}
