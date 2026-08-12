import { mkdir, readFile, writeFile } from "node:fs/promises";
import path, { dirname } from "node:path";
import { createInterface } from "node:readline";
import { loadAgentDefinitionsFromFile } from "../agents/loader.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { createAutoContinueFollowUpProvider } from "./auto-continue.js";
import { BenchmarkRunner } from "../benchmark/runner.js";
import { loadBenchmarkSuiteFromFile } from "../benchmark/loader.js";
import { CompositeTaskGrader } from "../benchmark/grader.js";
import { createBenchmarkReport, formatBenchmarkReportMarkdown } from "../benchmark/report.js";
import { BenchmarkEvolutionEngine } from "../evolution/engine.js";
import { JsonlEvolutionHistoryStore } from "../evolution/history-store.js";
import { createEvolutionReport, formatEvolutionReportMarkdown } from "../evolution/report.js";
import type { EvolutionCandidate } from "../evolution/types.js";
import { verifyEvolutionComparison } from "../verification/verifier.js";
import { loadDeterministicCandidateGeneratorFromFile } from "../evolution/deterministic-generator-loader.js";
import type { EvolutionHistoryRecord } from "../evolution/history-store.js";
import type { AgentTaskRunResult, SuiteRunResult } from "../benchmark/types.js";
import { ModelRegistry, type ModelRegistryOptions } from "../models/registry.js";
import { loadTaskSpecFromFile } from "../tasks/loader.js";
import type { AgentSpec, SubagentSpec, TaskSpec } from "../specs.js";
import type { ChatCommand, BenchmarkCommand, DiffCommand, EvolveCommand, McpDiagnosticsCommand, McpStatusCommand, ModelsDiscoverCommand, ReplayCommand, RunCommand, SopListCommand, SopRunCommand, SopImportCommand, SopDepositCommand } from "./args.js";
import { createRoutedModelClient, effectiveAgentForCommand } from "./model-routing.js";
import { formatPercent, formatTable } from "./format.js";
import type { ToolRegistry } from "../tools/registry.js";
import { diagnoseMcpServers, type McpDiagnosticsReport, type McpServerDiagnostic } from "../mcp/diagnostics.js";
import type { McpClientHandle, McpServersConfig } from "../mcp/types.js";
import type { WebServer } from "../web/server.js";
import { createToolRegistryForProfileAsync } from "../tools/profiles.js";
import { replayTraceSource } from "../replay/trace-replay.js";
import { createAgentSession, appendUserMessage, entriesFromMessages, type AgentSession, type SessionEntry } from "../runtime/session.js";
import { isAbortError } from "../runtime/timeout.js";
import type { ModelClient, ModelMessage } from "../models/types.js";
import { JsonSessionStore } from "../sessions/json-session-store.js";
import { SqliteMemoryStore } from "../memory/sqlite-memory-store.js";
import { LlmMemoryExtractor } from "../memory/llm-extractor.js";
import { MemoryManager } from "../memory/manager.js";
import { createMemoryTools } from "../memory/tools.js";
import type { AgentSessionStore, StoredAgentSession, StoredAgentStartupContext } from "../sessions/session-store.js";
import { diffRunSources } from "../replay/run-diff.js";
import { loadSopSpecsFromDirectory } from "../sop/loader.js";
import { runSOP } from "../sop/runner.js";
import type { SOPSpec, SOPResult } from "../sop/types.js";
import { SopRegistry } from "../sop/registry.js";
import { MemorySkillBank, FileSkillBank } from "../skills/store.js";
import { depositSopDirectoryToSkillBank } from "../skills/sop-bridge.js";
import { createSkillTool, createSkillContextTransform } from "../skills/skill-tool.js";
import type { SkillBank } from "../skills/types.js";

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
	/** 测试钩子：web 服务器就绪后回调。 */
	onServerStarted?: (server: WebServer) => void;
	mcpClientFactory?: (serverName: string, config: McpServersConfig[string]) => Promise<McpClientHandle>;
	configCwd?: string;
}

export interface CliResult {
	exitCode: number;
	human?: string;
	json?: unknown;
	trace?: unknown;
	files?: Array<{ path: string; content: string }>;
}

export async function handleModelsDiscover(command: ModelsDiscoverCommand, deps: CliDeps): Promise<CliResult> {
	const registry = createModelRegistry(command, deps);
	const models = (await registry.discover(command.provider)).sort((left, right) => left.id.localeCompare(right.id));
	const json = { ok: true, command: command.kind, provider: command.provider, models };
	return {
		exitCode: 0,
		json,
		human: [`Discovered ${models.length} model(s) for provider ${command.provider}`, "", formatTable([["MODEL", "PROVIDER", "FORMAT"], ...models.map((model) => [model.id, model.providerId, model.format])])].join("\n"),
	};
}

