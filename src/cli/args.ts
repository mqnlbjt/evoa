import path from "node:path";
import type { ProviderFormat } from "../models/provider-types.js";
import type { BenchmarkReportFormat } from "../benchmark/report.js";
import type { EvolutionReportFormat } from "../evolution/report.js";
import { parseToolProfile, type ToolProfile } from "../tools/profiles.js";

export type OutputFormat = "human" | "json";

export interface CliDefaults {
	agentPath?: string;
	provider?: string;
	model?: string;
	baseURL?: string;
	apiKey?: string;
	providerFormat?: ProviderFormat;
	toolProfile?: ToolProfile;
	sessionDir?: string;
}

export interface CliProvidedFlags {
	agentPath?: boolean;
	provider?: boolean;
	model?: boolean;
	baseURL?: boolean;
	providerFormat?: boolean;
	toolProfile?: boolean;
	sessionDir?: boolean;
}

export type CliCommand = ModelsDiscoverCommand | ChatCommand | RunCommand | BenchmarkCommand | EvolveCommand | ReplayCommand | DiffCommand | HelpCommand;

export interface BaseCommand {
	format: OutputFormat;
	outputPath?: string;
	tracePath?: string;
}

export interface ModelsDiscoverCommand extends BaseCommand {
	kind: "models.discover";
	provider: string;
	baseURL: string;
	apiKey?: string;
	providerFormat: ProviderFormat;
}

export interface ChatCommand extends BaseCommand {
	kind: "chat";
	prompt?: string;
	agentPath?: string;
	provider?: string;
	model?: string;
	baseURL?: string;
	apiKey?: string;
	providerFormat: ProviderFormat;
	toolProfile: ToolProfile;
	sessionId?: string;
	resumeSessionId?: string;
	sessionDir?: string;
	providedFlags: CliProvidedFlags;
}

export interface RunCommand extends BaseCommand {
	kind: "run";
	agentPath: string;
	taskPath: string;
	provider: string;
	model: string;
	baseURL: string;
	apiKey?: string;
	providerFormat: ProviderFormat;
	toolProfile: ToolProfile;
}

export interface BenchmarkCommand extends BaseCommand {
	kind: "benchmark";
	agentPath: string;
	suitePath: string;
	provider: string;
	model: string;
	baseURL: string;
	apiKey?: string;
	providerFormat: ProviderFormat;
	toolProfile: ToolProfile;
	reportFormat: BenchmarkReportFormat;
	reportPath?: string;
}

export interface EvolveCommand extends BaseCommand {
	kind: "evolve";
	baselineAgentPath: string;
	candidateAgentPath: string;
	suitePath: string;
	provider: string;
	model: string;
	baseURL: string;
	apiKey?: string;
	providerFormat: ProviderFormat;
	toolProfile: ToolProfile;
	reportFormat: EvolutionReportFormat;
	reportPath?: string;
	historyPath?: string;
}

export interface ReplayCommand extends BaseCommand {
	kind: "replay";
	tracePath: string;
	runId?: string;
}

export interface DiffCommand extends BaseCommand {
	kind: "diff";
	leftPath: string;
	rightPath: string;
}

export interface HelpCommand {
	kind: "help";
	format: OutputFormat;
}

export interface ParseResult {
	command?: CliCommand;
	diagnostics: string[];
}

type FlagValues = Record<string, string | boolean>;

const valueFlags = new Set(["--provider", "--model", "--base-url", "--api-key", "--provider-format", "--tool-profile", "--report", "--report-format", "--history", "--format", "--output", "--trace", "--run-id", "--left", "--right", "--agent", "--baseline-agent", "--candidate-agent", "--task", "--suite", "--session", "--resume", "--session-dir", "--config"]);
const booleanFlags = new Set(["--json", "--help"]);

