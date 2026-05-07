import type { TuiCommand } from "./args.js";
import type { CliDeps, CliResult } from "./commands.js";
import { InteractiveMode } from "../tui/interactive-mode.js";
import { ProcessTerminal } from "../tui/process-terminal.js";

export async function handleTui(command: TuiCommand, deps: CliDeps): Promise<CliResult> {
	const terminal = deps.createTerminal?.() ?? new ProcessTerminal();
	const mode = new InteractiveMode({ command, deps, terminal, ...(deps.now ? { now: deps.now } : {}) });
	const exitCode = await mode.start();
	return { exitCode, json: { ok: exitCode === 0, command: "tui" }, human: "" };
}
