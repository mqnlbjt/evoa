import type { SuiteRunResult } from "../benchmark/types.js";
import type { AgentSpec } from "../specs.js";

export type CandidateKind = "prompt" | "tool" | "runtime";

export interface EvolutionCandidate {
	id: string;
	kind: CandidateKind;
	parentAgentId: string;
	agent: AgentSpec;
	description: string;
	patch?: string;
	metadata?: Record<string, unknown>;
}

export interface EvolutionComparison {
	baseline: SuiteRunResult;
	candidate: SuiteRunResult;
	deltaScore: number;
	deltaPassRate: number;
	regressions: string[];
	improvements: string[];
	recommendation: "accept" | "reject" | "needs-review";
	metadata?: Record<string, unknown>;
}

export interface CandidateGenerator {
	generate(parent: AgentSpec): Promise<EvolutionCandidate[]>;
}