export function parseCliArgs(args: string[], defaults: CliDefaults = {}): ParseResult {
	const diagnostics: string[] = [];
	if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
		return { command: { kind: "help", format: "human" }, diagnostics };
	}

	const commandParts = parseCommandParts(args);
	if (!commandParts) {
		return { diagnostics: [`unknown command ${args[0]}`] };
	}

	const parsedArgs = commandParts.kind === "chat" ? parseChatArgs(args.slice(commandParts.consumed), diagnostics) : { flags: parseFlags(args.slice(commandParts.consumed), diagnostics) };
	const flags = parsedArgs.flags;
	const format = parseOutputFormat(flags, diagnostics);
	const resolvedDefaults = defaults;
	const common = commonCommandFields(flags, format, diagnostics, resolvedDefaults);

	if (flags["--help"] === true) {
		return { command: { kind: "help", format }, diagnostics };
	}

	if (commandParts.kind === "models.discover") {
		return parseCommandResult(buildModelsDiscover(flags, common, resolvedDefaults, diagnostics), diagnostics);
	}
	if (commandParts.kind === "chat") {
		return parseCommandResult(buildChat(flags, parsedArgs.prompt, common, resolvedDefaults, diagnostics), diagnostics);
	}
	if (commandParts.kind === "run") {
		return parseCommandResult(buildRun(flags, common, resolvedDefaults, diagnostics), diagnostics);
	}
	if (commandParts.kind === "benchmark") {
		return parseCommandResult(buildBenchmark(flags, common, resolvedDefaults, diagnostics), diagnostics);
	}
	if (commandParts.kind === "evolve") {
		return parseCommandResult(buildEvolve(flags, common, resolvedDefaults, diagnostics), diagnostics);
	}
	if (commandParts.kind === "replay") {
		return parseCommandResult(buildReplay(flags, common, diagnostics), diagnostics);
	}
	return parseCommandResult(buildDiff(flags, common, diagnostics), diagnostics);
}

export function helpText(): string {
	return `evolving-agent

Usage:
  evolving-agent models discover --provider <id> --base-url <url> [--api-key <key>] [--config <file>] [--json]
  evolving-agent chat "<prompt>" [--agent <file>] [--provider <id>] [--model <id>] [--base-url <url>] [--session <id>|--resume <id>] [--api-key <key>] [--tool-profile <profile>] [--config <file>] [--json]
  evolving-agent chat [--agent <file>] [--provider <id>] [--model <id>] [--base-url <url>] [--session <id>|--resume <id>] [--api-key <key>] [--tool-profile <profile>] [--config <file>]
  evolving-agent run [--agent <file>] --task <file> [--provider <id>] [--model <id>] [--base-url <url>] [--api-key <key>] [--tool-profile <profile>] [--config <file>] [--json]
  evolving-agent benchmark --suite <file> [--agent <file>] [--provider <id>] [--model <id>] [--base-url <url>] [--api-key <key>] [--tool-profile <profile>] [--report <file>] [--report-format <json|markdown>] [--config <file>] [--json]
  evolving-agent evolve --suite <file> --baseline-agent <file> --candidate-agent <file> [--provider <id>] [--model <id>] [--base-url <url>] [--api-key <key>] [--tool-profile <profile>] [--report <file>] [--report-format <json|markdown>] [--history <file>] [--config <file>] [--json]
  evolving-agent replay --trace <file> [--run-id <id>] [--json]
  evolving-agent diff --left <file> --right <file> [--json]

Options:
  --provider <id>
  --model <id>
  --base-url <url>
  --api-key <key>
  --provider-format <openai-responses|anthropic-messages>
  --tool-profile <read-only|coding|benchmark-sandbox|dangerous>
  --report <file>
  --report-format <json|markdown>
  --history <file>
  --session <id>
  --resume <id>
  --session-dir <dir>
  --config <file>
  --format <human|json>
  --json
  --output <file>
  --trace <file>
  --run-id <id>
  --left <file>
  --right <file>
  --help
`;
}

function parseCommandParts(args: string[]): { kind: CliCommand["kind"]; consumed: number } | undefined {
	if (args[0] === "models" && args[1] === "discover") return { kind: "models.discover", consumed: 2 };
	if (args[0] === "chat") return { kind: "chat", consumed: 1 };
	if (args[0] === "run") return { kind: "run", consumed: 1 };
	if (args[0] === "benchmark") return { kind: "benchmark", consumed: 1 };
	if (args[0] === "evolve") return { kind: "evolve", consumed: 1 };
	if (args[0] === "replay") return { kind: "replay", consumed: 1 };
	if (args[0] === "diff") return { kind: "diff", consumed: 1 };
	return undefined;
}

