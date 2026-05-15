import path, { dirname } from "node:path";
import { loadAgentDefinitionsFromFile } from "../agents/loader.js";
import type { ModelRegistryOptions } from "../models/registry.js";
import { SqliteMemoryStore } from "../memory/sqlite-memory-store.js";
import { LlmMemoryExtractor } from "../memory/llm-extractor.js";
import { MemoryManager } from "../memory/manager.js";
import { createMemoryTools } from "../memory/tools.js";
import type { ModelClient, ModelMessage } from "../models/types.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import type { TraceEvent, TraceEventObserver } from "../runtime/events.js";
import { createAutoContinueFollowUpProvider } from "./auto-continue.js";
import { appendUserMessage, createAgentSession, entriesFromMessages, type AgentSession, type SessionEntry } from "../runtime/session.js";
import { abortMessage, abortReason, isAbortError, isRuntimeTimeoutError } from "../runtime/timeout.js";
import type { AgentSpec, SubagentSpec, TaskSpec } from "../specs.js";
import type { AgentSessionStore, StoredAgentSession, StoredAgentStartupContext } from "../sessions/session-store.js";
import { JsonSessionStore } from "../sessions/json-session-store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createToolRegistryForProfileAsync, createToolRegistryWithBackgroundMcp } from "../tools/profiles.js";
import type { BenchmarkCommand, ChatCommand, EvolveCommand, RunCommand, TuiCommand } from "./args.js";
import { createRoutedModelClient, effectiveAgentForCommand } from "./model-routing.js";
import { summarizeCompletedSession } from "../runtime/compaction.js";

export interface ChatServiceDeps {
	fetchFn?: typeof fetch;
	openAIClientFactory?: ModelRegistryOptions["openAIClientFactory"];
	toolRegistry?: ToolRegistry;
	sessionStore?: AgentSessionStore;
	workspaceRoot?: string;
	now?: () => number;
	createId?: () => string;
	enableTuiAutomationTools?: boolean;
}

export type ResolvedChatCommand = ChatCommand & StoredAgentStartupContext;

export interface ChatServiceContext {
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
	toolRegistry: ToolRegistry;
	memoryManager?: MemoryManager;
	eventObserver?: TraceEventObserver;
}

export interface CreateChatServiceOptions {
	eventObserver?: TraceEventObserver;
}

export interface ChatTurnOutput {
	answer: string;
	trace: TraceEvent[];
}

export async function createChatServiceContext(command: ChatCommand | TuiCommand, deps: ChatServiceDeps, options: CreateChatServiceOptions = {}): Promise<ChatServiceContext> {
	const chatCommand = asChatCommand(command);
	const sessionStore = chatSessionStore(chatCommand, deps);
	const stored = chatCommand.resumeSessionId || chatCommand.sessionId ? await sessionStore.loadSession((chatCommand.resumeSessionId ?? chatCommand.sessionId)!) : undefined;
	if (chatCommand.resumeSessionId && !stored) throw new Error(`session ${chatCommand.resumeSessionId} not found`);
	const resolvedCommand = resolveChatCommand(chatCommand, stored);
	const bundle = await loadAgentBundle(resolvedCommand.agentPath);
	const agent = effectiveAgentForCommand(bundle.agent, resolvedCommand);
	const sessionId = resolvedCommand.resumeSessionId ?? resolvedCommand.sessionId ?? (deps.createId?.() ?? crypto.randomUUID());
	const modelClient = createRoutedModelClient(resolvedCommand, deps, agent);
	const memoryManager = createMemoryManager(agent, resolvedCommand, modelClient);
	const toolRegistry = createChatToolRegistry(resolvedCommand, deps);
	registerMemoryTools(toolRegistry, resolvedCommand, deps, memoryManager);
	const runtime = createRuntime(resolvedCommand, deps, bundle.subagents, toolRegistry, memoryManager, modelClient, options.eventObserver);
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
		toolRegistry,
		...(memoryManager ? { memoryManager } : {}),
		...(options.eventObserver ? { eventObserver: options.eventObserver } : {}),
	};
}

export function startNewChatSession(context: ChatServiceContext): string {
	const sessionId = context.createId();
	context.sessionId = sessionId;
	context.messages = chatMessages(undefined, context.agent);
	context.entries = chatEntries(undefined, context.agent);
	context.stored = undefined;
	if (context.command.sessionId || context.command.resumeSessionId) context.command.sessionId = sessionId;
	delete context.command.resumeSessionId;
	return sessionId;
}

