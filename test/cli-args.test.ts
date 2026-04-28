import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";

describe("parseCliArgs", () => {
	it("parses models discover", () => {
		const result = parseCliArgs(["models", "discover", "--provider", "local", "--base-url", "http://localhost:8317/v1"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "models.discover", provider: "local", providerFormat: "openai-responses" });
	});

	it("parses chat", () => {
		const result = parseCliArgs(["chat", "hello", "--agent", "agent.json", "--provider", "local", "--model", "model", "--base-url", "url", "--session", "demo"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "chat", prompt: "hello", agentPath: "agent.json", model: "model", sessionId: "demo", toolProfile: "dangerous" });
	});

	it("parses chat without prompt for interactive REPL", () => {
		const result = parseCliArgs(["chat", "--agent", "agent.json", "--provider", "local", "--model", "model", "--base-url", "url"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "chat", agentPath: "agent.json", model: "model", toolProfile: "dangerous" });
		expect(result.command).not.toHaveProperty("prompt");
	});

	it("parses resume without startup options", () => {
		const result = parseCliArgs(["chat", "recall", "--resume", "demo"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "chat", prompt: "recall", resumeSessionId: "demo" });
		expect(result.command).not.toHaveProperty("agentPath");
	});

	it("tracks explicitly provided chat flags", () => {
		const result = parseCliArgs(["chat", "hello", "--agent", "flag-agent.json"], {
			provider: "local",
			model: "model",
			baseURL: "url",
		});
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "chat", agentPath: "flag-agent.json", providedFlags: { agentPath: true } });
		expect(result.command).toMatchObject({ providedFlags: expect.not.objectContaining({ provider: true }) });
	});

	it("uses CLI defaults for chat options", () => {
		const result = parseCliArgs(["chat", "hello"], {
			agentPath: "agent.json",
			provider: "local",
			model: "model",
			baseURL: "url",
			apiKey: "key",
			toolProfile: "coding",
			sessionDir: "sessions",
		});
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "chat", agentPath: "agent.json", provider: "local", model: "model", baseURL: "url", apiKey: "key", toolProfile: "coding", sessionDir: "sessions" });
	});

	it("lets explicit flags override CLI defaults", () => {
		const result = parseCliArgs(["run", "--task", "task.json", "--model", "flag-model"], {
			agentPath: "agent.json",
			provider: "local",
			model: "default-model",
			baseURL: "url",
		});
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "run", model: "flag-model" });
	});

	it("parses run", () => {
		const result = parseCliArgs(["run", "--agent", "agent.json", "--task", "task.json", "--provider", "local", "--model", "model", "--base-url", "url"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "run", agentPath: "agent.json", taskPath: "task.json", model: "model", toolProfile: "dangerous" });
	});

	it("parses tool profiles", () => {
		const result = parseCliArgs(["run", "--agent", "agent.json", "--task", "task.json", "--provider", "local", "--model", "model", "--base-url", "url", "--tool-profile", "coding"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "run", toolProfile: "coding" });
	});

	it("reports invalid tool profiles", () => {
		const result = parseCliArgs(["benchmark", "--suite", "suite.json", "--agent", "agent.json", "--provider", "local", "--model", "model", "--base-url", "url", "--tool-profile", "wat"]);
		expect(result.diagnostics.join(" ")).toContain("--tool-profile");
		expect(result.command).toMatchObject({ kind: "benchmark", toolProfile: "dangerous" });
	});

	it("parses benchmark", () => {
		const result = parseCliArgs(["benchmark", "--suite", "suite.json", "--agent", "agent.json", "--provider", "local", "--model", "model", "--base-url", "url", "--json"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "benchmark", format: "json", reportFormat: "json" });
	});

	it("infers markdown benchmark report format", () => {
		const result = parseCliArgs(["benchmark", "--suite", "suite.json", "--agent", "agent.json", "--provider", "local", "--model", "model", "--base-url", "url", "--report", "report.md"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "benchmark", reportPath: "report.md", reportFormat: "markdown" });
	});

	it("parses explicit benchmark report format", () => {
		const result = parseCliArgs(["benchmark", "--suite", "suite.json", "--agent", "agent.json", "--provider", "local", "--model", "model", "--base-url", "url", "--report", "report.md", "--report-format", "json"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "benchmark", reportPath: "report.md", reportFormat: "json" });
	});

	it("reports invalid benchmark report format", () => {
		const result = parseCliArgs(["benchmark", "--suite", "suite.json", "--agent", "agent.json", "--provider", "local", "--model", "model", "--base-url", "url", "--report-format", "html"]);
		expect(result.diagnostics.join(" ")).toContain("--report-format");
		expect(result.command).toMatchObject({ kind: "benchmark", reportFormat: "json" });
	});

	it("parses evolve", () => {
		const result = parseCliArgs(["evolve", "--suite", "suite.json", "--baseline-agent", "baseline.json", "--candidate-agent", "candidate.json", "--provider", "local", "--model", "model", "--base-url", "url", "--report", "report.md", "--history", "history.jsonl"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "evolve", baselineAgentPath: "baseline.json", candidateAgentPath: "candidate.json", reportFormat: "markdown", historyPath: "history.jsonl" });
	});

	it("parses replay", () => {
		const result = parseCliArgs(["replay", "--trace", "trace.json", "--run-id", "run-1", "--json"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "replay", tracePath: "trace.json", runId: "run-1", format: "json" });
	});

	it("parses diff", () => {
		const result = parseCliArgs(["diff", "--left", "left.json", "--right", "right.json"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.command).toMatchObject({ kind: "diff", leftPath: "left.json", rightPath: "right.json" });
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
