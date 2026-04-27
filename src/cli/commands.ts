import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadAgentSpecFromFile } from "../agents/loader.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { BenchmarkRunner } from "../benchmark/runner.js";
import { loadBenchmarkSuiteFromFile } from "../benchmark/loader.js";
import { MinimalTaskGrader } from "../benchmark/grader.js";
import { createBenchmarkReport, formatBenchmarkReportMarkdown } from "../benchmark/report.js";
import type { AgentTaskRunResult, SuiteRunResult } from "../benchmark/types.js";
import { ModelRegistry, type ModelRegistryOptions } from "../models/registry.js";
import { loadTaskSpecFromFile } from "../tasks/loader.js";
import type { AgentSpec } from "../specs.js";
import type { BenchmarkCommand, ModelsDiscoverCommand, RunCommand } from "./args.js";
import { formatPercent, formatTable } from "./format.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createToolRegistryForProfile } from "../tools/profiles.js";

export interface CliDeps {
	stdout?: Pick<NodeJS.WriteStream, "write">;
	stderr?: Pick<NodeJS.WriteStream, "write">;
	fetchFn?: typeof fetch;
	openAIClientFactory?: ModelRegistryOptions["openAIClientFactory"];
	toolRegistry?: ToolRegistry;
	workspaceRoot?: string;
	now?: () => number;
	createId?: () => string;
}

export interface CliResult {
	exitCode: number;
	human?: string;
	json?: unknown;
	trace?: unknown;
	files?: Array<{ path: string; content: string }>;
}

export async function handleModelsDiscover(command: ModelsDiscoverCommand, deps: CliDeps): Promise<CliResult> {
	const registry = createRegistry(command, deps);
	const models = (await registry.discover(command.provider)).sort((left, right) => left.id.localeCompare(right.id));
	const json = { ok: true, command: command.kind, provider: command.provider, models };
	return {
		exitCode: 0,
		json,
		human: [`Discovered ${models.length} model(s) for provider ${command.provider}`, "", formatTable([["MODEL", "PROVIDER", "FORMAT"], ...models.map((model) => [model.id, model.providerId, model.format])])].join("\n"),
	};
}

export async function handleRun(command: RunCommand, deps: CliDeps): Promise<CliResult> {
	const agent = await loadAgentSpecFromFile(command.agentPath);
	const task = await loadTaskSpecFromFile(command.taskPath);
	const result = await createRunner(command, deps).runTask(effectiveAgent(agent, command.provider, command.model), task);
	const json = runJson(command.kind, result);
	return {
		exitCode: result.status === "errored" || result.status === "timeout" ? 1 : 0,
		json,
		trace: result,
		human: formatRunHuman(result),
	};
}

export async function handleBenchmark(command: BenchmarkCommand, deps: CliDeps): Promise<CliResult> {
	const agent = await loadAgentSpecFromFile(command.agentPath);
	const suite = await loadBenchmarkSuiteFromFile(command.suitePath);
	const result = await createRunner(command, deps).runSuite(effectiveAgent(agent, command.provider, command.model), suite);
	const json = benchmarkJson(result);
	const report = command.reportPath ? createBenchmarkReport(result) : undefined;
	return {
		exitCode: result.runs.some((run) => run.status === "errored" || run.status === "timeout") ? 1 : 0,
		json,
		trace: result,
		human: formatBenchmarkHuman(result),
		...(command.reportPath && report ? { files: [{ path: command.reportPath, content: command.reportFormat === "markdown" ? formatBenchmarkReportMarkdown(report) : `${JSON.stringify(report, null, 2)}\n` }] } : {}),
	};
}

export async function writeOptionalFiles(command: { outputPath?: string; tracePath?: string }, result: CliResult): Promise<void> {
	if (command.outputPath) await writeJsonFile(command.outputPath, result.json);
	if (command.tracePath) await writeJsonFile(command.tracePath, result.trace ?? result.json);
	for (const file of result.files ?? []) {
		await writeTextFile(file.path, file.content);
	}
}

function createRunner(command: RunCommand | BenchmarkCommand, deps: CliDeps): BenchmarkRunner {
	const registry = createRegistry(command, deps);
	registry.registerModel(command.provider, {
		id: command.model,
		providerId: command.provider,
		format: command.providerFormat,
	});
	return new BenchmarkRunner({
		runtime: new AgentRuntime({
			modelClient: registry.createClient(command.provider, command.model),
			toolRegistry: deps.toolRegistry ?? createToolRegistryForProfile({ profile: command.toolProfile, workspaceRoot: deps.workspaceRoot ?? process.cwd() }),
		}),
		grader: new MinimalTaskGrader(),
		...(deps.now ? { now: deps.now } : {}),
		...(deps.createId ? { createId: deps.createId } : {}),
	});
}

function createRegistry(command: ModelsDiscoverCommand | RunCommand | BenchmarkCommand, deps: CliDeps): ModelRegistry {
	const registry = new ModelRegistry({
		...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
		...(deps.openAIClientFactory ? { openAIClientFactory: deps.openAIClientFactory } : {}),
	});
	registry.registerProvider({
		id: command.provider,
		baseURL: command.baseURL,
		format: command.providerFormat,
		...(command.apiKey ? { apiKey: command.apiKey } : {}),
	});
	return registry;
}

function effectiveAgent(agent: AgentSpec, provider: string, model: string): AgentSpec {
	return {
		...agent,
		model: {
			...agent.model,
			provider,
			model,
		},
	};
}

function runJson(command: "run", result: AgentTaskRunResult): unknown {
	return {
		ok: result.status !== "errored" && result.status !== "timeout",
		command,
		agentId: result.agent.id,
		taskId: result.task.id,
		status: result.status,
		score: result.score,
		runId: result.runId,
		durationMs: result.durationMs,
		...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
	};
}

function benchmarkJson(result: SuiteRunResult): unknown {
	return {
		ok: !result.runs.some((run) => run.status === "errored" || run.status === "timeout"),
		command: "benchmark",
		agentId: result.agent.id,
		suiteId: result.suite.id,
		summary: result.summary,
		runs: result.runs.map((run) => ({
			runId: run.runId,
			taskId: run.task.id,
			status: run.status,
			score: run.score,
			durationMs: run.durationMs,
			...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
		})),
	};
}

function formatRunHuman(result: AgentTaskRunResult): string {
	return [
		`Task ${result.task.id} completed: ${result.status}`,
		`Score: ${result.score.score}/${result.score.maxScore}`,
		`Reason: ${result.score.reason}`,
	].join("\n");
}

function formatBenchmarkHuman(result: SuiteRunResult): string {
	const rows = [["TASK", "STATUS", "SCORE"], ...result.runs.map((run) => [run.task.id, run.status, `${run.score.score}/${run.score.maxScore}`])];
	return [
		`Suite ${result.suite.id} completed for agent ${result.agent.id}`,
		`Tasks: ${result.summary.passedTasks} passed, ${result.summary.failedTasks} failed, ${result.summary.erroredTasks} errored, ${result.summary.timeoutTasks} timeout`,
		`Pass rate: ${formatPercent(result.summary.passRate)}`,
		`Score: ${result.summary.totalScore}/${result.summary.maxScore}`,
		"",
		formatTable(rows),
	].join("\n");
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf-8");
}
