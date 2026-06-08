import { tmpdir } from "node:os";
import type { AgentSpec, TaskSpec } from "../specs.js";
import type { RunStore } from "../sessions/run-store.js";
import type { TraceEvent } from "../runtime/events.js";
import { abortMessage, abortReason, isAbortError, isRuntimeTimeoutError } from "../runtime/timeout.js";
import type { FixtureManager } from "./fixture.js";
import type { GraderContext } from "./graders/types.js";
import type {
	AgentRuntimeExecutor,
	AgentTaskRunResult,
	BenchmarkSuite,
	BenchmarkSummary,
	BenchmarkTypeSummary,
	ScoreResult,
	SuiteRunResult,
	TaskExecutionOutput,
	TaskGrader,
} from "./types.js";

export interface BenchmarkRunnerOptions {
	runtime: AgentRuntimeExecutor;
	grader: TaskGrader;
	store?: RunStore;
	now?: () => number;
	createId?: () => string;
	fixtureManager?: FixtureManager;
	workspaceBaseDir?: string;
	parallelism?: number;
	retries?: number;
	retryOn?: Array<"errored" | "timeout">;
	graderContext?: GraderContext;
}

export class BenchmarkRunner {
	private readonly runtime: AgentRuntimeExecutor;
	private readonly grader: TaskGrader;
	private readonly store: RunStore | undefined;
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly fixtureManager: FixtureManager | undefined;
	private readonly workspaceBaseDir: string;
	private readonly graderContext: GraderContext | undefined;

	constructor(options: BenchmarkRunnerOptions) {
		this.runtime = options.runtime;
		this.grader = options.grader;
		this.store = options.store;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? (() => crypto.randomUUID());
		this.fixtureManager = options.fixtureManager;
		this.workspaceBaseDir = options.workspaceBaseDir ?? tmpdir();
		this.graderContext = options.graderContext;
	}

	async runSuite(agent: AgentSpec, suite: BenchmarkSuite, signal?: AbortSignal): Promise<SuiteRunResult> {
		const runs: AgentTaskRunResult[] = [];
		let workspaceDir: string | undefined;
		try {
			for (const task of suite.tasks) {
				if (this.fixtureManager) {
					workspaceDir = await this.fixtureManager.setup(task, this.workspaceBaseDir);
				}
				const context = buildGraderContext(this.graderContext, workspaceDir);
				const run = await this.runTaskWithoutClosing(agent, task, signal, false, context);
				runs.push(run);
				if (workspaceDir && this.fixtureManager) {
					await this.fixtureManager.teardown(workspaceDir);
				}
			}
			const result: SuiteRunResult = {
				agent,
				suite,
				runs,
				summary: summarizeRuns(runs),
			};
			await this.store?.saveSuiteRun(result);
			return result;
		} finally {
			if (workspaceDir && this.fixtureManager) {
				await this.fixtureManager.cleanup(workspaceDir);
			}
			await this.runtime.close?.();
		}
	}

	async runTask(agent: AgentSpec, task: TaskSpec, signal?: AbortSignal): Promise<AgentTaskRunResult> {
		let workspaceDir: string | undefined;
		if (this.fixtureManager) {
			workspaceDir = await this.fixtureManager.setup(task, this.workspaceBaseDir);
		}
		const context = buildGraderContext(this.graderContext, workspaceDir);
		return this.runTaskWithoutClosing(agent, task, signal, true, context);
	}

