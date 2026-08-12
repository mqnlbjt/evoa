import { spawn } from "node:child_process";
import type { WebCommand } from "./args.js";
import type { CliDeps, CliResult } from "./commands.js";
import { WebServer } from "../web/server.js";

export interface WebDeps extends CliDeps {
	openBrowser?: (url: string) => void;
}

export async function handleWeb(command: WebCommand, deps: WebDeps): Promise<CliResult> {
	const server = new WebServer({
		command,
		deps,
		port: command.port,
		host: command.host,
		...(command.staticDir ? { staticDir: command.staticDir } : {}),
		...(deps.now ? { now: deps.now } : {}),
	});
	await server.start();
	deps.onServerStarted?.(server);	const url = server.url();
	const open = deps.openBrowser ?? defaultOpenBrowser;
	if (command.open) open(url);
	const human = `Web UI started: ${url}\nPress Ctrl+C to stop.`;
	return { exitCode: 0, json: { ok: true, command: "web", url }, human };
}

function defaultOpenBrowser(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	if (process.platform === "win32") spawn(command, ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
	else spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
}
