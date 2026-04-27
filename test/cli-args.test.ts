import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";

describe("parseCliArgs", () => {
	it("parses models discover", () => {
		const result = parseCliArgs(["models", "discover", "--provider", "local", "--base-url", "http://localhost:8317/v1"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "models.discover", provider: "local", providerFormat: "openai-responses" });
	});

	it("parses run", () => {
		const result = parseCliArgs(["run", "--agent", "agent.json", "--task", "task.json", "--provider", "local", "--model", "model", "--base-url", "url"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "run", agentPath: "agent.json", taskPath: "task.json", model: "model" });
	});

	it("parses benchmark", () => {
		const result = parseCliArgs(["benchmark", "--suite", "suite.json", "--agent", "agent.json", "--provider", "local", "--model", "model", "--base-url", "url", "--json"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "benchmark", format: "json" });
	});

	it("parses --format json", () => {
		const result = parseCliArgs(["models", "discover", "--provider", "local", "--base-url", "url", "--format", "json"]);
		expect(result.command).toMatchObject({ format: "json" });
	});

	it("reports missing required flags", () => {
		const result = parseCliArgs(["run", "--agent", "agent.json"]);
		expect(result.command).toBeUndefined();
		expect(result.diagnostics.join(" ")).toContain("--task");
	});

	it("reports unknown command and flags", () => {
		expect(parseCliArgs(["wat"]).diagnostics[0]).toContain("unknown command");
		expect(parseCliArgs(["models", "discover", "--wat"]).diagnostics[0]).toContain("unknown option");
	});
});
