import type { BenchmarkRunner } from "../benchmark/runner.js";
import type { BenchmarkSuite, SuiteRunResult } from "../benchmark/types.js";
import type { AgentSpec } from "../specs.js";
import type { CandidateGenerator, EvolutionCandidate, EvolutionComparison } from "./types.js";

export interface EvolutionEngine {
	generateCandidates(): Promise<EvolutionCandidate[]>;
	compare(candidate: EvolutionCandidate): Promise<EvolutionComparison>;
}

export interface BenchmarkEvolutionEngineOptions {
	baseline: AgentSpec;
	suite: BenchmarkSuite;
	generator: CandidateGenerator;
	createRunner: (agent: AgentSpec) => BenchmarkRunner | Promise<BenchmarkRunner>;
}

export class BenchmarkEvolutionEngine implements EvolutionEngine {
	constructor(private readonly options: BenchmarkEvolutionEngineOptions) {}

	async generateCandidates(): Promise<EvolutionCandidate[]> {
		return this.options.generator.generate(this.options.baseline);
	}

	async compare(candidate: EvolutionCandidate): Promise<EvolutionComparison> {
		const baselineRunner = await this.options.createRunner(this.options.baseline);
		const candidateRunner = await this.options.createRunner(candidate.agent);
		const baseline = await baselineRunner.runSuite(this.options.baseline, this.options.suite);
		const candidateResult = await candidateRunner.runSuite(candidate.agent, this.options.suite);
		const regressions = findRegressions(baseline, candidateResult);
		const improvements = findImprovements(baseline, candidateResult);
		const deltaScore = candidateResult.summary.totalScore - baseline.summary.totalScore;
		const deltaPassRate = candidateResult.summary.passRate - baseline.summary.passRate;

		const memory = memoryComparison(baseline, candidateResult);
		return {
			baseline,
			candidate: candidateResult,
			deltaScore,
			deltaPassRate,
			regressions,
			improvements,
			recommendation: recommend(deltaScore, deltaPassRate, regressions, memory.issueDelta),
			metadata: { candidateId: candidate.id, candidateKind: candidate.kind, memory },
		};
	}
}

export class NotImplementedEvolutionEngine implements EvolutionEngine {
	async generateCandidates(): Promise<EvolutionCandidate[]> {
		throw new Error("EvolutionEngine candidate generation is not implemented yet");
	}

	async compare(candidate: EvolutionCandidate): Promise<EvolutionComparison> {
		throw new Error(`EvolutionEngine comparison is not implemented yet for ${candidate.id}`);
	}
}

function findRegressions(baseline: SuiteRunResult, candidate: SuiteRunResult): string[] {
	return compareRuns(baseline, candidate, (basePassed, candidatePassed) => basePassed && !candidatePassed);
}

function findImprovements(baseline: SuiteRunResult, candidate: SuiteRunResult): string[] {
	return compareRuns(baseline, candidate, (basePassed, candidatePassed) => !basePassed && candidatePassed);
}

function compareRuns(
	baseline: SuiteRunResult,
	candidate: SuiteRunResult,
	predicate: (basePassed: boolean, candidatePassed: boolean) => boolean,
): string[] {
	const candidateRuns = new Map(candidate.runs.map((run) => [run.task.id, run]));
	const taskIds: string[] = [];
	for (const baselineRun of baseline.runs) {
		const candidateRun = candidateRuns.get(baselineRun.task.id);
		if (!candidateRun) continue;
		if (predicate(baselineRun.status === "passed", candidateRun.status === "passed")) {
			taskIds.push(baselineRun.task.id);
		}
	}
	return taskIds;
}

function memoryComparison(baseline: SuiteRunResult, candidate: SuiteRunResult): { baselineIssues: number; candidateIssues: number; issueDelta: number } {
	const baselineIssues = baseline.runs.reduce((sum, run) => sum + memoryIssueCount(run.score.details), 0);
	const candidateIssues = candidate.runs.reduce((sum, run) => sum + memoryIssueCount(run.score.details), 0);
	return { baselineIssues, candidateIssues, issueDelta: candidateIssues - baselineIssues };
}

function memoryIssueCount(details: Record<string, unknown> | undefined): number {
	const memory = details && typeof details.memory === "object" && details.memory !== null ? details.memory as Record<string, unknown> : undefined;
	return numberField(memory, "contaminationCount") + numberField(memory, "missingSourceRefs") + numberField(memory, "revokedCount");
}

function numberField(value: Record<string, unknown> | undefined, key: string): number {
	const field = value?.[key];
	return typeof field === "number" ? field : 0;
}

function recommend(
	deltaScore: number,
	deltaPassRate: number,
	regressions: string[],
	memoryIssueDelta: number,
): EvolutionComparison["recommendation"] {
	if (memoryIssueDelta > 1) return "reject";
	if (memoryIssueDelta > 0) return "needs-review";
	if (regressions.length > 0 && (deltaScore < 0 || deltaPassRate < 0)) return "reject";
	if (regressions.length > 0) return "needs-review";
	if (deltaScore > 0 || deltaPassRate > 0) return "accept";
	return "needs-review";
}
