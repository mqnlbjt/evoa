import type { AgentSpec, TaskSpec, TaskType } from "../specs.js";
import type { TraceEvent } from "../runtime/events.js";

export interface ScoreResult {
	score: number;
	maxScore: number;
	passed: boolean;
	reason: string;
	details?: Record<string, unknown>;
}

export interface AgentTaskRunResult {
	runId: string;
	agent: AgentSpec;
	task: TaskSpec;
	status: "passed" | "failed" | "errored" | "timeout";
	score: ScoreResult;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	trace: TraceEvent[];
	artifacts?: Record<string, string>;
	errorMessage?: string;
}

export interface BenchmarkSuite {
	id: string;
	name: string;
	description?: string;
	tasks: TaskSpec[];
	metadata?: Record<string, unknown>;
}

export interface SuiteRunResult {
	suite: BenchmarkSuite;
	agent: AgentSpec;
	runs: AgentTaskRunResult[];
	summary: BenchmarkSummary;
}

export interface BenchmarkSummary {
	totalTasks: number;
	passedTasks: number;
	failedTasks: number;
	erroredTasks: number;
	timeoutTasks: number;
	passRate: number;
	totalScore: number;
	maxScore: number;
	averageScore: number;
	totalDurationMs: number;
	byTaskType: Partial<Record<TaskType, BenchmarkTypeSummary>>;
}

export interface BenchmarkTypeSummary {
	totalTasks: number;
	passedTasks: number;
	passRate: number;
	totalScore: number;
	maxScore: number;
}

export interface TaskExecutionOutput {
	answer?: string;
	artifacts?: Record<string, string>;
	trace?: TraceEvent[];
}

export interface AgentRuntimeExecutor {
	runTask(agent: AgentSpec, task: TaskSpec, signal?: AbortSignal): Promise<TaskExecutionOutput>;
}

export interface TaskGrader {
	grade(agent: AgentSpec, task: TaskSpec, output: TaskExecutionOutput): Promise<ScoreResult>;
}
