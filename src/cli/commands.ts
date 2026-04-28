import { mkdir, readFile, writeFile } from "node:fs/promises";
import path, { dirname } from "node:path";
import { createInterface } from "node:readline";
import { loadAgentDefinitionsFromFile } from "../agents/loader.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { BenchmarkRunner } from "../benchmark/runner.js";
import { loadBenchmarkSuiteFromFile } from "../benchmark/loader.js";
import { MinimalTaskGrader } from "../benchmark/grader.js";
import { createBenchmarkReport, formatBenchmarkReportMarkdown } from "../benchmark/report.js";
import { BenchmarkEvolutionEngine } from "../evolution/engine.js";
import { JsonlEvolutionHistoryStore } from "../evolution/history-store.js";
import { createEvolutionReport, formatEvolutionReportMarkdown } from "../evolution/report.js";
import type { EvolutionCandidate } from "../evolution/types.js";
import { verifyEvolutionComparison } from "../verification/verifier.js";
import type { AgentTaskRunResult, SuiteRunResult } from "../benchmark/types.js";
import { ModelRegistry, type ModelRegistryOptions } from "../models/registry.js";
import { loadTaskSpecFromFile } from "../tasks/loader.js";
import type { AgentSpec, SubagentSpec, TaskSpec } from "../specs.js";
import type { ChatCommand, BenchmarkCommand, DiffCommand, EvolveCommand, ModelsDiscoverCommand, ReplayCommand, RunCommand } from "./args.js";
import { formatPercent, formatTable } from "./format.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createToolRegistryForProfile } from "../tools/profiles.js";
import { replayTraceSource } from "../replay/trace-replay.js";
import { createAgentSession, appendUserMessage } from "../runtime/session.js";
import type { ModelMessage } from "../models/types.js";
import { JsonSessionStore } from "../sessions/json-session-store.js";
import type { AgentSessionStore, StoredAgentSession, StoredAgentStartupContext } from "../sessions/session-store.js";
import { diffRunSources } from "../replay/run-diff.js";