export async function runChatTurn(context: ChatServiceContext, prompt: string, signal?: AbortSignal): Promise<ChatTurnOutput> {
	const startMessageIndex = context.messages.length;
	const session = createAgentSession({ id: context.sessionId, agent: context.agent, task: chatTask(context.command, prompt), entries: context.entries });
	const startedAt = context.now();
	appendUserMessage(session, prompt);
	recordChatEvent(context, session, "run_start", { agent: context.agent, task: session.task });
	try {
		const output = await context.runtime.runSession(session, signal);
		recordChatEvent(context, session, "run_end", { status: "passed", durationMs: context.now() - startedAt });
		summarizeCompletedSession(session);
		await finalizeChatTurn(context, session, startMessageIndex, true);
		return { answer: output.answer ?? "", trace: output.trace ?? [] };
	} catch (error) {
		if (isAbortError(error, signal)) {
			recordChatEvent(context, session, "interrupted", { reason: abortReason(signal), message: abortMessage(error, signal) });
			recordChatEvent(context, session, "run_end", { status: "interrupted", durationMs: context.now() - startedAt });
			await finalizeChatTurn(context, session, startMessageIndex, false);
			throw error;
		}
		const status = isRuntimeTimeoutError(error) ? "timeout" : "errored";
		recordChatEvent(context, session, "error", { message: error instanceof Error ? error.message : String(error) });
		recordChatEvent(context, session, "run_end", { status, durationMs: context.now() - startedAt });
		throw error;
	}
}

async function finalizeChatTurn(context: ChatServiceContext, session: AgentSession, startMessageIndex: number, recordMemory: boolean): Promise<void> {
	context.messages = session.messages;
	context.entries = session.entries ?? entriesFromMessages(session.messages);
	if (recordMemory) context.memoryManager?.recordTurn({ agentId: context.agent.id, sessionId: context.sessionId, projectId: memoryProjectId(context.command), messages: session.messages, trace: session.trace, startMessageIndex, now: context.now, createId: context.createId, force: true }).catch(() => {});
	if (!context.command.resumeSessionId && !context.command.sessionId) return;
	const stored = storedSession(context.sessionId, context.agent, context.command, session, context.stored, context.now());
	await context.sessionStore.saveSession(stored);
	context.stored = stored;
}

function asChatCommand(command: ChatCommand | TuiCommand): ChatCommand {
	if (command.kind === "chat") return command;
	return { ...command, kind: "chat" };
}

function recordChatEvent(context: ChatServiceContext, session: ReturnType<typeof createAgentSession>, type: "run_start" | "run_end" | "interrupted" | "error", payload: Record<string, unknown>): void {
	const event = {
		id: context.createId(),
		type,
		timestamp: context.now(),
		agentId: session.agent.id,
		taskId: session.task.id,
		sessionId: session.id,
		payload,
	} as TraceEvent;
	session.trace.push(event);
	try {
		void context.eventObserver?.(event);
	} catch {
		// UI observers must not affect chat turn execution.
	}
}

export async function createRuntimeForCommand(command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: ChatServiceDeps, subagents: SubagentSpec[] = [], memoryManager?: MemoryManager, modelClient = createModelClient(command, deps), eventObserver?: TraceEventObserver): Promise<AgentRuntime> {
	const toolRegistry = await createToolRegistry(command, deps);
	registerMemoryTools(toolRegistry, command, deps, memoryManager);
	const createToolRegistryForAgent = () => toolRegistryForAgent(toolRegistry, command, deps, memoryManager);
	return new AgentRuntime({
		modelClient,
		toolRegistry,
		createToolRegistryForAgent,
		...(memoryManager ? { memoryContextProvider: (session) => memoryManager.loadContext({ agentId: session.agent.id, sessionId: session.id, projectId: memoryProjectId(command), prompt: session.task.prompt, now: deps.now ?? Date.now }) } : {}),
		...(subagents.length > 0 ? { subagents } : {}),
		...(deps.now ? { now: deps.now } : {}),
		...(deps.createId ? { createId: deps.createId } : {}),
		...(command.kind === "chat" ? { getFollowUpMessages: createAutoContinueFollowUpProvider() } : {}),
		...(eventObserver ? { eventObserver } : {}),
		...(deps.workspaceRoot ? { toolResultStorageDir: path.join(deps.workspaceRoot, ".evolving-agent") } : {}),
	});
}

export async function loadAgentBundle(agentPath: string): Promise<{ agent: AgentSpec; subagents: SubagentSpec[] }> {
	const bundle = await loadAgentDefinitionsFromFile(agentPath);
	const agent = bundle.agents[0];
	if (!agent) throw new Error("agent bundle must include at least one agent");
	return { agent, subagents: bundle.subagents };
}

function createMemoryManager(agent: AgentSpec, command: ResolvedChatCommand, modelClient: ModelClient): MemoryManager | undefined {
	if (agent.runtime.memoryPolicy !== "long-term") return undefined;
	return new MemoryManager(new SqliteMemoryStore(path.join(chatStorageRoot(command), ".evolving-agent", "memory")), new LlmMemoryExtractor(modelClient, agent));
}