	private async runTaskWithoutClosing(
		agent: AgentSpec,
		task: TaskSpec,
		signal: AbortSignal | undefined,
		closeRuntime: boolean,
		graderCtx?: GraderContext,
	): Promise<AgentTaskRunResult> {
		const runId = this.createId();
		const startedAt = this.now();
		const trace: TraceEvent[] = [this.event("run_start", agent, task, { agent, task })];

		let output: TaskExecutionOutput = {};
		let score: ScoreResult;
		let status: AgentTaskRunResult["status"] = "errored";
		let errorMessage: string | undefined;

		try {
			output = await this.runtime.runTask(agent, task, signal);
			trace.push(...(output.trace ?? []));
			if (graderCtx) {
				const augmentedOutput = { ...output };
				if (this.graderContext?.artifacts) {
					augmentedOutput.artifacts = { ...this.graderContext.artifacts, ...(output.artifacts ?? {}) };
				}
				score = await this.grader.grade(agent, task, augmentedOutput);
			} else {
				score = await this.grader.grade(agent, task, output);
			}
			status = score.passed ? "passed" : "failed";
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
			status = runErrorStatus(error, errorMessage, signal);
			score = {
				score: 0,
				maxScore: task.scoring.maxScore ?? 1,
				passed: false,
				reason: errorMessage,
			};
			if (status === "interrupted") trace.push(this.event("interrupted", agent, task, { reason: abortReason(signal), message: abortMessage(error, signal) }));
			else trace.push(this.event("error", agent, task, { message: errorMessage }));
		}

		const endedAt = this.now();
		trace.push(this.event("score", agent, task, score));
		trace.push(this.event("run_end", agent, task, { status, durationMs: endedAt - startedAt }));

		const result: AgentTaskRunResult = {
			runId,
			agent,
			task,
			status,
			score,
			startedAt,
			endedAt,
			durationMs: endedAt - startedAt,
			trace,
			...(output.artifacts ? { artifacts: output.artifacts } : {}),
			...(errorMessage ? { errorMessage } : {}),
		};
		try {
			await this.store?.saveTaskRun(result);
			return result;
		} finally {
			if (closeRuntime) await this.runtime.close?.();
		}
	}

	private event(type: TraceEvent["type"], agent: AgentSpec, task: TaskSpec, payload: unknown): TraceEvent {
		return {
			id: this.createId(),
			type,
			timestamp: this.now(),
			agentId: agent.id,
			taskId: task.id,
			payload,
		} as TraceEvent;
	}
}

function runErrorStatus(error: unknown, errorMessage: string, signal?: AbortSignal): AgentTaskRunResult["status"] {
	if (isRuntimeTimeoutError(error) || errorMessage.toLowerCase().includes("timeout")) return "timeout";
	if (isAbortError(error, signal)) return "interrupted";
	return "errored";
}

export function summarizeRuns(runs: AgentTaskRunResult[]): BenchmarkSummary {
	const maxScore = runs.reduce((sum, run) => sum + run.score.maxScore, 0);
	const totalScore = runs.reduce((sum, run) => sum + run.score.score, 0);
	const passedTasks = runs.filter((run) => run.status === "passed").length;
	const failedTasks = runs.filter((run) => run.status === "failed").length;
	const erroredTasks = runs.filter((run) => run.status === "errored").length;
	const timeoutTasks = runs.filter((run) => run.status === "timeout").length;
	const interruptedTasks = runs.filter((run) => run.status === "interrupted").length;
	const byTaskType: BenchmarkSummary["byTaskType"] = {};

	for (const run of runs) {
		const type = run.task.type;
		const current = byTaskType[type] ?? createEmptyTypeSummary();
		current.totalTasks += 1;
		current.passedTasks += run.status === "passed" ? 1 : 0;
		current.totalScore += run.score.score;
		current.maxScore += run.score.maxScore;
		current.passRate = current.passedTasks / current.totalTasks;
		byTaskType[type] = current;
	}

	return {
		totalTasks: runs.length,
		passedTasks,
		failedTasks,
		erroredTasks,
		timeoutTasks,
		interruptedTasks,
		passRate: runs.length === 0 ? 0 : passedTasks / runs.length,
		totalScore,
		maxScore,
		averageScore: runs.length === 0 ? 0 : totalScore / runs.length,
		totalDurationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
		byTaskType,
	};
}

function createEmptyTypeSummary(): BenchmarkTypeSummary {
	return {
		totalTasks: 0,
		passedTasks: 0,
		passRate: 0,
		totalScore: 0,
		maxScore: 0,
	};
}

function buildGraderContext(base: GraderContext | undefined, workspaceDir: string | undefined): GraderContext | undefined {
	if (!base && !workspaceDir) return undefined;
	const ctx: GraderContext = {};
	if (base?.modelClient) ctx.modelClient = base.modelClient;
	if (base?.modelRouter) ctx.modelRouter = base.modelRouter;
	if (base?.artifacts) ctx.artifacts = base.artifacts;
	if (workspaceDir) ctx.workspaceDir = workspaceDir;
	else if (base?.workspaceDir) ctx.workspaceDir = base.workspaceDir;
	return ctx;
}
