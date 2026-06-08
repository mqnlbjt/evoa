import { createHostBashExecutor, type BashExecutor } from "../../tools/bash-executor.js";
import type { AgentSpec, TaskSpec } from "../../specs.js";
import type { ScoreResult, TaskExecutionOutput, TaskGrader } from "../types.js";
import type { CommandScoringConfig, GraderContext } from "./types.js";

export class CommandGrader implements TaskGrader {
	private readonly bashExecutor: BashExecutor;

	constructor(private readonly context: GraderContext, bashExecutor?: BashExecutor) {
		this.bashExecutor = bashExecutor ?? createHostBashExecutor();
	}

	async grade(_agent: AgentSpec, task: TaskSpec, _output: TaskExecutionOutput): Promise<ScoreResult> {
		const config = (task.scoring.config ?? {}) as unknown as CommandScoringConfig;
		if (typeof config.command !== "string" || config.command.trim().length === 0) {
			return { score: 0, maxScore: maxScore(task), passed: false, reason: "command grader requires config.command string" };
		}
		const workDir = this.context.workspaceDir ?? process.cwd();
		const timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 30_000;

		try {
			const result = await this.bashExecutor.execute({
				command: config.command,
				cwd: workDir,
				workspaceRoot: workDir,
				timeoutMs,
				maxOutputBytes: 256 * 1024,
			});

			const checks: Record<string, boolean> = {};
			checks.exitCode = result.exitCode === (config.exitCode ?? 0);

			if (config.stdoutContains) {
				checks.stdoutContains = config.stdoutContains.every(s => result.stdout.includes(s));
			}
			if (config.stdoutExact) {
				checks.stdoutExact = result.stdout.trim() === config.stdoutExact;
			}
			if (config.stderrContains) {
				checks.stderrContains = config.stderrContains.every(s => result.stderr.includes(s));
			}

			const checkEntries = Object.entries(checks);
			const passedCount = checkEntries.filter(([, v]) => v).length;
			const passed = passedCount === checkEntries.length;
			const max = maxScore(task);
			const score = checkEntries.length > 0
				? Math.round((passedCount / checkEntries.length) * max * 100) / 100
				: (passed ? max : 0);

			return {
				score,
				maxScore: max,
				passed,
				reason: passed ? "all command checks passed" : formatFailedChecks(checks, result),
				details: { checks, exitCode: result.exitCode, stdout: truncate(result.stdout, 2000), stderr: truncate(result.stderr, 2000), timedOut: result.timedOut },
			};
		} catch (error) {
			return {
				score: 0, maxScore: maxScore(task), passed: false,
				reason: `command execution error: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
}

function formatFailedChecks(checks: Record<string, boolean>, result: { exitCode: number | null; stdout: string; stderr: string }): string {
	const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
	const exitInfo = checks.exitCode === false ? ` (exit code ${result.exitCode})` : "";
	return `failed checks: ${failed.join(", ")}${exitInfo}`;
}

function truncate(value: string, maxLen: number): string {
	return value.length <= maxLen ? value : value.slice(0, maxLen) + "...";
}

function maxScore(task: TaskSpec): number {
	return task.scoring.maxScore ?? 1;
}
