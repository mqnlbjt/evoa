import type { ModelClient } from "../../models/types.js";
import type { ModelRouter } from "../../models/router.js";
import type { RubricCriterion } from "../types.js";

export interface ExactScoringConfig {
	expected: string;
	trim?: boolean;
	caseSensitive?: boolean;
	normalizeWhitespace?: boolean;
}

export interface RubricScoringConfig {
	contains?: string[];
	criteria?: RubricCriterion[];
	passThreshold?: number;
}

export interface LlmJudgeScoringConfig {
	criteria: string;
	instructions?: string;
	passThreshold?: number;
	modelAlias?: string;
	rubric?: RubricCriterion[];
	maxRetries?: number;
}

export interface CommandScoringConfig {
	command: string;
	exitCode?: number;
	stdoutContains?: string[];
	stdoutExact?: string;
	stderrContains?: string[];
	timeoutMs?: number;
}

export interface ArtifactScoringConfig {
	path: string;
	exists?: boolean;
	contains?: string[];
	exactMatch?: string;
	regex?: string;
	maxLines?: number;
	minHeightLines?: number;
}

export interface CustomScoringConfig {
	subscores: CustomSubscore[];
	passThreshold?: number;
}

export interface CustomSubscore {
	method: string;
	weight: number;
	config: Record<string, unknown>;
}

export interface GraderContext {
	workspaceDir?: string;
	modelClient?: ModelClient;
	modelRouter?: ModelRouter;
	artifacts?: Record<string, string>;
}