export async function handleMcpStatus(command: McpStatusCommand, deps: CliDeps): Promise<CliResult> {
	const report = await diagnoseMcpServers({ ...(command.mcpServers ? { servers: command.mcpServers } : {}), ...(deps.mcpClientFactory ? { clientFactory: deps.mcpClientFactory } : {}) });
	return mcpResult(command.kind, report, formatMcpStatusHuman(report));
}

export async function handleMcpDiagnostics(command: McpDiagnosticsCommand, deps: CliDeps): Promise<CliResult> {
	const report = await diagnoseMcpServers({ ...(command.mcpServers ? { servers: command.mcpServers } : {}), includeDetails: true, ...(deps.mcpClientFactory ? { clientFactory: deps.mcpClientFactory } : {}) });
	return mcpResult(command.kind, report, formatMcpDiagnosticsHuman(report));
}

export async function handleChat(command: ChatCommand, deps: CliDeps): Promise<CliResult> {
	if (!command.prompt) return handleChatRepl(command, deps);
	const context = await createChatContext(command, deps);
	try {
		const output = await runChatTurn(context, command.prompt);
		return {
			exitCode: 0,
			json: { ok: true, command: command.kind, agentId: context.agent.id, answer: output.answer, sessionId: context.sessionId },
			trace: { sessionId: context.sessionId, answer: output.answer, trace: output.trace },
			human: output.answer,
		};
	} finally {
		await context.runtime.close();
	}
}

export async function handleRun(command: RunCommand, deps: CliDeps): Promise<CliResult> {
	const bundle = await loadAgentBundle(command.agentPath);
	const agent = effectiveAgentForCommand(bundle.agent, command);
	const task = await loadTaskSpecFromFile(command.taskPath);
	const runner = await createRunner(command, deps, bundle.subagents, agent);
	const result = await runner.runTask(agent, task);
	const json = runJson(command.kind, result);
	return {
		exitCode: result.status === "errored" || result.status === "timeout" || result.status === "interrupted" ? 1 : 0,
		json,
		trace: result,
		human: formatRunHuman(result),
	};
}

