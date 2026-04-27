#!/usr/bin/env node
import { main } from "./cli/main.js";

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Fatal error: ${message}\n`);
	process.exitCode = 1;
}
