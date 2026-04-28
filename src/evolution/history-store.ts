import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSpec } from "../specs.js";
import type { EvolutionCandidate, EvolutionComparison } from "./types.js";

export interface EvolutionHistoryRecord {
	type: "evolution_comparison";
	version: 1;
	timestamp: string;
	suiteId: string;
	baselineAgent: AgentSpec;
	candidateAgent: AgentSpec;
	candidate?: {
		id: string;
		kind: string;
		parentAgentId: string;
		description: string;
		patch?: string;
		metadata?: Record<string, unknown>;
	};
	baselineRunIds: string[];
	candidateRunIds: string[];
	deltaScore: number;
	deltaPassRate: number;
	regressions: string[];
	improvements: string[];
	recommendation: EvolutionComparison["recommendation"];
	metadata?: Record<string, unknown>;
}

export interface EvolutionHistoryStoreOptions {
	now?: () => Date;
}

export class JsonlEvolutionHistoryStore {
	constructor(private readonly filePath: string, private readonly options: EvolutionHistoryStoreOptions = {}) {}

	async saveComparison(comparison: EvolutionComparison, candidate?: EvolutionCandidate): Promise<EvolutionHistoryRecord> {
		const record = createEvolutionHistoryRecord(comparison, {
			...(candidate ? { candidate } : {}),
			timestamp: (this.options.now?.() ?? new Date()).toISOString(),
		});
		await mkdir(dirname(this.filePath), { recursive: true });
		await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
		return record;
	}

	async readRecords(): Promise<EvolutionHistoryRecord[]> {
		let content: string;
		try {
			content = await readFile(this.filePath, "utf-8");
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		return content
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as EvolutionHistoryRecord);
	}
}

export function createEvolutionHistoryRecord(
	comparison: EvolutionComparison,
	options: { candidate?: EvolutionCandidate; timestamp?: string } = {},
): EvolutionHistoryRecord {
	const record: EvolutionHistoryRecord = {
		type: "evolution_comparison",
		version: 1,
		timestamp: options.timestamp ?? new Date().toISOString(),
		suiteId: comparison.candidate.suite.id,
		baselineAgent: comparison.baseline.agent,
		candidateAgent: comparison.candidate.agent,
		baselineRunIds: comparison.baseline.runs.map((run) => run.runId),
		candidateRunIds: comparison.candidate.runs.map((run) => run.runId),
		deltaScore: comparison.deltaScore,
		deltaPassRate: comparison.deltaPassRate,
		regressions: comparison.regressions,
		improvements: comparison.improvements,
		recommendation: comparison.recommendation,
		...(comparison.metadata ? { metadata: comparison.metadata } : {}),
	};
	if (options.candidate) record.candidate = historyCandidate(options.candidate);
	return record;
}

function historyCandidate(candidate: EvolutionCandidate): NonNullable<EvolutionHistoryRecord["candidate"]> {
	return {
		id: candidate.id,
		kind: candidate.kind,
		parentAgentId: candidate.parentAgentId,
		description: candidate.description,
		...(candidate.patch ? { patch: candidate.patch } : {}),
		...(candidate.metadata ? { metadata: candidate.metadata } : {}),
	};
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