function registerMemoryTools(toolRegistry: ToolRegistry, command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: ChatServiceDeps, memoryManager?: MemoryManager): void {
	if (!memoryManager || toolRegistry.get("memory_context")) return;
	for (const tool of createMemoryTools({ manager: memoryManager, projectId: memoryProjectId(command), now: deps.now ?? Date.now, createId: deps.createId ?? (() => crypto.randomUUID()) })) {
		toolRegistry.register(tool);
	}
}

function createRuntime(command: ResolvedChatCommand, deps: ChatServiceDeps, subagents: SubagentSpec[], toolRegistry: ToolRegistry, memoryManager: MemoryManager | undefined, modelClient: ModelClient, eventObserver?: TraceEventObserver): AgentRuntime {
	const createToolRegistryForAgent = () => toolRegistryForAgent(toolRegistry, command, deps, memoryManager);
	const createId = deps.createId ?? (() => crypto.randomUUID());
	const now = deps.now ?? Date.now;
	return new AgentRuntime({
		modelClient,
		toolRegistry,
		createToolRegistryForAgent,
		...(memoryManager ? { memoryContextProvider: (session) => memoryManager.loadContext({ agentId: session.agent.id, sessionId: session.id, projectId: memoryProjectId(command), prompt: session.task.prompt, now }) } : {}),
		...(subagents.length > 0 ? { subagents } : {}),
		...(deps.now ? { now } : {}),
		...(deps.createId ? { createId } : {}),
		getFollowUpMessages: createAutoContinueFollowUpProvider(),
		...(eventObserver ? { eventObserver } : {}),
		...(deps.workspaceRoot ? { toolResultStorageDir: path.join(deps.workspaceRoot, ".evolving-agent") } : {}),
		...(memoryManager ? {
			onCompactionMemory: async (facts, session, compactionEntryId) => {
				const candidates = facts.map((fact) => ({
					layer: "knowledge" as const,
					content: fact,
					sourceRefs: [{
						kind: "trace_event" as const,
						id: compactionEntryId,
						sessionId: session.id,
						excerptHash: String(fact.length ^ fact.charCodeAt(0) ^ fact.charCodeAt(fact.length - 1)),
					}],
					metadata: { suitability: "long_term" as const },
				}));
				await memoryManager.recordCandidates(candidates, session.agent.id, now, createId);
			},
		} : {}),
	});
}

async function createToolRegistry(command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: ChatServiceDeps): Promise<ToolRegistry> {
	const workspaceRoot = deps.workspaceRoot ?? process.cwd();
	return deps.toolRegistry ?? createToolRegistryForProfileAsync({ profile: command.toolProfile, workspaceRoot, ...(deps.fetchFn ? { fetch: deps.fetchFn } : {}), ...(deps.enableTuiAutomationTools === false ? {} : { tuiAutomation: { deps } }), ...(command.mcpServers ? { mcpServers: command.mcpServers } : {}) });
}

function createChatToolRegistry(command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: ChatServiceDeps): ToolRegistry {
	const workspaceRoot = deps.workspaceRoot ?? process.cwd();
	return deps.toolRegistry ?? createToolRegistryWithBackgroundMcp({ profile: command.toolProfile, workspaceRoot, ...(deps.fetchFn ? { fetch: deps.fetchFn } : {}), ...(deps.enableTuiAutomationTools === false ? {} : { tuiAutomation: { deps } }), ...(command.mcpServers ? { mcpServers: command.mcpServers } : {}) });
}

function toolRegistryForAgent(baseRegistry: ToolRegistry, command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: ChatServiceDeps, memoryManager?: MemoryManager): ToolRegistry {
	const registry = deps.toolRegistry ?? baseRegistry.clone();
	registerMemoryTools(registry, command, deps, memoryManager);
	return registry;
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
	if (command.resumeSessionId && stored && !stored.startupContext) throw new Error(`session ${command.resumeSessionId} does not include startup context; provide --agent --provider --model --base-url once to upgrade it`);
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

function chatTask(command: ResolvedChatCommand, prompt: string): TaskSpec {
	return {
		id: `chat-${command.sessionId ?? command.resumeSessionId ?? "turn"}`,
		type: "general",
		title: "Chat",
		prompt,
		scoring: { method: "rubric", config: { contains: [] } },
	};
}

function chatSessionStore(command: ChatCommand, deps: ChatServiceDeps): AgentSessionStore {
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

function createModelClient(command: ResolvedChatCommand | RunCommand | BenchmarkCommand | EvolveCommand, deps: ChatServiceDeps): ModelClient {
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