export async function handleBenchmark(command: BenchmarkCommand, deps: CliDeps): Promise<CliResult> {
	const bundle = await loadAgentBundle(command.agentPath);
	const agent = effectiveAgentForCommand(bundle.agent, command);
	const suite = await loadBenchmarkSuiteFromFile(command.suitePath);
	const runner = await createRunner(command, deps, bundle.subagents, agent);
	const result = await runner.runSuite(agent, suite);
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

export async function handleSopList(command: SopListCommand, _deps: CliDeps): Promise<CliResult> {
	const specs = await loadSopSpecsFromDirectory(command.sopDir);
	const json = {
		ok: true,
		command: command.kind,
		sopDir: command.sopDir,
		sops: specs.map((s) => ({ id: s.id, name: s.name, version: s.version, description: s.description, steps: s.steps.length })),
	};
	return {
		exitCode: 0,
		json,
		human: formatSopListHuman(specs),
	};
}

export async function handleSopRun(command: SopRunCommand, deps: CliDeps): Promise<CliResult> {
	const specs = await loadSopSpecsFromDirectory(command.sopDir);
	const spec = specs.find((s) => s.id === command.sopId);
	if (!spec) throw new Error(`SOP "${command.sopId}" not found in ${command.sopDir}`);

	const toolRegistry = await createToolRegistryForProfileAsync({
		profile: "dangerous",
		workspaceRoot: deps.workspaceRoot ?? process.cwd(),
		...(deps.fetchFn ? { fetch: deps.fetchFn } : {}),
	});

	const session = createAgentSession({
		id: deps.createId?.() ?? crypto.randomUUID(),
		agent: {
			id: "sop-cli",
			version: "0.0.0",
			name: "SOP CLI",
			kind: "baseline",
			model: { provider: "none", model: "none" },
			prompts: { system: "" },
			tools: { allowedTools: [] },
			runtime: { maxTurns: 1 },
		},
		task: {
			id: command.sopId,
			type: "general",
			title: command.sopId,
			prompt: `Run SOP: ${command.sopId}`,
			scoring: { method: "rubric", config: { contains: [] } },
		},
	});

	const specMap = new Map(specs.map((s) => [s.id, s]));
	async function runSubSOP(sopId: string, input: Record<string, unknown>, subSession: AgentSession): Promise<SOPResult> {
		const subSpec = specMap.get(sopId);
		if (!subSpec) throw new Error(`sub-SOP "${sopId}" not found`);
		return runSOP(subSpec, {
			params: input,
			session: subSession,
			toolRegistry,
			...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
			runSubSOP,
		});
	}

	const result = await runSOP(spec, {
		params: {},
		session,
		toolRegistry,
		...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
		runSubSOP,
	});

	return {
		exitCode: result.status === "failed" ? 1 : 0,
		json: { ok: result.status !== "failed", command: command.kind, sopId: command.sopId, result },
		trace: result,
		human: formatSopRunHuman(result),
	};
}

export async function handleEvolve(command: EvolveCommand, deps: CliDeps): Promise<CliResult> {
	if (command.listHistory && command.historyPath) return handleEvolveHistory(command);
	if (command.autoIterations !== undefined && command.generatePath && command.baselineAgentPath && command.suitePath) return handleEvolveAuto(command, deps);
	if (command.generatePath && command.baselineAgentPath && command.suitePath) return handleEvolveGenerate(command, deps);

	if (!command.baselineAgentPath || !command.candidateAgentPath || !command.suitePath) {
		throw new Error("evolve requires either --history --list, --generate, --auto, or --baseline-agent + --candidate-agent + --suite");
	}

	const baselineBundle = await loadAgentBundle(command.baselineAgentPath);
	const candidateBundle = await loadAgentBundle(command.candidateAgentPath);
	const baselineAgent = effectiveAgentForCommand(baselineBundle.agent, command);
	const candidateAgent = effectiveAgentForCommand(candidateBundle.agent, command);
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
		createRunner: (agent) => createRunner(command, deps, agent.id === candidateAgent.id ? candidateBundle.subagents : baselineBundle.subagents, agent),
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

async function handleEvolveHistory(command: EvolveCommand): Promise<CliResult> {
	if (!command.historyPath) throw new Error("--history is required for history mode");
	const store = new JsonlEvolutionHistoryStore(command.historyPath);
	const records = await store.readRecords();
	if (command.listHistory) {
		return {
			exitCode: 0,
			json: { ok: true, command: "evolve", mode: "history", count: records.length, records },
			human: formatEvolutionHistoryHuman(records),
		};
	}
	return {
		exitCode: 0,
		human: formatEvolutionHistoryHuman(records),
		json: { ok: true, command: "evolve", mode: "history", count: records.length, records },
	};
}

async function handleEvolveGenerate(command: EvolveCommand, deps: CliDeps): Promise<CliResult> {
	if (!command.baselineAgentPath || !command.suitePath || !command.generatePath) throw new Error("--baseline-agent, --suite, --generate are required");
	const baselineBundle = await loadAgentBundle(command.baselineAgentPath);
	const baselineAgent = effectiveAgentForCommand(baselineBundle.agent, command);
	const suite = await loadBenchmarkSuiteFromFile(command.suitePath);
	const generator = await loadDeterministicCandidateGeneratorFromFile(command.generatePath);
	const candidates = await generator.generate(baselineAgent);

	if (candidates.length === 0) {
		return { exitCode: 0, json: { ok: true, command: "evolve", mode: "generate", candidateCount: 0 }, human: "No candidates generated" };
	}

	const results: Awaited<ReturnType<BenchmarkEvolutionEngine["compare"]>>[] = [];
	for (const candidate of candidates) {
		const engine = new BenchmarkEvolutionEngine({
			baseline: baselineAgent,
			suite,
			generator: { async generate() { return [candidate]; } },
			createRunner: (agent) => createRunner(command, deps, baselineBundle.subagents, agent),
		});
		const comparison = await engine.compare(candidate);
		results.push(comparison);
		if (command.historyPath) {
			const store = deps.createEvolutionHistoryStore?.(command.historyPath) ?? new JsonlEvolutionHistoryStore(command.historyPath);
			await store.saveComparison(comparison, candidate);
		}
	}

	return {
		exitCode: results.some((r) => r.recommendation === "reject") ? 1 : 0,
		json: { ok: true, command: "evolve", mode: "generate", candidateCount: candidates.length, results: results.map((r) => evolutionJson(r, verifyEvolutionComparison(r.baseline, r.candidate))) },
		human: formatEvolutionGenerateHuman(results),
	};
}

async function handleEvolveAuto(command: EvolveCommand, deps: CliDeps): Promise<CliResult> {
	if (!command.baselineAgentPath || !command.suitePath || !command.generatePath || command.autoIterations === undefined) {
		throw new Error("--baseline-agent, --suite, --generate, --auto are required");
	}
	const bundle = await loadAgentBundle(command.baselineAgentPath);
	let baselineAgent = effectiveAgentForCommand(bundle.agent, command);
	const suite = await loadBenchmarkSuiteFromFile(command.suitePath);
	const iterationSummaries: string[] = [];

	for (let iteration = 1; iteration <= command.autoIterations; iteration++) {
		const generator = await loadDeterministicCandidateGeneratorFromFile(command.generatePath);
		const candidates = await generator.generate(baselineAgent);
		if (candidates.length === 0) {
			iterationSummaries.push(`Iteration ${iteration}: no candidates generated, stopping`);
			break;
		}

		const comparisons: { candidate: EvolutionCandidate; comparison: Awaited<ReturnType<BenchmarkEvolutionEngine["compare"]>> }[] = [];
		for (const candidate of candidates) {
			const engine = new BenchmarkEvolutionEngine({
				baseline: baselineAgent,
				suite,
				generator: { async generate() { return [candidate]; } },
				createRunner: (agent) => createRunner(command, deps, bundle.subagents, agent),
			});
			const comparison = await engine.compare(candidate);
			comparisons.push({ candidate, comparison });
			if (command.historyPath) {
				const store = deps.createEvolutionHistoryStore?.(command.historyPath) ?? new JsonlEvolutionHistoryStore(command.historyPath);
				await store.saveComparison(comparison, candidate);
			}
		}

		comparisons.sort(compareEvolutionResults);
		const best = comparisons[0];
		if (!best) {
			iterationSummaries.push(`Iteration ${iteration}: no candidates to compare, stopping`);
			break;
		}

		const rec = best.comparison.recommendation;
		iterationSummaries.push(`Iteration ${iteration}: best=${best.candidate.id} recommendation=${rec} deltaScore=${best.comparison.deltaScore} deltaPassRate=${formatPercent(best.comparison.deltaPassRate)}`);

		if (rec === "reject") {
			iterationSummaries.push(`Iteration ${iteration}: all candidates rejected, stopping`);
			break;
		}

		baselineAgent = { ...best.candidate.agent };
	}

	return {
		exitCode: 0,
		json: { ok: true, command: "evolve", mode: "auto", iterations: iterationSummaries.length },
		human: ["Auto-evolve completed", "", ...iterationSummaries].join("\n"),
	};
}

function compareEvolutionResults(
	a: { comparison: Awaited<ReturnType<BenchmarkEvolutionEngine["compare"]>> },
	b: { comparison: Awaited<ReturnType<BenchmarkEvolutionEngine["compare"]>> },
): number {
	const rank = (rec: string) => rec === "accept" ? 0 : rec === "needs-review" ? 1 : 2;
	const rankDiff = rank(a.comparison.recommendation) - rank(b.comparison.recommendation);
	if (rankDiff !== 0) return rankDiff;
	return (b.comparison.deltaScore ?? 0) - (a.comparison.deltaScore ?? 0);
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
	entries: SessionEntry[];
	now: () => number;
	createId: () => string;
	memoryManager?: MemoryManager;
}

async function handleChatRepl(command: ChatCommand, deps: CliDeps): Promise<CliResult> {
	const context = await createChatContext(command, deps);
	const stdout = deps.stdout ?? process.stdout;
	const { inputLines, close, onSigint } = createChatInput(deps);
	let activeTurnController: AbortController | undefined;
	const unsubscribeSigint = onSigint?.(() => {
		if (activeTurnController) activeTurnController.abort(new Error("User interrupted"));
		else close?.();
	});
	try {
		stdout.write("> ");
		for await (const line of inputLines) {
			const input = line.trim();
			if (input === "/exit" || input === "/quit") break;
			if (input) {
				activeTurnController = new AbortController();
				try {
					const output = await runChatTurn(context, input, activeTurnController.signal);
					stdout.write(`${output.answer}\n`);
				} catch (error) {
					if (!isAbortError(error, activeTurnController.signal)) throw error;
					stdout.write("Interrupted\n");
				} finally {
					activeTurnController = undefined;
				}
			}
			stdout.write("> ");
		}
	} finally {
		unsubscribeSigint?.();
		close?.();
		await context.runtime.close();
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
	const agent = effectiveAgentForCommand(bundle.agent, resolvedCommand);
	const sessionId = resolvedCommand.resumeSessionId ?? resolvedCommand.sessionId ?? (deps.createId?.() ?? crypto.randomUUID());
	const modelClient = createRoutedModelClient(resolvedCommand, deps, agent);
	const memoryManager = createMemoryManager(agent, resolvedCommand, modelClient);
	const runtime = await createRuntime(resolvedCommand, deps, bundle.subagents, memoryManager, modelClient, agent);
	return {
		command: resolvedCommand,
		agent,
		runtime,
		sessionStore,
		stored,
		sessionId,
		messages: chatMessages(stored, agent),
		entries: chatEntries(stored, agent),
		now: deps.now ?? Date.now,
		createId: deps.createId ?? (() => crypto.randomUUID()),
		...(memoryManager ? { memoryManager } : {}),
	};
}

async function runChatTurn(context: ChatContext, prompt: string, signal?: AbortSignal): Promise<{ answer: string; trace: NonNullable<Awaited<ReturnType<AgentRuntime["runSession"]>>["trace"]> }> {
	const startMessageIndex = context.messages.length;
	const session = createAgentSession({ id: context.sessionId, agent: context.agent, task: chatTask(context.command, prompt), entries: context.entries });
	appendUserMessage(session, prompt);
	const output = await context.runtime.runSession(session, signal);
	context.messages = session.messages;
	context.entries = session.entries ?? entriesFromMessages(session.messages);
	await context.memoryManager?.recordTurn({ agentId: context.agent.id, sessionId: context.sessionId, projectId: memoryProjectId(context.command), messages: session.messages, trace: session.trace, startMessageIndex, now: context.now, createId: context.createId });
	if (context.command.resumeSessionId || context.command.sessionId) {
		const stored = storedSession(context.sessionId, context.agent, context.command, session, context.stored, context.now());
		await context.sessionStore.saveSession(stored);
		context.stored = stored;
	}
	return { answer: output.answer ?? "", trace: output.trace ?? [] };
}

function chatMessages(stored: StoredAgentSession | undefined, agent: AgentSpec): ModelMessage[] {
	return chatEntries(stored, agent).map((entry) => entry.message);
}

function chatEntries(stored: StoredAgentSession | undefined, agent: AgentSpec): SessionEntry[] {
	const entries = stored?.entries ? [...stored.entries] : entriesFromMessages(stored?.messages ?? [{ role: "system", content: agent.prompts.system }]);
	const first = entries[0];
	if (first?.kind === "system") {
		return [{ ...first, message: { ...first.message, content: agent.prompts.system, contentBlocks: [{ type: "text", text: agent.prompts.system }] } }, ...entries.slice(1)];
	}
	return [...entriesFromMessages([{ role: "system", content: agent.prompts.system }]), ...entries];
}

function resolveChatCommand(command: ChatCommand, stored: StoredAgentSession | undefined): ResolvedChatCommand {
	const sessionDir = resolveOptionalChatString(command, stored, "sessionDir");
	const agentPath = resolveRequiredChatString(command, stored, "agentPath", "--agent");
	const modelOverride = hasModelOverride(command);
	const providers = resolvedProviders(command, stored, modelOverride);
	const modelRouting = resolvedModelRouting(command, stored, modelOverride);
	return {
		kind: command.kind,
		format: command.format,
		agentPath,
		provider: resolveRequiredChatString(command, stored, "provider", "--provider"),
		model: resolveRequiredChatString(command, stored, "model", "--model"),
		baseURL: resolveRequiredChatString(command, stored, "baseURL", "--base-url"),
		providerFormat: resolveProviderFormat(command, stored),
		toolProfile: resolveToolProfile(command, stored),
		providedFlags: { ...command.providedFlags, agentPath: command.providedFlags.agentPath || stored?.startupContext?.agentPath !== undefined || agentPath !== command.agentPath },
		...(command.prompt ? { prompt: command.prompt } : {}),
		...(command.outputPath ? { outputPath: command.outputPath } : {}),
		...(command.tracePath ? { tracePath: command.tracePath } : {}),
		...(command.apiKey ? { apiKey: command.apiKey } : {}),
		...(command.sessionId ? { sessionId: command.sessionId } : {}),
		...(command.resumeSessionId ? { resumeSessionId: command.resumeSessionId } : {}),
		...(command.mcpServers ? { mcpServers: command.mcpServers } : {}),
		...(providers ? { providers } : {}),
		...(modelRouting ? { modelRouting } : {}),
		...(sessionDir ? { sessionDir } : {}),
	};
}

function resolvedProviders(command: ChatCommand, stored: StoredAgentSession | undefined, modelOverride: boolean): ChatCommand["providers"] {
	return modelOverride ? command.providers : (stored?.startupContext?.providers ?? command.providers);
}

function resolvedModelRouting(command: ChatCommand, stored: StoredAgentSession | undefined, modelOverride: boolean): ChatCommand["modelRouting"] {
	return modelOverride ? undefined : (stored?.startupContext?.modelRouting ?? command.modelRouting);
}

function hasModelOverride(command: ChatCommand): boolean {
	return command.providedFlags.provider === true || command.providedFlags.model === true || command.providedFlags.baseURL === true || command.providedFlags.providerFormat === true;
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

function createChatInput(deps: CliDeps): { inputLines: AsyncIterable<string>; close?: () => void; onSigint?: (handler: () => void) => () => void } {
	if (deps.inputLines) return { inputLines: deps.inputLines };
	const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	return {
		inputLines: input,
		close: () => input.close(),
		onSigint: (handler) => {
			input.on("SIGINT", handler);
			return () => input.off("SIGINT", handler);
		},
	};
}

async function createRunner(command: RunCommand | BenchmarkCommand | EvolveCommand, deps: CliDeps, subagents: SubagentSpec[] = [], agent?: AgentSpec): Promise<BenchmarkRunner> {
	const modelClient = agent ? createRoutedModelClient(command, deps, agent) : undefined;
	return new BenchmarkRunner({
		runtime: await createRuntime(command, deps, subagents, undefined, modelClient, agent),
		grader: new CompositeTaskGrader({ modelClient }),
		...(deps.now ? { now: deps.now } : {}),
		...(deps.createId ? { createId: deps.createId } : {}),
	});
}

async function createRuntime(command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: CliDeps, subagents: SubagentSpec[] = [], memoryManager?: MemoryManager, modelClient = createModelClient(command, deps), agent?: AgentSpec): Promise<AgentRuntime> {
	const toolRegistry = await createCommandToolRegistry(command, deps);
	registerMemoryTools(toolRegistry, command, deps, memoryManager);
	const skillBank = await registerSkillTools(toolRegistry, agent, deps);
	return new AgentRuntime({
		modelClient,
		toolRegistry,
		createToolRegistryForAgent: () => toolRegistryForAgent(toolRegistry, command, deps, memoryManager),
		...(memoryManager ? { memoryContextProvider: (session) => memoryManager.loadContext({ agentId: session.agent.id, sessionId: session.id, projectId: memoryProjectId(command), prompt: session.task.prompt, now: deps.now ?? Date.now }) } : {}),
		...(subagents.length > 0 ? { subagents } : {}),
		...(deps.now ? { now: deps.now } : {}),
		...(deps.createId ? { createId: deps.createId } : {}),
		...(command.kind === "chat" ? { getFollowUpMessages: createAutoContinueFollowUpProvider() } : {}),
		...(skillBank ? { contextTransform: createSkillContextTransform(skillBank) } : {}),
	});
}

async function createCommandToolRegistry(command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: CliDeps): Promise<ToolRegistry> {
	if (deps.toolRegistry) return deps.toolRegistry;
	return createToolRegistryForProfileAsync({ profile: command.toolProfile, workspaceRoot: deps.workspaceRoot ?? process.cwd(), ...(deps.fetchFn ? { fetch: deps.fetchFn } : {}), ...(command.mcpServers ? { mcpServers: command.mcpServers } : {}) });
}

function toolRegistryForAgent(baseRegistry: ToolRegistry, command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: CliDeps, memoryManager?: MemoryManager): ToolRegistry {
	const registry = deps.toolRegistry ?? baseRegistry.clone();
	registerMemoryTools(registry, command, deps, memoryManager);
	return registry;
}

function registerMemoryTools(toolRegistry: ToolRegistry, command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: CliDeps, memoryManager?: MemoryManager): void {
	if (!memoryManager || toolRegistry.get("memory_context")) return;
	for (const tool of createMemoryTools({ manager: memoryManager, projectId: memoryProjectId(command), now: deps.now ?? Date.now, createId: deps.createId ?? (() => crypto.randomUUID()) })) {
		toolRegistry.register(tool);
	}
}

async function loadAgentBundle(agentPath: string): Promise<{ agent: AgentSpec; subagents: SubagentSpec[] }> {
	const bundle = await loadAgentDefinitionsFromFile(agentPath);
	const agent = bundle.agents[0];
	if (!agent) throw new Error("agent bundle must include at least one agent");
	return { agent, subagents: bundle.subagents };
}

function mcpResult(command: "mcp.status" | "mcp.diagnostics", report: McpDiagnosticsReport, human: string): CliResult {
	return { exitCode: report.ok ? 0 : 1, json: { ok: report.ok, command, summary: report.summary, servers: report.servers, diagnostics: report.diagnostics }, human };
}

function formatMcpStatusHuman(report: McpDiagnosticsReport): string {
	if (report.summary.configured === 0) return "No MCP servers configured";
	const summary = `MCP servers: ${report.summary.configured} configured, ${report.summary.enabled} enabled, ${report.summary.connected} connected, ${report.summary.failed} failed, ${report.summary.disabled} disabled`;
	const rows = [["SERVER", "TYPE", "ENABLED", "POLICY", "STATE", "TOOLS", "RESOURCES", "ERROR"], ...report.servers.map((server) => [server.name, server.type, server.enabled ? "yes" : "no", server.failPolicy, server.state, String(server.toolCount), server.resourcesEnabled ? "yes" : "no", server.errorMessage ?? ""] )];
	return [summary, "", formatTable(rows)].join("\n");
}

function formatMcpDiagnosticsHuman(report: McpDiagnosticsReport): string {
	if (report.summary.configured === 0) return "No MCP servers configured";
	return ["MCP diagnostics", "", ...report.servers.map(formatMcpServerDiagnosticHuman), ...(report.diagnostics.length > 0 ? ["", "Diagnostics:", ...report.diagnostics.map((diagnostic) => `- ${diagnostic}`)] : [])].join("\n");
}

function formatMcpServerDiagnosticHuman(server: McpServerDiagnostic): string {
	const lines = [server.name, `  enabled: ${server.enabled ? "yes" : "no"}`, `  type: ${server.type}`, `  failPolicy: ${server.failPolicy}`, `  state: ${server.state}`, `  tools: ${server.toolCount}`, `  resources: ${server.resourcesEnabled ? "enabled" : "disabled"}`];
	if (server.command) lines.push(`  command: ${server.command}`);
	if (server.args?.length) lines.push(`  args: ${server.args.join(" ")}`);
	if (server.cwd) lines.push(`  cwd: ${server.cwd}`);
	if (server.url) lines.push(`  url: ${server.url}`);
	if (server.timeoutMs) lines.push(`  timeoutMs: ${server.timeoutMs}`);
	if (server.envKeys?.length) lines.push(`  envKeys: ${server.envKeys.join(", ")}`);
	if (server.headerKeys?.length) lines.push(`  headerKeys: ${server.headerKeys.join(", ")}`);
	if (server.errorMessage) lines.push(`  error: ${server.errorMessage}`);
	for (const tool of server.tools ?? []) lines.push(`  - ${tool.name} -> ${tool.qualifiedName}`);
	for (const resource of server.resources ?? []) lines.push(`  - resource ${resource.uri}${resource.name ? ` (${resource.name})` : ""}`);
	return lines.join("\n");
}

function createMemoryManager(agent: AgentSpec, command: ResolvedChatCommand, modelClient: ModelClient): MemoryManager | undefined {
	if (agent.runtime.memoryPolicy !== "long-term") return undefined;
	return new MemoryManager(new SqliteMemoryStore(path.join(chatStorageRoot(command), ".evolving-agent", "memory")), new LlmMemoryExtractor(modelClient, agent));
}

function memoryProjectId(command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand): string {
	return command.kind === "chat" ? chatStorageRoot(command) : process.cwd();
}

function chatStorageRoot(command: ResolvedChatCommand): string {
	if (!command.sessionDir) return process.cwd();
	return isDefaultSessionDir(command.sessionDir) ? dirname(dirname(command.sessionDir)) : command.sessionDir;
}

function isDefaultSessionDir(sessionDir: string): boolean {
	return path.basename(sessionDir) === "sessions" && path.basename(dirname(sessionDir)) === ".evolving-agent";
}

function createModelClient(command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: CliDeps): ModelClient {
	return createRoutedModelClient(command, deps, commandAgent(command));
}

function commandAgent(command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand): AgentSpec {
	return {
		id: "model-routing-command",
		version: "0.0.0",
		name: "Model Routing Command",
		kind: "baseline",
		model: { provider: command.provider, model: command.model },
		...(command.modelRouting ? { modelRouting: command.modelRouting } : {}),
		prompts: { system: "" },
		tools: { allowedTools: [] },
		runtime: { maxTurns: 1 },
	};
}

function createModelRegistry(command: ModelsDiscoverCommand | ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: CliDeps): ModelRegistry {
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

function storedSession(id: string, agent: AgentSpec, command: ResolvedChatCommand, session: AgentSession, existing: StoredAgentSession | undefined, timestamp: number): StoredAgentSession {
	return {
		id,
		agentId: agent.id,
		...(agent.version ? { agentVersion: agent.version } : {}),
		schemaVersion: 2,
		messages: session.messages,
		...(session.entries ? { entries: session.entries } : {}),
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
		...(command.providers ? { providers: command.providers } : {}),
		...(command.modelRouting ? { modelRouting: command.modelRouting } : {}),
		...(command.sessionDir ? { sessionDir: command.sessionDir } : {}),
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
		`Tasks: ${result.summary.passedTasks} passed, ${result.summary.failedTasks} failed, ${result.summary.erroredTasks} errored, ${result.summary.timeoutTasks} timeout, ${result.summary.interruptedTasks} interrupted`,
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

function formatEvolutionHistoryHuman(records: EvolutionHistoryRecord[]): string {
	if (records.length === 0) return "No evolution history records found";
	const rows = [["#", "TIMESTAMP", "BASELINE", "CANDIDATE", "RECOMMENDATION", "Δ SCORE", "Δ PASS RATE", "IMPROVEMENTS", "REGRESSIONS"],
		...records.map((r, i) => [
			String(i + 1),
			new Date(r.timestamp).toISOString().slice(0, 19).replace("T", " "),
			r.baselineAgent.id,
			r.candidateAgent.id,
			r.recommendation,
			String(r.deltaScore ?? "-"),
			formatPercent(r.deltaPassRate),
			r.improvements.length === 0 ? "-" : r.improvements.join(", "),
			r.regressions.length === 0 ? "-" : r.regressions.join(", "),
		])];
	return [`Evolution history (${records.length} records)`, "", formatTable(rows)].join("\n");
}

function formatEvolutionGenerateHuman(results: Awaited<ReturnType<BenchmarkEvolutionEngine["compare"]>>[]): string {
	const rows = [["#", "CANDIDATE", "RECOMMENDATION", "Δ SCORE", "Δ PASS RATE", "IMPROVEMENTS", "REGRESSIONS"],
		...results.map((r, i) => [
			String(i + 1),
			r.candidate.agent.id,
			r.recommendation,
			String(r.deltaScore ?? "-"),
			formatPercent(r.deltaPassRate),
			r.improvements.length === 0 ? "-" : r.improvements.join(", "),
			r.regressions.length === 0 ? "-" : r.regressions.join(", "),
		])];
	return [`Generated ${results.length} candidate(s)`, "", formatTable(rows)].join("\n");
}

async function readJsonFile(filePath: string): Promise<unknown> {
	return JSON.parse(await readFile(filePath, "utf-8"));
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function formatSopListHuman(specs: SOPSpec[]): string {
	if (specs.length === 0) return "No SOPs found";
	const rows = [["ID", "NAME", "VERSION", "STEPS", "DESCRIPTION"], ...specs.map((s) => [s.id, s.name, s.version, String(s.steps.length), s.description])];
	return [`Found ${specs.length} SOP(s)`, "", formatTable(rows)].join("\n");
}

function formatSopRunHuman(result: SOPResult): string {
	const rows = [["STEP", "STATUS", "DURATION"], ...result.stepResults.map((r) => [r.stepId, r.status, `${r.durationMs}ms`])];
	return [
		`SOP ${result.sopId}: ${result.status}`,
		`Total duration: ${result.totalDurationMs}ms`,
		"",
		formatTable(rows),
		...(result.finalVerification ? [`Final verification: ${result.finalVerification.passed ? "passed" : "failed"}${result.finalVerification.detail ? ` (${result.finalVerification.detail})` : ""}`] : []),
	].join("\n");
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf-8");
}

	async function registerSkillTools(toolRegistry: ToolRegistry, agent: AgentSpec | undefined, deps: CliDeps): Promise<SkillBank | undefined> {
		if (!agent?.skills) return undefined;
		const skills = agent.skills;
		if (skills.enabled === false) return undefined;
		if (toolRegistry.get("skill")) return undefined;

		const sopDir = skills.sopDir ?? "sop";

		const registry = new SopRegistry();
		await registry.loadAndRegister({
			sopDir,
			toolRegistry,
		});

		const bank = skills.skillBankPath
			? new FileSkillBank({ path: skills.skillBankPath })
			: new MemorySkillBank();

		await depositSopDirectoryToSkillBank(sopDir, bank, { force: true });

		const skillTool = createSkillTool({ bank, toolRegistry });
		toolRegistry.register(skillTool);

		return bank;
	}

	export async function handleSopImport(command: SopImportCommand, deps: CliDeps): Promise<CliResult> {
		const { parseMarketSkillContent, marketSkillToSopSpec } = await import("../skills/market-converter.js");
		const { stringify } = await import("yaml");
		const raw = await readFile(command.inputPath, "utf-8");
		const { config, body } = await parseMarketSkillContent(raw);
		const sop = marketSkillToSopSpec(config, body);
		const yamlContent = stringify(sop);
		const outputPath = path.join(command.outputDir, `${sop.id}.sop.yaml`);
		await writeTextFile(outputPath, yamlContent);
		return {
			exitCode: 0,
			json: { ok: true, command: command.kind, sop: { id: sop.id, name: sop.name, version: sop.version, steps: sop.steps.length }, outputPath },
			human: `Imported SKILL.md "${command.inputPath}" -> ${outputPath}`,
		};
	}

	export async function handleSopDeposit(command: SopDepositCommand, deps: CliDeps): Promise<CliResult> {
		const { createOrLoadSkillBank, depositSopDirectoryToSkillBank } = await import("../skills/sop-bridge.js");
		const bank = await createOrLoadSkillBank(command.skillBankPath ?? "skills.json");
		const skills = await depositSopDirectoryToSkillBank(command.sopDir, bank, { ...(command.force !== undefined ? { force: command.force } : {}) });
		return {
			exitCode: 0,
			json: { ok: true, command: command.kind, sopDir: command.sopDir, skillCount: skills.length, skills: skills.map((s) => ({ id: s.id, name: s.name })) },
			human: `Deposited ${skills.length} skill(s) from ${command.sopDir} to skill bank`,
		};
	}
