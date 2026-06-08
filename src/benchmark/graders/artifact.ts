import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentSpec, TaskSpec } from "../../specs.js";
import type { ScoreResult, TaskGrader } from "../types.js";
import type { ArtifactScoringConfig, GraderContext } from "./types.js";

export class ArtifactGrader implements TaskGrader {
	constructor(private readonly context: GraderContext) {}

	async grade(_agent: AgentSpec, task: TaskSpec, _output: { answer?: string }): Promise<ScoreResult> {
		const config = (task.scoring.config ?? {}) as unknown as ArtifactScoringConfig;
		if (typeof config.path !== "string" || config.path.trim().length === 0) {
			return { score: 0, maxScore: maxScore(task), passed: false, reason: "artifact grader requires config.path string" };
		}
		const workDir = this.context.workspaceDir ?? process.cwd();
		const filePath = path.resolve(workDir, config.path);

		const checks: Record<string, boolean> = {};
		let content: string | undefined;

		const exists = existsSync(filePath);
		if (config.exists !== undefined) checks.exists = exists === config.exists;

		if (exists && (config.contains || config.exactMatch || config.regex || config.maxLines !== undefined || config.minHeightLines !== undefined)) {
			try {
				content = readFileSync(filePath, "utf-8");
			} catch {
				return { score: 0, maxScore: maxScore(task), passed: false, reason: `artifact grader: cannot read file ${config.path}` };
			}
		}

		if (config.contains && content !== undefined) {
			checks.contains = config.contains.every(s => content!.includes(s));
		}
		if (config.exactMatch !== undefined && content !== undefined) {
			checks.exactMatch = content.trim() === config.exactMatch;
		}
		if (config.regex && content !== undefined) {
			try {
				checks.regex = new RegExp(config.regex, "s").test(content);
			} catch {
				return { score: 0, maxScore: maxScore(task), passed: false, reason: `artifact grader: invalid regex ${config.regex}` };
			}
		}
		if (config.maxLines !== undefined && content !== undefined) {
			const lines = content.split("\n").length;
			checks.maxLines = lines <= config.maxLines;
		}
		if (config.minHeightLines !== undefined && content !== undefined) {
			const lines = content.split("\n").length;
			checks.minHeightLines = lines >= config.minHeightLines;
		}

		const checkEntries = Object.entries(checks);
		if (checkEntries.length === 0) {
			return { score: 0, maxScore: maxScore(task), passed: false, reason: "artifact grader: no checks specified" };
		}

		const passedCount = checkEntries.filter(([, v]) => v).length;
		const passed = passedCount === checkEntries.length;
		const max = maxScore(task);
		const score = Math.round((passedCount / checkEntries.length) * max * 100) / 100;

		return {
			score,
			maxScore: max,
			passed,
			reason: passed ? "all artifact checks passed" : `failed artifact checks: ${checkEntries.filter(([, v]) => !v).map(([k]) => k).join(", ")}`,
			details: { checks, filePath, exists },
		};
	}
}

function maxScore(task: TaskSpec): number {
	return task.scoring.maxScore ?? 1;
}
