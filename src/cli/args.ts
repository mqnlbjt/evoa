import path from "node:path";
import type {
	ProviderConfig,
	ProviderFormat,
} from "../models/provider-types.js";
import type { ModelRoutingSpec } from "../specs.js";
import { parseTokenBudgetSyntax } from "../runtime/token-budget.js";
import type { BenchmarkReportFormat } from "../benchmark/report.js";
import type { EvolutionReportFormat } from "../evolution/report.js";
import type { McpServersConfig } from "../mcp/types.js";
import { parseToolProfile, type ToolProfile } from "../tools/profiles.js";

export type OutputFormat = "human" | "json";

export interface CliDefaults {
	agentPath?: string;
	provider?: string;
	model?: string;
	baseURL?: string;
	apiKey?: string;
	providerFormat?: ProviderFormat;
	providers?: Record<string, ProviderConfig>;
	modelRouting?: ModelRoutingSpec;
	toolProfile?: ToolProfile;
	sessionDir?: string;
	mcpServers?: McpServersConfig;
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

export type CliCommand =
	| ModelsDiscoverCommand
	| McpStatusCommand
	| McpDiagnosticsCommand
	| ChatCommand
	| TuiCommand
	| RunCommand
	| BenchmarkCommand
	| EvolveCommand
	| ReplayCommand
	| DiffCommand
	| HelpCommand
	| SopListCommand
	| SopRunCommand
	| SopImportCommand
	| SopDepositCommand;

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

export interface ModelRoutingCommandFields {
	providers?: Record<string, ProviderConfig>;
	modelRouting?: ModelRoutingSpec;
}

export interface McpCommandFields {
	mcpServers?: McpServersConfig;
}

export interface McpStatusCommand extends BaseCommand, McpCommandFields {
	kind: "mcp.status";
}

export interface McpDiagnosticsCommand extends BaseCommand, McpCommandFields {
	kind: "mcp.diagnostics";
}

export interface ChatCommand
	extends BaseCommand,
		McpCommandFields,
		ModelRoutingCommandFields {
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
	tokenBudget?: number;
	providedFlags: CliProvidedFlags;
}

export interface TuiCommand extends Omit<ChatCommand, "kind" | "prompt"> {
	kind: "tui";
}

export interface RunCommand
	extends BaseCommand,
		McpCommandFields,
		ModelRoutingCommandFields {
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

export interface BenchmarkCommand
	extends BaseCommand,
		McpCommandFields,
		ModelRoutingCommandFields {
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

export interface EvolveCommand
	extends BaseCommand,
		McpCommandFields,
		ModelRoutingCommandFields {
	kind: "evolve";
	baselineAgentPath?: string;
	candidateAgentPath?: string;
	suitePath?: string;
	provider: string;
	model: string;
	baseURL: string;
	apiKey?: string;
	providerFormat: ProviderFormat;
	toolProfile: ToolProfile;
	reportFormat: EvolutionReportFormat;
	reportPath?: string;
	historyPath?: string;
	listHistory?: boolean;
	autoIterations?: number;
	generatePath?: string;
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

export interface SopListCommand extends BaseCommand {
	kind: "sop.list";
	sopDir: string;
}

export interface SopRunCommand extends BaseCommand {
	kind: "sop.run";
	sopId: string;
	sopDir: string;
}

export interface SopImportCommand extends BaseCommand {
	kind: "sop.import";
	inputPath: string;
	outputDir: string;
}

export interface SopDepositCommand extends BaseCommand {
	kind: "sop.deposit";
	sopDir: string;
	skillBankPath?: string;
	force?: boolean;
}

export interface ParseResult {
	command?: CliCommand;
	diagnostics: string[];
}

type FlagValues = Record<string, string | boolean>;

const valueFlags = new Set([
	"--provider",
	"--model",
	"--base-url",
	"--api-key",
	"--provider-format",
	"--tool-profile",
	"--report",
	"--report-format",
	"--history",
	"--format",
	"--output",
	"--trace",
	"--run-id",
	"--left",
	"--right",
	"--agent",
	"--baseline-agent",
	"--candidate-agent",
	"--task",
	"--suite",
	"--session",
	"--resume",
	"--session-dir",
	"--sop-dir",
	"--output-dir",
	"--skill-bank",
	"--config",
	"--auto",
	"--generate",
]);
const booleanFlags = new Set(["--json", "--help", "--force", "--list"]);

export function parseCliArgs(
	args: string[],
	defaults: CliDefaults = {},
): ParseResult {
	const diagnostics: string[] = [];
	if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
		return { command: { kind: "help", format: "human" }, diagnostics };
	}

	const commandParts = parseCommandParts(args);
	if (!commandParts) {
		return { diagnostics: [`unknown command ${args[0]}`] };
	}

	const parsedArgs =
		commandParts.kind === "chat"
			? parseChatArgs(args.slice(commandParts.consumed), diagnostics)
			: commandParts.kind === "sop.run"
				? parseSopRunArgs(args.slice(commandParts.consumed), diagnostics)
				: commandParts.kind === "sop.import"
					? parseSopImportArgs(args.slice(commandParts.consumed), diagnostics)
					: {
							flags: parseFlags(args.slice(commandParts.consumed), diagnostics),
						};
	const flags = parsedArgs.flags;
	const format = parseOutputFormat(flags, diagnostics);
	const resolvedDefaults = defaults;
	const common = commonCommandFields(
		flags,
		format,
		diagnostics,
		resolvedDefaults,
	);

	if (flags["--help"] === true) {
		return { command: { kind: "help", format }, diagnostics };
	}

	if (commandParts.kind === "models.discover") {
		return parseCommandResult(
			buildModelsDiscover(flags, common, resolvedDefaults, diagnostics),
			diagnostics,
		);
	}
	if (commandParts.kind === "mcp.status") {
		return parseCommandResult(
			buildMcpStatus(common, resolvedDefaults),
			diagnostics,
		);
	}
	if (commandParts.kind === "mcp.diagnostics") {
		return parseCommandResult(
			buildMcpDiagnostics(common, resolvedDefaults),
			diagnostics,
		);
	}
	if (commandParts.kind === "chat") {
		const prompt = (parsedArgs as { prompt?: string }).prompt;
		return parseCommandResult(
			buildChat(flags, prompt, common, resolvedDefaults, diagnostics),
			diagnostics,
		);
	}
	if (commandParts.kind === "tui") {
		return parseCommandResult(
			buildTui(flags, common, resolvedDefaults, diagnostics),
			diagnostics,
		);
	}
	if (commandParts.kind === "run") {
		return parseCommandResult(
			buildRun(flags, common, resolvedDefaults, diagnostics),
			diagnostics,
		);
	}
	if (commandParts.kind === "benchmark") {
		return parseCommandResult(
			buildBenchmark(flags, common, resolvedDefaults, diagnostics),
			diagnostics,
		);
	}
	if (commandParts.kind === "evolve") {
		return parseCommandResult(
			buildEvolve(flags, common, resolvedDefaults, diagnostics),
			diagnostics,
		);
	}
	if (commandParts.kind === "replay") {
		return parseCommandResult(
			buildReplay(flags, common, diagnostics),
			diagnostics,
		);
	}
	if (commandParts.kind === "sop.list") {
		return parseCommandResult(
			buildSopList(flags, common, diagnostics),
			diagnostics,
		);
	}
	if (commandParts.kind === "sop.run") {
		const sopId = (parsedArgs as { sopId?: string }).sopId;
		return parseCommandResult(
			buildSopRun(flags, sopId, common, diagnostics),
			diagnostics,
		);
	}
	if (commandParts.kind === "sop.import") {
		const positional = (parsedArgs as { positional?: string }).positional;
		return parseCommandResult(
			buildSopImport(flags, positional, common, diagnostics),
			diagnostics,
		);
	}
	if (commandParts.kind === "sop.deposit") {
		return parseCommandResult(
			buildSopDeposit(flags, common, diagnostics),
			diagnostics,
		);
	}
	return parseCommandResult(buildDiff(flags, common, diagnostics), diagnostics);
}

export function helpText(): string {
	return `evoa

Usage:
  evoa models discover --provider <id> --base-url <url> [--api-key <key>] [--config <file>] [--json]
  evoa mcp status [--config <file>] [--json]
  evoa mcp diagnostics [--config <file>] [--json]
  evoa chat "<prompt>" [--agent <file>] [--provider <id>] [--model <id>] [--base-url <url>] [--session <id>|--resume <id>] [--api-key <key>] [--tool-profile <profile>] [--config <file>] [--json]
  evoa chat [--agent <file>] [--provider <id>] [--model <id>] [--base-url <url>] [--session <id>|--resume <id>] [--api-key <key>] [--tool-profile <profile>] [--config <file>]
  evoa tui [--agent <file>] [--provider <id>] [--model <id>] [--base-url <url>] [--session <id>|--resume <id>] [--api-key <key>] [--tool-profile <profile>] [--config <file>]
  evoa run [--agent <file>] --task <file> [--provider <id>] [--model <id>] [--base-url <url>] [--api-key <key>] [--tool-profile <profile>] [--config <file>] [--json]
  evoa benchmark --suite <file> [--agent <file>] [--provider <id>] [--model <id>] [--base-url <url>] [--api-key <key>] [--tool-profile <profile>] [--report <file>] [--report-format <json|markdown>] [--config <file>] [--json]
  evoa evolve --suite <file> --baseline-agent <file> --candidate-agent <file> [--provider <id>] [--model <id>] [--base-url <url>] [--api-key <key>] [--tool-profile <profile>] [--report <file>] [--report-format <json|markdown>] [--history <file>] [--config <file>] [--json]
  evoa evolve --history <file> --list [--json]
  evoa evolve --suite <file> --baseline-agent <file> --generate <file> [--auto <N>] [--provider <id>] [--model <id>] [--base-url <url>] [--api-key <key>] [--tool-profile <profile>] [--report <file>] [--history <file>] [--config <file>] [--json]
  evoa replay --trace <file> [--run-id <id>] [--json]
  evoa diff --left <file> --right <file> [--json]
  evoa sop list [--sop-dir <dir>] [--json]
  evoa sop run <id> [--sop-dir <dir>] [--json]

Options:
  --provider <id>
  --model <id>
  --base-url <url>
  --api-key <key>
  --provider-format <openai-responses|openai-chat|anthropic-messages>
  --tool-profile <read-only|coding|benchmark-sandbox|dangerous>
  --report <file>
  --report-format <json|markdown>
  --history <file>
  --session <id>
  --resume <id>
  --session-dir <dir>
  --sop-dir <dir>
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

function parseCommandParts(
	args: string[],
): { kind: CliCommand["kind"]; consumed: number } | undefined {
	if (args[0] === "models" && args[1] === "discover")
		return { kind: "models.discover", consumed: 2 };
	if (args[0] === "mcp" && args[1] === "status")
		return { kind: "mcp.status", consumed: 2 };
	if (args[0] === "mcp" && args[1] === "diagnostics")
		return { kind: "mcp.diagnostics", consumed: 2 };
	if (args[0] === "chat") return { kind: "chat", consumed: 1 };
	if (args[0] === "tui") return { kind: "tui", consumed: 1 };
	if (args[0] === "run") return { kind: "run", consumed: 1 };
	if (args[0] === "benchmark") return { kind: "benchmark", consumed: 1 };
	if (args[0] === "evolve") return { kind: "evolve", consumed: 1 };
	if (args[0] === "replay") return { kind: "replay", consumed: 1 };
	if (args[0] === "diff") return { kind: "diff", consumed: 1 };
	if (args[0] === "sop" && args[1] === "list")
		return { kind: "sop.list", consumed: 2 };
	if (args[0] === "sop" && args[1] === "run")
		return { kind: "sop.run", consumed: 2 };
	if (args[0] === "sop" && args[1] === "import")
		return { kind: "sop.import", consumed: 2 };
	if (args[0] === "sop" && args[1] === "deposit")
		return { kind: "sop.deposit", consumed: 2 };
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

function parseChatArgs(
	args: string[],
	diagnostics: string[],
): { flags: FlagValues; prompt?: string } {
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
	return {
		flags: parseFlags(flagArgs, diagnostics),
		...(prompt ? { prompt } : {}),
	};
}

function parseOutputFormat(
	flags: FlagValues,
	diagnostics: string[],
): OutputFormat {
	if (flags["--json"] === true) return "json";
	const format = flags["--format"];
	if (format === undefined) return "human";
	if (format !== "human" && format !== "json") {
		diagnostics.push("--format must be human or json");
		return "human";
	}
	return format;
}

function commonCommandFields(
	flags: FlagValues,
	format: OutputFormat,
	diagnostics: string[],
	defaults: CliDefaults = {},
): BaseCommand & { providerFormat: ProviderFormat } {
	const providerFormatValue =
		optionValue(flags, "--provider-format", defaults.providerFormat) ??
		"openai-responses";
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
	const provider = requiredOption(
		flags,
		"--provider",
		defaults.provider,
		diagnostics,
	);
	const baseURL = requiredOption(
		flags,
		"--base-url",
		defaults.baseURL,
		diagnostics,
	);
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

function buildMcpStatus(
	common: BaseCommand & { providerFormat: ProviderFormat },
	defaults: CliDefaults,
): McpStatusCommand {
	return {
		kind: "mcp.status",
		format: common.format,
		...(defaults.mcpServers ? { mcpServers: defaults.mcpServers } : {}),
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function buildMcpDiagnostics(
	common: BaseCommand & { providerFormat: ProviderFormat },
	defaults: CliDefaults,
): McpDiagnosticsCommand {
	return {
		kind: "mcp.diagnostics",
		format: common.format,
		...(defaults.mcpServers ? { mcpServers: defaults.mcpServers } : {}),
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function buildChat(
	flags: FlagValues,
	prompt: string | undefined,
	common: BaseCommand & { providerFormat: ProviderFormat },
	defaults: CliDefaults,
	diagnostics: string[],
): ChatCommand | undefined {
	const sessionId = stringFlag(flags, "--session");
	const resumeSessionId = stringFlag(flags, "--resume");
	const agentPath = chatOption(
		flags,
		"--agent",
		defaults.agentPath,
		!resumeSessionId,
		diagnostics,
	);
	const provider = chatOption(
		flags,
		"--provider",
		defaults.provider,
		!resumeSessionId,
		diagnostics,
	);
	const model = chatOption(
		flags,
		"--model",
		defaults.model,
		!resumeSessionId,
		diagnostics,
	);
	const baseURL = chatOption(
		flags,
		"--base-url",
		defaults.baseURL,
		!resumeSessionId,
		diagnostics,
	);
	if (!resumeSessionId && (!agentPath || !provider || !model || !baseURL))
		return undefined;
	const apiKey = optionValue(flags, "--api-key", defaults.apiKey);
	const toolProfile = toolProfileFlag(flags, defaults, diagnostics);
	const sessionDir = optionValue(flags, "--session-dir", defaults.sessionDir);
	const tokenBudget = parseBudgetFlag(flags);
	if (sessionId && resumeSessionId)
		diagnostics.push("--session and --resume cannot be used together");
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
		...(tokenBudget === undefined ? {} : { tokenBudget }),
		providedFlags: chatProvidedFlags(flags),
		...(defaults.mcpServers ? { mcpServers: defaults.mcpServers } : {}),
		...(defaults.providers ? { providers: defaults.providers } : {}),
		...(defaults.modelRouting ? { modelRouting: defaults.modelRouting } : {}),
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function buildTui(
	flags: FlagValues,
	common: BaseCommand & { providerFormat: ProviderFormat },
	defaults: CliDefaults,
	diagnostics: string[],
): TuiCommand | undefined {
	const chat = buildChat(flags, undefined, common, defaults, diagnostics);
	if (!chat) return undefined;
	const { kind: _kind, prompt: _prompt, ...rest } = chat;
	return { ...rest, kind: "tui" };
}

function buildRun(
	flags: FlagValues,
	common: BaseCommand & { providerFormat: ProviderFormat },
	defaults: CliDefaults,
	diagnostics: string[],
): RunCommand | undefined {
	const agentPath = requiredOption(
		flags,
		"--agent",
		defaults.agentPath,
		diagnostics,
	);
	const taskPath = requireFlag(flags, "--task", diagnostics);
	const provider = requiredOption(
		flags,
		"--provider",
		defaults.provider,
		diagnostics,
	);
	const model = requiredOption(flags, "--model", defaults.model, diagnostics);
	const baseURL = requiredOption(
		flags,
		"--base-url",
		defaults.baseURL,
		diagnostics,
	);
	if (!agentPath || !taskPath || !provider || !model || !baseURL)
		return undefined;
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
		...(defaults.mcpServers ? { mcpServers: defaults.mcpServers } : {}),
		...(defaults.providers ? { providers: defaults.providers } : {}),
		...(defaults.modelRouting ? { modelRouting: defaults.modelRouting } : {}),
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
	const agentPath = requiredOption(
		flags,
		"--agent",
		defaults.agentPath,
		diagnostics,
	);
	const suitePath = requireFlag(flags, "--suite", diagnostics);
	const provider = requiredOption(
		flags,
		"--provider",
		defaults.provider,
		diagnostics,
	);
	const model = requiredOption(flags, "--model", defaults.model, diagnostics);
	const baseURL = requiredOption(
		flags,
		"--base-url",
		defaults.baseURL,
		diagnostics,
	);
	if (!agentPath || !suitePath || !provider || !model || !baseURL)
		return undefined;
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
		...(defaults.mcpServers ? { mcpServers: defaults.mcpServers } : {}),
		...(defaults.providers ? { providers: defaults.providers } : {}),
		...(defaults.modelRouting ? { modelRouting: defaults.modelRouting } : {}),
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
	const listHistory = booleanFlag(flags, "--list");
	const autoValue = stringFlag(flags, "--auto");
	const autoIterations = autoValue
		? parsePositiveInt(autoValue, diagnostics, "--auto")
		: undefined;
	const generatePath = stringFlag(flags, "--generate");
	const historyPath = stringFlag(flags, "--history");

	// --list mode: only needs --history
	if (listHistory) {
		if (!historyPath) {
			diagnostics.push("--list requires --history <file>");
			return undefined;
		}
		return {
			kind: "evolve",
			listHistory: true,
			historyPath,
			provider: defaults.provider ?? "openai",
			model: defaults.model ?? "gpt-4o",
			baseURL: defaults.baseURL ?? "https://api.openai.com/v1",
			providerFormat: common.providerFormat,
			toolProfile: toolProfileFlag(flags, defaults, diagnostics),
			reportFormat: reportFormatFlag(
				flags,
				stringFlag(flags, "--report"),
				diagnostics,
			),
			format: common.format,
			...(defaults.mcpServers ? { mcpServers: defaults.mcpServers } : {}),
		};
	}

	// --auto mode: needs --baseline-agent, --suite, --generate, --auto N
	if (autoIterations !== undefined) {
		const baselineAgentPath = requireFlag(
			flags,
			"--baseline-agent",
			diagnostics,
		);
		const suitePath = requireFlag(flags, "--suite", diagnostics);
		if (!baselineAgentPath || !suitePath || !generatePath) {
			if (!generatePath) diagnostics.push("--auto requires --generate <file>");
			return undefined;
		}
		return buildEvolveCommon(flags, common, defaults, diagnostics, {
			baselineAgentPath,
			suitePath,
			autoIterations,
			generatePath,
			historyPath,
		});
	}

	// --generate mode (no --auto): single-shot generate + compare
	if (generatePath) {
		const baselineAgentPath = requireFlag(
			flags,
			"--baseline-agent",
			diagnostics,
		);
		const suitePath = requireFlag(flags, "--suite", diagnostics);
		if (!baselineAgentPath || !suitePath) return undefined;
		return buildEvolveCommon(flags, common, defaults, diagnostics, {
			baselineAgentPath,
			suitePath,
			generatePath,
			historyPath,
		});
	}

	// Standard mode: --baseline-agent, --candidate-agent, --suite
	const baselineAgentPath = requireFlag(flags, "--baseline-agent", diagnostics);
	const candidateAgentPath = requireFlag(
		flags,
		"--candidate-agent",
		diagnostics,
	);
	const suitePath = requireFlag(flags, "--suite", diagnostics);
	const provider = requiredOption(
		flags,
		"--provider",
		defaults.provider,
		diagnostics,
	);
	const model = requiredOption(flags, "--model", defaults.model, diagnostics);
	const baseURL = requiredOption(
		flags,
		"--base-url",
		defaults.baseURL,
		diagnostics,
	);
	if (
		!baselineAgentPath ||
		!candidateAgentPath ||
		!suitePath ||
		!provider ||
		!model ||
		!baseURL
	)
		return undefined;
	const apiKey = optionValue(flags, "--api-key", defaults.apiKey);
	const toolProfile = toolProfileFlag(flags, defaults, diagnostics);
	const reportPath = stringFlag(flags, "--report");
	const reportFormat = reportFormatFlag(flags, reportPath, diagnostics);
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
		...(defaults.mcpServers ? { mcpServers: defaults.mcpServers } : {}),
		...(defaults.providers ? { providers: defaults.providers } : {}),
		...(defaults.modelRouting ? { modelRouting: defaults.modelRouting } : {}),
		...(reportPath ? { reportPath } : {}),
		...(historyPath ? { historyPath } : {}),
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function buildEvolveCommon(
	flags: FlagValues,
	common: BaseCommand & { providerFormat: ProviderFormat },
	defaults: CliDefaults,
	diagnostics: string[],
	overrides: {
		baselineAgentPath: string;
		suitePath: string;
		generatePath?: string;
		autoIterations?: number;
		historyPath?: string | undefined;
	},
): EvolveCommand | undefined {
	const provider = requiredOption(
		flags,
		"--provider",
		defaults.provider,
		diagnostics,
	);
	const model = requiredOption(flags, "--model", defaults.model, diagnostics);
	const baseURL = requiredOption(
		flags,
		"--base-url",
		defaults.baseURL,
		diagnostics,
	);
	const apiKey = optionValue(flags, "--api-key", defaults.apiKey);
	const toolProfile = toolProfileFlag(flags, defaults, diagnostics);
	const reportPath = stringFlag(flags, "--report");
	const reportFormat = reportFormatFlag(flags, reportPath, diagnostics);
	if (!provider || !model || !baseURL) return undefined;
	return {
		kind: "evolve",
		baselineAgentPath: overrides.baselineAgentPath,
		suitePath: overrides.suitePath,
		provider,
		model,
		baseURL,
		providerFormat: common.providerFormat,
		toolProfile,
		reportFormat,
		format: common.format,
		...(apiKey ? { apiKey } : {}),
		...(defaults.mcpServers ? { mcpServers: defaults.mcpServers } : {}),
		...(defaults.providers ? { providers: defaults.providers } : {}),
		...(defaults.modelRouting ? { modelRouting: defaults.modelRouting } : {}),
		...(overrides.generatePath ? { generatePath: overrides.generatePath } : {}),
		...(overrides.autoIterations !== undefined
			? { autoIterations: overrides.autoIterations }
			: {}),
		...(overrides.historyPath ? { historyPath: overrides.historyPath } : {}),
		...(reportPath ? { reportPath } : {}),
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function buildReplay(
	flags: FlagValues,
	common: BaseCommand & { providerFormat: ProviderFormat },
	diagnostics: string[],
): ReplayCommand | undefined {
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

function buildDiff(
	flags: FlagValues,
	common: BaseCommand & { providerFormat: ProviderFormat },
	diagnostics: string[],
): DiffCommand | undefined {
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

function buildSopList(
	flags: FlagValues,
	common: BaseCommand & { providerFormat: ProviderFormat },
	diagnostics: string[],
): SopListCommand | undefined {
	const sopDir = stringFlag(flags, "--sop-dir") ?? "sop";
	return {
		kind: "sop.list",
		sopDir,
		format: common.format,
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
	};
}

function buildSopRun(
	flags: FlagValues,
	sopId: string | undefined,
	common: BaseCommand & { providerFormat: ProviderFormat },
	diagnostics: string[],
): SopRunCommand | undefined {
	if (!sopId) {
		diagnostics.push("missing required argument: sop <id>");
		return undefined;
	}
	const sopDir = stringFlag(flags, "--sop-dir") ?? "sop";
	return {
		kind: "sop.run",
		sopId,
		sopDir,
		format: common.format,
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function parseSopRunArgs(
	args: string[],
	diagnostics: string[],
): { flags: FlagValues; sopId?: string } {
	const flagArgs: string[] = [];
	let sopId: string | undefined;
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
		if (sopId === undefined) {
			sopId = value;
			continue;
		}
		diagnostics.push(`unexpected argument ${value}`);
	}
	return {
		flags: parseFlags(flagArgs, diagnostics),
		...(sopId ? { sopId } : {}),
	};
}

function parseCommandResult(
	command: CliCommand | undefined,
	diagnostics: string[],
): ParseResult {
	return command ? { command, diagnostics } : { diagnostics };
}

function apiKeyFlag(flags: FlagValues): string | undefined {
	return stringFlag(flags, "--api-key");
}

function toolProfileFlag(
	flags: FlagValues,
	defaults: CliDefaults,
	diagnostics: string[],
): ToolProfile {
	const value = optionValue(flags, "--tool-profile", defaults.toolProfile);
	if (value === undefined) return "dangerous";
	const profile = parseToolProfile(value);
	if (profile) return profile;
	diagnostics.push(
		"--tool-profile must be read-only, coding, benchmark-sandbox, or dangerous",
	);
	return "dangerous";
}

function reportFormatFlag(
	flags: FlagValues,
	reportPath: string | undefined,
	diagnostics: string[],
): BenchmarkReportFormat {
	const value = stringFlag(flags, "--report-format");
	if (value === "json" || value === "markdown") return value;
	if (value !== undefined)
		diagnostics.push("--report-format must be json or markdown");
	return inferReportFormat(reportPath);
}

function inferReportFormat(
	reportPath: string | undefined,
): BenchmarkReportFormat {
	const extension = reportPath ? path.extname(reportPath).toLowerCase() : "";
	if (extension === ".md" || extension === ".markdown") return "markdown";
	return "json";
}

function parseProviderFormat(
	value: string,
	diagnostics: string[],
): ProviderFormat {
	if (
		value === "openai-responses" ||
		value === "openai-chat" ||
		value === "anthropic-messages"
	)
		return value;
	diagnostics.push(
		"--provider-format must be openai-responses, openai-chat, or anthropic-messages",
	);
	return "openai-responses";
}

function chatOption(
	flags: FlagValues,
	flag: string,
	fallback: string | undefined,
	required: boolean,
	diagnostics: string[],
): string | undefined {
	return required
		? requiredOption(flags, flag, fallback, diagnostics)
		: optionValue(flags, flag, fallback);
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

function requireFlag(
	flags: FlagValues,
	flag: string,
	diagnostics: string[],
): string | undefined {
	return requiredOption(flags, flag, undefined, diagnostics);
}

function requiredOption(
	flags: FlagValues,
	flag: string,
	fallback: string | undefined,
	diagnostics: string[],
): string | undefined {
	const value = optionValue(flags, flag, fallback);
	if (!value) diagnostics.push(`missing required option ${flag}`);
	return value;
}

function optionValue(
	flags: FlagValues,
	flag: string,
	fallback: string | undefined,
): string | undefined {
	return stringFlag(flags, flag) ?? fallback;
}

export function configPathFromArgs(args: string[]): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--config")
			return args[index + 1]?.startsWith("--") ? undefined : args[index + 1];
	}
	return undefined;
}

function stringFlag(flags: FlagValues, flag: string): string | undefined {
	const value = flags[flag];
	return typeof value === "string" ? value : undefined;
}

function booleanFlag(flags: FlagValues, flag: string): boolean {
	return flags[flag] === true;
}

function parsePositiveInt(
	value: string,
	diagnostics: string[],
	flag: string,
): number | undefined {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		diagnostics.push(`${flag} must be a positive integer`);
		return undefined;
	}
	return parsed;
}

function parseBudgetFlag(flags: FlagValues): number | undefined {
	const raw = stringFlag(flags, "--token-budget");
	if (!raw) return undefined;
	const budget = parseTokenBudgetSyntax(raw);
	if (budget === undefined) return undefined;
	if (budget > 10_000_000) return 10_000_000;
	return budget;
}

function buildSopImport(
	flags: FlagValues,
	inputPath: string | undefined,
	common: BaseCommand & { providerFormat: ProviderFormat },
	diagnostics: string[],
): SopImportCommand | undefined {
	if (!inputPath) {
		diagnostics.push("missing required argument: <path> to SKILL.md file");
		return undefined;
	}
	const outputDir = stringFlag(flags, "--output-dir") ?? "sop";
	return {
		kind: "sop.import",
		inputPath,
		outputDir,
		format: common.format,
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
	};
}

function buildSopDeposit(
	flags: FlagValues,
	common: BaseCommand & { providerFormat: ProviderFormat },
	diagnostics: string[],
): SopDepositCommand | undefined {
	const sopDir = stringFlag(flags, "--sop-dir") ?? "sop";
	const skillBankPath = stringFlag(flags, "--skill-bank");
	const force = flags["--force"] === true;
	return {
		kind: "sop.deposit",
		sopDir,
		format: common.format,
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(skillBankPath ? { skillBankPath } : {}),
		...(force ? { force } : {}),
	};
}

function parseSopImportArgs(
	args: string[],
	diagnostics: string[],
): { flags: FlagValues; positional?: string } {
	const flagArgs: string[] = [];
	let positional: string | undefined;
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
		if (!positional) {
			positional = value;
			continue;
		}
		diagnostics.push(`unexpected argument ${value}`);
	}
	const flags = parseFlags(flagArgs, diagnostics);
	return { flags, ...(positional ? { positional } : {}) };
}