function parseFlags(args: string[], diagnostics: string[]): FlagValues {
	const flags: FlagValues = {};
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		if (!flag?.startsWith("--")) {
			diagnostics.push(`unexpected argument ${flag}`);
			continue;
		}
		if (booleanFlags.has(flag)) {
			flags[flag] = true;
			continue;
		}
		if (!valueFlags.has(flag)) {
			diagnostics.push(`unknown option ${flag}`);
			continue;
		}
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) {
			diagnostics.push(`missing value for ${flag}`);
			continue;
		}
		flags[flag] = value;
		index += 1;
	}
	return flags;
}

function parseChatArgs(args: string[], diagnostics: string[]): { flags: FlagValues; prompt?: string } {
	const flagArgs: string[] = [];
	let prompt: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index];
		if (value?.startsWith("--")) {
			flagArgs.push(value);
			if (!booleanFlags.has(value)) {
				const next = args[index + 1];
				if (next !== undefined) {
					flagArgs.push(next);
					index += 1;
				}
			}
			continue;
		}
		if (prompt === undefined) {
			prompt = value;
			continue;
		}
		diagnostics.push(`unexpected argument ${value}`);
	}
	return { flags: parseFlags(flagArgs, diagnostics), ...(prompt ? { prompt } : {}) };
}

function parseOutputFormat(flags: FlagValues, diagnostics: string[]): OutputFormat {
	if (flags["--json"] === true) return "json";
	const format = flags["--format"];
	if (format === undefined) return "human";
	if (format !== "human" && format !== "json") {
		diagnostics.push("--format must be human or json");
		return "human";
	}
	return format;
}

function commonCommandFields(flags: FlagValues, format: OutputFormat, diagnostics: string[], defaults: CliDefaults = {}): BaseCommand & { providerFormat: ProviderFormat } {
	const providerFormatValue = optionValue(flags, "--provider-format", defaults.providerFormat) ?? "openai-responses";
	const providerFormat = parseProviderFormat(providerFormatValue, diagnostics);
	const outputPath = stringFlag(flags, "--output");
	const tracePath = stringFlag(flags, "--trace");
	return {
		format,
		providerFormat,
		...(outputPath ? { outputPath } : {}),
		...(tracePath ? { tracePath } : {}),
	};
}