export interface CliDeps {
	stdout?: Pick<NodeJS.WriteStream, "write">;
	stderr?: Pick<NodeJS.WriteStream, "write">;
	inputLines?: AsyncIterable<string>;
	fetchFn?: typeof fetch;
	openAIClientFactory?: ModelRegistryOptions["openAIClientFactory"];
	toolRegistry?: ToolRegistry;
	createEvolutionHistoryStore?: (path: string) => Pick<JsonlEvolutionHistoryStore, "saveComparison">;
	sessionStore?: AgentSessionStore;
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

export async function handleChat(command: ChatCommand, deps: CliDeps): Promise<CliResult> {
	if (!command.prompt) return handleChatRepl(command, deps);
	const context = await createChatContext(command, deps);
	const output = await runChatTurn(context, command.prompt);
	return {
		exitCode: 0,
		json: { ok: true, command: command.kind, agentId: context.agent.id, answer: output.answer, sessionId: context.sessionId },
		trace: { sessionId: context.sessionId, answer: output.answer, trace: output.trace },
		human: output.answer,
	};
}

export async function handleRun(command: RunCommand, deps: CliDeps): Promise<CliResult> {
	const bundle = await loadAgentBundle(command.agentPath);
	const agent = effectiveAgent(bundle.agent, command.provider, command.model);
	const task = await loadTaskSpecFromFile(command.taskPath);
	const result = await createRunner(command, deps, bundle.subagents).runTask(agent, task);
	const json = runJson(command.kind, result);
	return {
		exitCode: result.status === "errored" || result.status === "timeout" ? 1 : 0,
		json,
		trace: result,
		human: formatRunHuman(result),
	};
}

export async function handleBenchmark(command: BenchmarkCommand, deps: CliDeps): Promise<CliResult> {
	const bundle = await loadAgentBundle(command.agentPath);
	const agent = effectiveAgent(bundle.agent, command.provider, command.model);
	const suite = await loadBenchmarkSuiteFromFile(command.suitePath);
	const result = await createRunner(command, deps, bundle.subagents).runSuite(agent, suite);
	const json = benchmarkJson(result);
	const report = command.reportPath ? createBenchmarkReport(result) : undefined;
	return {
		exitCode: result.runs.every((run) => run.status === "passed") ? 0 : 1,
		json,
		trace: result,
		human: formatBenchmarkHuman(result),
		...(command.reportPath && report ? { files: [{ path: command.reportPath, content: command.reportFormat === "markdown" ? formatBenchmarkReportMarkdown(report) : `${JSON.stringify(report, null, 2)}\n` }] } : {}),
	};
}

export async function handleReplay(command: ReplayCommand, _deps: CliDeps): Promise<CliResult> {
	const source = await readJsonFile(command.tracePath);
	const runs = replayTraceSource(source, { ...(command.runId ? { runId: command.runId } : {}) });
	const json = { ok: runs.length > 0 && runs.every((run) => run.warnings.length === 0), command: command.kind, runs };
	return {
		exitCode: runs.length === 0 ? 1 : 0,
		json,
		human: formatReplayHuman(runs),
	};
}

export async function handleDiff(command: DiffCommand, _deps: CliDeps): Promise<CliResult> {
	const left = await readJsonFile(command.leftPath);
	const right = await readJsonFile(command.rightPath);
	const diff = diffRunSources(left, right);
	return {
		exitCode: 0,
		json: { ok: true, command: command.kind, diff },
		human: formatDiffHuman(diff),
	};
}

export async function handleEvolve(command: EvolveCommand, deps: CliDeps): Promise<CliResult> {
	const baselineBundle = await loadAgentBundle(command.baselineAgentPath);
	const candidateBundle = await loadAgentBundle(command.candidateAgentPath);
	const baselineAgent = effectiveAgent(baselineBundle.agent, command.provider, command.model);
	const candidateAgent = effectiveAgent(candidateBundle.agent, command.provider, command.model);
	const suite = await loadBenchmarkSuiteFromFile(command.suitePath);
	const candidate: EvolutionCandidate = {
		id: candidateAgent.id,
		kind: "prompt",
		parentAgentId: baselineAgent.id,
		agent: candidateAgent,
		description: `Compare ${candidateAgent.id} against ${baselineAgent.id}`,
	};
	const engine = new BenchmarkEvolutionEngine({
		baseline: baselineAgent,
		suite,
		generator: { async generate() { return [candidate]; } },
		createRunner: (agent) => createRunner(command, deps, agent.id === candidateAgent.id ? candidateBundle.subagents : baselineBundle.subagents),
	});
	const comparison = await engine.compare(candidate);
	const verification = verifyEvolutionComparison(comparison.baseline, comparison.candidate);
	const report = createEvolutionReport(comparison, { candidate, verification });
	if (command.historyPath) {
		const store = deps.createEvolutionHistoryStore?.(command.historyPath) ?? new JsonlEvolutionHistoryStore(command.historyPath);
		await store.saveComparison(comparison, candidate);
	}
	return {
		exitCode: comparison.recommendation === "reject" || verification.blocking ? 1 : 0,
		json: evolutionJson(comparison, verification),
		trace: comparison,
		human: formatEvolutionHuman(comparison, verification),
		...(command.reportPath ? { files: [{ path: command.reportPath, content: command.reportFormat === "markdown" ? formatEvolutionReportMarkdown(report) : `${JSON.stringify(report, null, 2)}\n` }] } : {}),
	};
}

export async function writeOptionalFiles(command: { outputPath?: string; tracePath?: string }, result: CliResult): Promise<void> {
	if (command.outputPath) await writeJsonFile(command.outputPath, result.json);
	if (command.tracePath) await writeJsonFile(command.tracePath, result.trace ?? result.json);
	for (const file of result.files ?? []) {
		await writeTextFile(file.path, file.content);
	}
}

type ResolvedChatCommand = ChatCommand & StoredAgentStartupContext;

interface ChatContext {
	command: ResolvedChatCommand;
	agent: AgentSpec;
	runtime: AgentRuntime;
	sessionStore: AgentSessionStore;
	stored: StoredAgentSession | undefined;
	sessionId: string;
	messages: ModelMessage[];
	now: () => number;
}

async function handleChatRepl(command: ChatCommand, deps: CliDeps): Promise<CliResult> {
	const context = await createChatContext(command, deps);
	const stdout = deps.stdout ?? process.stdout;
	const { inputLines, close } = createChatInput(deps);
	try {
		stdout.write("> ");
		for await (const line of inputLines) {
			const input = line.trim();
			if (input === "/exit" || input === "/quit") break;
			if (input) {
				const output = await runChatTurn(context, input);
				stdout.write(`${output.answer}\n`);
			}
			stdout.write("> ");
		}
	} finally {
		close?.();
	}
	return {
		exitCode: 0,
		json: { ok: true, command: command.kind, agentId: context.agent.id, sessionId: context.sessionId, mode: "repl" },
		human: "",
	};
}

async function createChatContext(command: ChatCommand, deps: CliDeps): Promise<ChatContext> {
	const sessionStore = chatSessionStore(command, deps);
	const stored = command.resumeSessionId || command.sessionId ? await sessionStore.loadSession((command.resumeSessionId ?? command.sessionId)!) : undefined;
	if (command.resumeSessionId && !stored) throw new Error(`session ${command.resumeSessionId} not found`);
	const resolvedCommand = resolveChatCommand(command, stored);
	const bundle = await loadAgentBundle(resolvedCommand.agentPath);
	const agent = effectiveAgent(bundle.agent, resolvedCommand.provider, resolvedCommand.model);
	const runtime = createRuntime(resolvedCommand, deps, bundle.subagents);
	const sessionId = resolvedCommand.resumeSessionId ?? resolvedCommand.sessionId ?? (deps.createId?.() ?? crypto.randomUUID());
	return {
		command: resolvedCommand,
		agent,
		runtime,
		sessionStore,
		stored,
		sessionId,
		messages: stored?.messages ?? [{ role: "system", content: agent.prompts.system }],
		now: deps.now ?? Date.now,
	};
}

async function runChatTurn(context: ChatContext, prompt: string): Promise<{ answer: string; trace: NonNullable<Awaited<ReturnType<AgentRuntime["runSession"]>>["trace"]> }> {
	const session = createAgentSession({ id: context.sessionId, agent: context.agent, task: chatTask(context.command, prompt), messages: context.messages });
	appendUserMessage(session, prompt);
	const output = await context.runtime.runSession(session);
	context.messages = session.messages;
	if (context.command.resumeSessionId || context.command.sessionId) {
		const stored = storedSession(context.sessionId, context.agent, context.command, session.messages, context.stored, context.now());
		await context.sessionStore.saveSession(stored);
		context.stored = stored;
	}
	return { answer: output.answer ?? "", trace: output.trace ?? [] };
}

function resolveChatCommand(command: ChatCommand, stored: StoredAgentSession | undefined): ResolvedChatCommand {
	const sessionDir = resolveOptionalChatString(command, stored, "sessionDir");
	return {
		...command,
		agentPath: resolveRequiredChatString(command, stored, "agentPath", "--agent"),
		provider: resolveRequiredChatString(command, stored, "provider", "--provider"),
		model: resolveRequiredChatString(command, stored, "model", "--model"),
		baseURL: resolveRequiredChatString(command, stored, "baseURL", "--base-url"),
		providerFormat: resolveProviderFormat(command, stored),
		toolProfile: resolveToolProfile(command, stored),
		...(sessionDir ? { sessionDir } : {}),
	};
}

function resolveRequiredChatString(command: ChatCommand, stored: StoredAgentSession | undefined, key: "agentPath" | "provider" | "model" | "baseURL", flag: string): string {
	const value = resolveOptionalChatString(command, stored, key);
	if (value) return value;
	if (command.resumeSessionId && stored && !stored.startupContext) {
		throw new Error(`session ${command.resumeSessionId} does not include startup context; provide --agent --provider --model --base-url once to upgrade it`);
	}
	throw new Error(`missing required option ${flag}`);
}

function resolveOptionalChatString(command: ChatCommand, stored: StoredAgentSession | undefined, key: "agentPath" | "provider" | "model" | "baseURL" | "sessionDir"): string | undefined {
	const commandValue = command[key];
	if (command.providedFlags[key] && commandValue) return commandValue;
	const storedValue = stored?.startupContext?.[key];
	if (storedValue) return storedValue;
	return commandValue;
}

function resolveProviderFormat(command: ChatCommand, stored: StoredAgentSession | undefined): ResolvedChatCommand["providerFormat"] {
	if (command.providedFlags.providerFormat) return command.providerFormat;
	return stored?.startupContext?.providerFormat ?? command.providerFormat;
}

function resolveToolProfile(command: ChatCommand, stored: StoredAgentSession | undefined): ResolvedChatCommand["toolProfile"] {
	if (command.providedFlags.toolProfile) return command.toolProfile;
	return stored?.startupContext?.toolProfile ?? command.toolProfile;
}

function createChatInput(deps: CliDeps): { inputLines: AsyncIterable<string>; close?: () => void } {
	if (deps.inputLines) return { inputLines: deps.inputLines };
	const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	return { inputLines: input, close: () => input.close() };
}

function createRunner(command: RunCommand | BenchmarkCommand | EvolveCommand, deps: CliDeps, subagents: SubagentSpec[] = []): BenchmarkRunner {
	return new BenchmarkRunner({
		runtime: createRuntime(command, deps, subagents),
		grader: new MinimalTaskGrader(),
		...(deps.now ? { now: deps.now } : {}),
		...(deps.createId ? { createId: deps.createId } : {}),
	});
}

function createRuntime(command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: CliDeps, subagents: SubagentSpec[] = []): AgentRuntime {
	const registry = createRegistry(command, deps);
	registry.registerModel(command.provider, {
		id: command.model,
		providerId: command.provider,
		format: command.providerFormat,
	});
	const createToolRegistryForAgent = () => deps.toolRegistry ?? createToolRegistryForProfile({ profile: command.toolProfile, workspaceRoot: deps.workspaceRoot ?? process.cwd() });
	return new AgentRuntime({
		modelClient: registry.createClient(command.provider, command.model),
		toolRegistry: createToolRegistryForAgent(),
		createToolRegistryForAgent,
		...(subagents.length > 0 ? { subagents } : {}),
		...(deps.now ? { now: deps.now } : {}),
		...(deps.createId ? { createId: deps.createId } : {}),
	});
}

async function loadAgentBundle(agentPath: string): Promise<{ agent: AgentSpec; subagents: SubagentSpec[] }> {
	const bundle = await loadAgentDefinitionsFromFile(agentPath);
	const agent = bundle.agents[0];
	if (!agent) throw new Error("agent bundle must include at least one agent");
	return { agent, subagents: bundle.subagents };
}

function createRegistry(command: ModelsDiscoverCommand | ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: CliDeps): ModelRegistry {
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

function chatTask(command: ResolvedChatCommand, prompt: string): TaskSpec {
	return {
		id: `chat-${command.sessionId ?? command.resumeSessionId ?? "turn"}`,
		type: "general",
		title: "Chat",
		prompt,
		scoring: { method: "rubric", config: { contains: [] } },
	};
}

function chatSessionStore(command: ChatCommand, deps: CliDeps): AgentSessionStore {
	if (deps.sessionStore) return deps.sessionStore;
	return new JsonSessionStore(command.sessionDir ?? path.join(process.cwd(), ".evolving-agent", "sessions"));
}

function storedSession(id: string, agent: AgentSpec, command: ResolvedChatCommand, messages: StoredAgentSession["messages"], existing: StoredAgentSession | undefined, timestamp: number): StoredAgentSession {
	return {
		id,
		agentId: agent.id,
		...(agent.version ? { agentVersion: agent.version } : {}),
		messages,
		startupContext: storedStartupContext(command),
		createdAt: existing?.createdAt ?? timestamp,
		updatedAt: timestamp,
		...(existing?.metadata ? { metadata: existing.metadata } : {}),
	};
}

function storedStartupContext(command: ResolvedChatCommand): StoredAgentStartupContext {
	return {
		agentPath: command.agentPath,
		provider: command.provider,
		model: command.model,
		baseURL: command.baseURL,
		providerFormat: command.providerFormat,
		toolProfile: command.toolProfile,
		...(command.sessionDir ? { sessionDir: command.sessionDir } : {}),
	};
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
		ok: result.runs.every((run) => run.status === "passed"),
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

function evolutionJson(comparison: Awaited<ReturnType<BenchmarkEvolutionEngine["compare"]>>, verification: ReturnType<typeof verifyEvolutionComparison>): unknown {
	return {
		ok: comparison.recommendation !== "reject" && !verification.blocking,
		command: "evolve",
		baselineAgentId: comparison.baseline.agent.id,
		candidateAgentId: comparison.candidate.agent.id,
		suiteId: comparison.candidate.suite.id,
		deltaScore: comparison.deltaScore,
		deltaPassRate: comparison.deltaPassRate,
		regressions: comparison.regressions,
		improvements: comparison.improvements,
		recommendation: comparison.recommendation,
		verification,
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

function formatReplayHuman(runs: ReturnType<typeof replayTraceSource>): string {
	if (runs.length === 0) return "No replayable runs found";
	const rows = [["KIND", "SUBAGENT", "RUN", "TASK", "STATUS", "EVENTS", "TOOLS", "ERRORS", "WARNINGS"], ...runs.map((run) => [
		run.kind ?? "main",
		run.subagentId ?? "-",
		run.runId ?? "-",
		run.taskId ?? "-",
		run.status ?? "-",
		String(run.eventCount),
		`${run.toolCallCount}/${run.toolResultCount}`,
		String(run.errorCount),
		String(run.warnings.length),
	])];
	const warnings = runs.flatMap((run) => run.warnings.map((warning) => `${run.runId ?? run.taskId ?? "trace"}: ${warning}`));
	return ["Trace replay", "", formatTable(rows), ...(warnings.length > 0 ? ["", "Warnings:", ...warnings] : [])].join("\n");
}

function formatDiffHuman(diff: ReturnType<typeof diffRunSources>): string {
	if ("taskDiffs" in diff) {
		const rows = [["TASK", "LEFT", "RIGHT", "SCORE Δ", "CLASS"], ...diff.taskDiffs.map((taskDiff) => [
			taskDiff.taskId ?? "-",
			taskDiff.leftStatus ?? "-",
			taskDiff.rightStatus ?? "-",
			String(taskDiff.scoreDelta ?? 0),
			taskDiff.classification,
		])];
		return [
			`Suite diff ${diff.leftSuiteId ?? "-"} -> ${diff.rightSuiteId ?? "-"}`,
			`Improvements: ${diff.improvements.length === 0 ? "none" : diff.improvements.join(", ")}`,
			`Regressions: ${diff.regressions.length === 0 ? "none" : diff.regressions.join(", ")}`,
			"",
			formatTable(rows),
		].join("\n");
	}
	return [
		`Run diff ${diff.leftRunId ?? "-"} -> ${diff.rightRunId ?? "-"}`,
		`Task: ${diff.taskId ?? "-"}`,
		`Status: ${diff.leftStatus ?? "-"} -> ${diff.rightStatus ?? "-"}`,
		`Score delta: ${diff.scoreDelta ?? 0}`,
		`Classification: ${diff.classification}`,
	].join("\n");
}

function formatEvolutionHuman(comparison: Awaited<ReturnType<BenchmarkEvolutionEngine["compare"]>>, verification: ReturnType<typeof verifyEvolutionComparison>): string {
	return [
		`Evolution completed for suite ${comparison.candidate.suite.id}`,
		`Baseline: ${comparison.baseline.agent.id}`,
		`Candidate: ${comparison.candidate.agent.id}`,
		`Recommendation: ${comparison.recommendation}`,
		`Verification: ${verification.verdict}`,
		`Verification gate: ${verification.blocking ? "blocked" : "passed"}`,
		`Delta score: ${comparison.deltaScore}`,
		`Delta pass rate: ${formatPercent(comparison.deltaPassRate)}`,
		`Improvements: ${comparison.improvements.length === 0 ? "none" : comparison.improvements.join(", ")}`,
		`Regressions: ${comparison.regressions.length === 0 ? "none" : comparison.regressions.join(", ")}`,
	].join("\n");
}

async function readJsonFile(filePath: string): Promise<unknown> {
	return JSON.parse(await readFile(filePath, "utf-8"));
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf-8");
}
