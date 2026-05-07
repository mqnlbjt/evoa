import { handleBenchmark, handleChat, handleDiff, handleEvolve, handleMcpDiagnostics, handleMcpStatus, handleModelsDiscover, handleReplay, handleRun, writeOptionalFiles, type CliDeps, type CliResult } from "./commands.js";
import { handleTui } from "./tui-command.js";
import { formatJson } from "./format.js";
import { configPathFromArgs, helpText, parseCliArgs, type CliCommand } from "./args.js";
import { loadCliDefaults } from "./config.js";

export type { CliDeps } from "./commands.js";

export async function main(args: string[], deps: CliDeps = {}): Promise<number> {
	const stdout = deps.stdout ?? process.stdout;
	const stderr = deps.stderr ?? process.stderr;
	const config = await loadCliDefaults(configPathFromArgs(args));
	const parsed = parseCliArgs(args, config.defaults);
	const format = parsed.command?.format ?? (args.includes("--json") || args.includes("--format") && args.includes("json") ? "json" : "human");
	const diagnostics = [...config.diagnostics, ...parsed.diagnostics];

	if (diagnostics.length > 0 || !parsed.command) {
		return writeUsageError(diagnostics, format, stdout, stderr);
	}
	if (parsed.command.kind === "help") {
		stdout.write(helpText());
		return 0;
	}

	try {
		const result = await runCommand(parsed.command, deps);
		await writeOptionalFiles(parsed.command, result);
		writeResult(result, parsed.command.format, stdout);
		return result.exitCode;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (format === "json") {
			stdout.write(formatJson({ ok: false, error: { code: "RUN_ERROR", message } }));
		} else {
			stderr.write(`Error: ${message}\n`);
		}
		return 1;
	}
}

async function runCommand(command: CliCommand, deps: CliDeps): Promise<CliResult> {
	if (command.kind === "models.discover") return handleModelsDiscover(command, deps);
	if (command.kind === "mcp.status") return handleMcpStatus(command, deps);
	if (command.kind === "mcp.diagnostics") return handleMcpDiagnostics(command, deps);
	if (command.kind === "chat") return handleChat(command, deps);
	if (command.kind === "tui") return handleTui(command, deps);
	if (command.kind === "run") return handleRun(command, deps);
	if (command.kind === "benchmark") return handleBenchmark(command, deps);
	if (command.kind === "evolve") return handleEvolve(command, deps);
	if (command.kind === "replay") return handleReplay(command, deps);
	if (command.kind === "diff") return handleDiff(command, deps);
	return { exitCode: 0, human: helpText(), json: { ok: true, command: "help" } };
}

function writeUsageError(diagnostics: string[], format: "human" | "json", stdout: Pick<NodeJS.WriteStream, "write">, stderr: Pick<NodeJS.WriteStream, "write">): number {
	const message = diagnostics.length === 0 ? "invalid command" : diagnostics.join("; ");
	if (format === "json") {
		stdout.write(formatJson({ ok: false, error: { code: "USAGE_ERROR", message } }));
	} else {
		stderr.write(`Error: ${message}\n\n${helpText()}`);
	}
	return 2;
}

function writeResult(result: CliResult, format: "human" | "json", stdout: Pick<NodeJS.WriteStream, "write">): void {
	if (format === "json") {
		stdout.write(formatJson(result.json));
		return;
	}
	if (result.human) stdout.write(`${result.human}\n`);
}