function buildModelsDiscover(
	flags: FlagValues,
	common: BaseCommand & { providerFormat: ProviderFormat },
	defaults: CliDefaults,
	diagnostics: string[],
): ModelsDiscoverCommand | undefined {
	const provider = requiredOption(flags, "--provider", defaults.provider, diagnostics);
	const baseURL = requiredOption(flags, "--base-url", defaults.baseURL, diagnostics);
	if (!provider || !baseURL) return undefined;
	const apiKey = optionValue(flags, "--api-key", defaults.apiKey);
	return {
		kind: "models.discover",
		provider,
		baseURL,
		providerFormat: common.providerFormat,
		format: common.format,
		...(apiKey ? { apiKey } : {}),
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function buildChat(flags: FlagValues, prompt: string | undefined, common: BaseCommand & { providerFormat: ProviderFormat }, defaults: CliDefaults, diagnostics: string[]): ChatCommand | undefined {
	const sessionId = stringFlag(flags, "--session");
	const resumeSessionId = stringFlag(flags, "--resume");
	const agentPath = chatOption(flags, "--agent", defaults.agentPath, !resumeSessionId, diagnostics);
	const provider = chatOption(flags, "--provider", defaults.provider, !resumeSessionId, diagnostics);
	const model = chatOption(flags, "--model", defaults.model, !resumeSessionId, diagnostics);
	const baseURL = chatOption(flags, "--base-url", defaults.baseURL, !resumeSessionId, diagnostics);
	if (!resumeSessionId && (!agentPath || !provider || !model || !baseURL)) return undefined;
	const apiKey = optionValue(flags, "--api-key", defaults.apiKey);
	const toolProfile = toolProfileFlag(flags, defaults, diagnostics);
	const sessionDir = optionValue(flags, "--session-dir", defaults.sessionDir);
	if (sessionId && resumeSessionId) diagnostics.push("--session and --resume cannot be used together");
	return {
		kind: "chat",
		...(prompt ? { prompt } : {}),
		...(agentPath ? { agentPath } : {}),
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(baseURL ? { baseURL } : {}),
		providerFormat: common.providerFormat,
		toolProfile,
		format: common.format,
		...(apiKey ? { apiKey } : {}),
		...(sessionId ? { sessionId } : {}),
		...(resumeSessionId ? { resumeSessionId } : {}),
		...(sessionDir ? { sessionDir } : {}),
		providedFlags: chatProvidedFlags(flags),
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function buildRun(flags: FlagValues, common: BaseCommand & { providerFormat: ProviderFormat }, defaults: CliDefaults, diagnostics: string[]): RunCommand | undefined {
	const agentPath = requiredOption(flags, "--agent", defaults.agentPath, diagnostics);
	const taskPath = requireFlag(flags, "--task", diagnostics);
	const provider = requiredOption(flags, "--provider", defaults.provider, diagnostics);
	const model = requiredOption(flags, "--model", defaults.model, diagnostics);
	const baseURL = requiredOption(flags, "--base-url", defaults.baseURL, diagnostics);
	if (!agentPath || !taskPath || !provider || !model || !baseURL) return undefined;
	const apiKey = optionValue(flags, "--api-key", defaults.apiKey);
	const toolProfile = toolProfileFlag(flags, defaults, diagnostics);
	return {
		kind: "run",
		agentPath,
		taskPath,
		provider,
		model,
		baseURL,
		providerFormat: common.providerFormat,
		toolProfile,
		format: common.format,
		...(apiKey ? { apiKey } : {}),
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function buildBenchmark(
	flags: FlagValues,
	common: BaseCommand & { providerFormat: ProviderFormat },
	defaults: CliDefaults,
	diagnostics: string[],
): BenchmarkCommand | undefined {
	const agentPath = requiredOption(flags, "--agent", defaults.agentPath, diagnostics);
	const suitePath = requireFlag(flags, "--suite", diagnostics);
	const provider = requiredOption(flags, "--provider", defaults.provider, diagnostics);
	const model = requiredOption(flags, "--model", defaults.model, diagnostics);
	const baseURL = requiredOption(flags, "--base-url", defaults.baseURL, diagnostics);
	if (!agentPath || !suitePath || !provider || !model || !baseURL) return undefined;
	const apiKey = optionValue(flags, "--api-key", defaults.apiKey);
	const toolProfile = toolProfileFlag(flags, defaults, diagnostics);
	const reportPath = stringFlag(flags, "--report");
	const reportFormat = reportFormatFlag(flags, reportPath, diagnostics);
	return {
		kind: "benchmark",
		agentPath,
		suitePath,
		provider,
		model,
		baseURL,
		providerFormat: common.providerFormat,
		toolProfile,
		reportFormat,
		format: common.format,
		...(apiKey ? { apiKey } : {}),
		...(reportPath ? { reportPath } : {}),
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function buildEvolve(
	flags: FlagValues,
	common: BaseCommand & { providerFormat: ProviderFormat },
	defaults: CliDefaults,
	diagnostics: string[],
): EvolveCommand | undefined {
	const baselineAgentPath = requireFlag(flags, "--baseline-agent", diagnostics);
	const candidateAgentPath = requireFlag(flags, "--candidate-agent", diagnostics);
	const suitePath = requireFlag(flags, "--suite", diagnostics);
	const provider = requiredOption(flags, "--provider", defaults.provider, diagnostics);
	const model = requiredOption(flags, "--model", defaults.model, diagnostics);
	const baseURL = requiredOption(flags, "--base-url", defaults.baseURL, diagnostics);
	if (!baselineAgentPath || !candidateAgentPath || !suitePath || !provider || !model || !baseURL) return undefined;
	const apiKey = optionValue(flags, "--api-key", defaults.apiKey);
	const toolProfile = toolProfileFlag(flags, defaults, diagnostics);
	const reportPath = stringFlag(flags, "--report");
	const reportFormat = reportFormatFlag(flags, reportPath, diagnostics);
	const historyPath = stringFlag(flags, "--history");
	return {
		kind: "evolve",
		baselineAgentPath,
		candidateAgentPath,
		suitePath,
		provider,
		model,
		baseURL,
		providerFormat: common.providerFormat,
		toolProfile,
		reportFormat,
		format: common.format,
		...(apiKey ? { apiKey } : {}),
		...(reportPath ? { reportPath } : {}),
		...(historyPath ? { historyPath } : {}),
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function buildReplay(flags: FlagValues, common: BaseCommand & { providerFormat: ProviderFormat }, diagnostics: string[]): ReplayCommand | undefined {
	const tracePath = requireFlag(flags, "--trace", diagnostics);
	if (!tracePath) return undefined;
	const runId = stringFlag(flags, "--run-id");
	return {
		kind: "replay",
		tracePath,
		format: common.format,
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(runId ? { runId } : {}),
	};
}

function buildDiff(flags: FlagValues, common: BaseCommand & { providerFormat: ProviderFormat }, diagnostics: string[]): DiffCommand | undefined {
	const leftPath = requireFlag(flags, "--left", diagnostics);
	const rightPath = requireFlag(flags, "--right", diagnostics);
	if (!leftPath || !rightPath) return undefined;
	return {
		kind: "diff",
		leftPath,
		rightPath,
		format: common.format,
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function parseCommandResult(command: CliCommand | undefined, diagnostics: string[]): ParseResult {
	return command ? { command, diagnostics } : { diagnostics };
}

function apiKeyFlag(flags: FlagValues): string | undefined {
	return stringFlag(flags, "--api-key");
}

function toolProfileFlag(flags: FlagValues, defaults: CliDefaults, diagnostics: string[]): ToolProfile {
	const value = optionValue(flags, "--tool-profile", defaults.toolProfile);
	if (value === undefined) return "read-only";
	const profile = parseToolProfile(value);
	if (profile) return profile;
	diagnostics.push("--tool-profile must be read-only, coding, benchmark-sandbox, or dangerous");
	return "read-only";
}

function reportFormatFlag(flags: FlagValues, reportPath: string | undefined, diagnostics: string[]): BenchmarkReportFormat {
	const value = stringFlag(flags, "--report-format");
	if (value === "json" || value === "markdown") return value;
	if (value !== undefined) diagnostics.push("--report-format must be json or markdown");
	return inferReportFormat(reportPath);
}

function inferReportFormat(reportPath: string | undefined): BenchmarkReportFormat {
	const extension = reportPath ? path.extname(reportPath).toLowerCase() : "";
	if (extension === ".md" || extension === ".markdown") return "markdown";
	return "json";
}

function parseProviderFormat(value: string, diagnostics: string[]): ProviderFormat {
	if (value === "openai-responses" || value === "anthropic-messages") return value;
	diagnostics.push("--provider-format must be openai-responses or anthropic-messages");
	return "openai-responses";
}

function chatOption(flags: FlagValues, flag: string, fallback: string | undefined, required: boolean, diagnostics: string[]): string | undefined {
	return required ? requiredOption(flags, flag, fallback, diagnostics) : optionValue(flags, flag, fallback);
}

function chatProvidedFlags(flags: FlagValues): CliProvidedFlags {
	return {
		...(hasFlag(flags, "--agent") ? { agentPath: true } : {}),
		...(hasFlag(flags, "--provider") ? { provider: true } : {}),
		...(hasFlag(flags, "--model") ? { model: true } : {}),
		...(hasFlag(flags, "--base-url") ? { baseURL: true } : {}),
		...(hasFlag(flags, "--provider-format") ? { providerFormat: true } : {}),
		...(hasFlag(flags, "--tool-profile") ? { toolProfile: true } : {}),
		...(hasFlag(flags, "--session-dir") ? { sessionDir: true } : {}),
	};
}

function hasFlag(flags: FlagValues, flag: string): boolean {
	return flags[flag] !== undefined;
}

function requireFlag(flags: FlagValues, flag: string, diagnostics: string[]): string | undefined {
	return requiredOption(flags, flag, undefined, diagnostics);
}

function requiredOption(flags: FlagValues, flag: string, fallback: string | undefined, diagnostics: string[]): string | undefined {
	const value = optionValue(flags, flag, fallback);
	if (!value) diagnostics.push(`missing required option ${flag}`);
	return value;
}

function optionValue(flags: FlagValues, flag: string, fallback: string | undefined): string | undefined {
	return stringFlag(flags, flag) ?? fallback;
}

export function configPathFromArgs(args: string[]): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--config") return args[index + 1]?.startsWith("--") ? undefined : args[index + 1];
	}
	return undefined;
}

function stringFlag(flags: FlagValues, flag: string): string | undefined {
	const value = flags[flag];
	return typeof value === "string" ? value : undefined;
}
