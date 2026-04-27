import type { ProviderFormat } from "../models/provider-types.js";

export type OutputFormat = "human" | "json";

export type CliCommand = ModelsDiscoverCommand | RunCommand | BenchmarkCommand | HelpCommand;

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

export interface RunCommand extends BaseCommand {
	kind: "run";
	agentPath: string;
	taskPath: string;
	provider: string;
	model: string;
	baseURL: string;
	apiKey?: string;
	providerFormat: ProviderFormat;
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

const valueFlags = new Set(["--provider", "--model", "--base-url", "--api-key", "--provider-format", "--format", "--output", "--trace", "--agent", "--task", "--suite"]);
const booleanFlags = new Set(["--json", "--help"]);

export function parseCliArgs(args: string[]): ParseResult {
	const diagnostics: string[] = [];
	if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
		return { command: { kind: "help", format: "human" }, diagnostics };
	}

	const commandParts = parseCommandParts(args);
	if (!commandParts) {
		return { diagnostics: [`unknown command ${args[0]}`] };
	}

	const flags = parseFlags(args.slice(commandParts.consumed), diagnostics);
	const format = parseOutputFormat(flags, diagnostics);
	const common = commonCommandFields(flags, format, diagnostics);

	if (flags["--help"] === true) {
		return { command: { kind: "help", format }, diagnostics };
	}

	if (commandParts.kind === "models.discover") {
		return parseCommandResult(buildModelsDiscover(flags, common, diagnostics), diagnostics);
	}
	if (commandParts.kind === "run") {
		return parseCommandResult(buildRun(flags, common, diagnostics), diagnostics);
	}
	return parseCommandResult(buildBenchmark(flags, common, diagnostics), diagnostics);
}

export function helpText(): string {
	return `evolving-agent

Usage:
  evolving-agent models discover --provider <id> --base-url <url> [--api-key <key>] [--json]
  evolving-agent run --agent <file> --task <file> --provider <id> --model <id> --base-url <url> [--api-key <key>] [--json]
  evolving-agent benchmark --suite <file> --agent <file> --provider <id> --model <id> --base-url <url> [--api-key <key>] [--json]

Options:
  --provider <id>
  --model <id>
  --base-url <url>
  --api-key <key>
  --provider-format <openai-responses|anthropic-messages>
  --format <human|json>
  --json
  --output <file>
  --trace <file>
  --help
`;
}

function parseCommandParts(args: string[]): { kind: CliCommand["kind"]; consumed: number } | undefined {
	if (args[0] === "models" && args[1] === "discover") return { kind: "models.discover", consumed: 2 };
	if (args[0] === "run") return { kind: "run", consumed: 1 };
	if (args[0] === "benchmark") return { kind: "benchmark", consumed: 1 };
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

function commonCommandFields(flags: FlagValues, format: OutputFormat, diagnostics: string[]): BaseCommand & { providerFormat: ProviderFormat } {
	const providerFormatValue = stringFlag(flags, "--provider-format") ?? "openai-responses";
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
	diagnostics: string[],
): ModelsDiscoverCommand | undefined {
	const provider = requireFlag(flags, "--provider", diagnostics);
	const baseURL = requireFlag(flags, "--base-url", diagnostics);
	if (!provider || !baseURL) return undefined;
	const apiKey = apiKeyFlag(flags);
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

function buildRun(flags: FlagValues, common: BaseCommand & { providerFormat: ProviderFormat }, diagnostics: string[]): RunCommand | undefined {
	const agentPath = requireFlag(flags, "--agent", diagnostics);
	const taskPath = requireFlag(flags, "--task", diagnostics);
	const provider = requireFlag(flags, "--provider", diagnostics);
	const model = requireFlag(flags, "--model", diagnostics);
	const baseURL = requireFlag(flags, "--base-url", diagnostics);
	if (!agentPath || !taskPath || !provider || !model || !baseURL) return undefined;
	const apiKey = apiKeyFlag(flags);
	return {
		kind: "run",
		agentPath,
		taskPath,
		provider,
		model,
		baseURL,
		providerFormat: common.providerFormat,
		format: common.format,
		...(apiKey ? { apiKey } : {}),
		...(common.outputPath ? { outputPath: common.outputPath } : {}),
		...(common.tracePath ? { tracePath: common.tracePath } : {}),
	};
}

function buildBenchmark(
	flags: FlagValues,
	common: BaseCommand & { providerFormat: ProviderFormat },
	diagnostics: string[],
): BenchmarkCommand | undefined {
	const agentPath = requireFlag(flags, "--agent", diagnostics);
	const suitePath = requireFlag(flags, "--suite", diagnostics);
	const provider = requireFlag(flags, "--provider", diagnostics);
	const model = requireFlag(flags, "--model", diagnostics);
	const baseURL = requireFlag(flags, "--base-url", diagnostics);
	if (!agentPath || !suitePath || !provider || !model || !baseURL) return undefined;
	const apiKey = apiKeyFlag(flags);
	return {
		kind: "benchmark",
		agentPath,
		suitePath,
		provider,
		model,
		baseURL,
		providerFormat: common.providerFormat,
		format: common.format,
		...(apiKey ? { apiKey } : {}),
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

function parseProviderFormat(value: string, diagnostics: string[]): ProviderFormat {
	if (value === "openai-responses" || value === "anthropic-messages") return value;
	diagnostics.push("--provider-format must be openai-responses or anthropic-messages");
	return "openai-responses";
}

function requireFlag(flags: FlagValues, flag: string, diagnostics: string[]): string | undefined {
	const value = stringFlag(flags, flag);
	if (!value) diagnostics.push(`missing required option ${flag}`);
	return value;
}

function stringFlag(flags: FlagValues, flag: string): string | undefined {
	const value = flags[flag];
	return typeof value === "string" ? value : undefined;
}
