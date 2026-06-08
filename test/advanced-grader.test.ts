import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { CommandGrader } from "../src/benchmark/graders/command.js";
import { ArtifactGrader } from "../src/benchmark/graders/artifact.js";
import { CompositeGrader } from "../src/benchmark/graders/composite.js";
import { GraderRegistry, createDefaultRegistry } from "../src/benchmark/graders/registry.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "local", model: "model" },
	prompts: { system: "Test" },
	tools: { allowedTools: [] },
	runtime: { maxTurns: 1 },
};

const tmpDir = path.join("/tmp", `grader-test-${Date.now()}`);

function setupTempDir() {
	rmSync(tmpDir, { recursive: true, force: true });
	mkdirSync(tmpDir, { recursive: true });
}

describe("CommandGrader", () => {
	it("passes when command returns expected exit code", async () => {
		setupTempDir();
		const grader = new CommandGrader({ workspaceDir: tmpDir });
		const task = commandTask({ command: "echo hello" });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(true);
		expect(result.score).toBe(1);
	});

	it("checks stdoutContains", async () => {
		setupTempDir();
		const grader = new CommandGrader({ workspaceDir: tmpDir });
		const task = commandTask({ command: "echo hello world", stdoutContains: ["hello", "world"] });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(true);
		expect(result.details).toMatchObject({ checks: { exitCode: true, stdoutContains: true } });
	});

	it("fails when stdoutContains does not match", async () => {
		setupTempDir();
		const grader = new CommandGrader({ workspaceDir: tmpDir });
		const task = commandTask({ command: "echo hello", stdoutContains: ["world"] });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(false);
		expect(result.details).toMatchObject({ checks: { exitCode: true, stdoutContains: false } });
	});

	it("checks stdoutExact", async () => {
		setupTempDir();
		const grader = new CommandGrader({ workspaceDir: tmpDir });
		const task = commandTask({ command: "echo -n hello", stdoutExact: "hello" });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(true);
	});

	it("checks exit code", async () => {
		setupTempDir();
		const grader = new CommandGrader({ workspaceDir: tmpDir });
		const task = commandTask({ command: "exit 1", exitCode: 1 });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(true);
		expect(result.details).toMatchObject({ exitCode: 1 });
	});

	it("fails with invalid command config", async () => {
		const grader = new CommandGrader({});
		const task = { ...commandTask({ command: "" }), scoring: { method: "command" as const, config: {} } };
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(false);
		expect(result.reason).toContain("command grader requires config.command");
	});

	it("scores proportionally for partial checks", async () => {
		setupTempDir();
		const grader = new CommandGrader({ workspaceDir: tmpDir });
		const task = commandTask({ command: "echo hello", exitCode: 0, stdoutContains: ["world"], maxScore: 10 });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(false);
		expect(result.score).toBe(5); // 1 of 2 checks passed = 50% of 10
	});

	it("handles stderrContains check", async () => {
		setupTempDir();
		const grader = new CommandGrader({ workspaceDir: tmpDir });
		const task = commandTask({ command: "echo error >&2", stderrContains: ["error"] });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(true);
	});

	it("catches command execution errors", async () => {
		const grader = new CommandGrader({ workspaceDir: "/nonexistent/path" });
		const task = commandTask({ command: "ls" });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(false);
		expect(result.reason).toContain("command execution error");
	});
});

describe("ArtifactGrader", () => {
	it("passes when file exists", async () => {
		setupTempDir();
		writeFileSync(path.join(tmpDir, "test.txt"), "hello");
		const grader = new ArtifactGrader({ workspaceDir: tmpDir });
		const task = artifactTask({ path: "test.txt", exists: true });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(true);
	});

	it("fails when file does not exist", async () => {
		setupTempDir();
		const grader = new ArtifactGrader({ workspaceDir: tmpDir });
		const task = artifactTask({ path: "missing.txt", exists: true });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(false);
	});

	it("checks file content contains", async () => {
		setupTempDir();
		writeFileSync(path.join(tmpDir, "report.md"), "# Report\n\nConclusion: all good");
		const grader = new ArtifactGrader({ workspaceDir: tmpDir });
		const task = artifactTask({ path: "report.md", contains: ["Report", "Conclusion"] });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(true);
	});

	it("fails when content does not contain expected strings", async () => {
		setupTempDir();
		writeFileSync(path.join(tmpDir, "report.md"), "# Report");
		const grader = new ArtifactGrader({ workspaceDir: tmpDir });
		const task = artifactTask({ path: "report.md", contains: ["Missing"] });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(false);
	});

	it("checks exact match", async () => {
		setupTempDir();
		writeFileSync(path.join(tmpDir, "data.txt"), "42");
		const grader = new ArtifactGrader({ workspaceDir: tmpDir });
		const task = artifactTask({ path: "data.txt", exactMatch: "42" });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(true);
	});

	it("checks regex match", async () => {
		setupTempDir();
		writeFileSync(path.join(tmpDir, "log.txt"), "Error: something failed at line 42");
		const grader = new ArtifactGrader({ workspaceDir: tmpDir });
		const task = artifactTask({ path: "log.txt", regex: "Error:.+" });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(true);
	});

	it("checks max lines", async () => {
		setupTempDir();
		writeFileSync(path.join(tmpDir, "short.txt"), "line1\nline2");
		const grader = new ArtifactGrader({ workspaceDir: tmpDir });
		const task = artifactTask({ path: "short.txt", maxLines: 2 });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(true);
	});

	it("checks min height lines", async () => {
		setupTempDir();
		writeFileSync(path.join(tmpDir, "long.txt"), "a\nb\nc\nd\ne");
		const grader = new ArtifactGrader({ workspaceDir: tmpDir });
		const task = artifactTask({ path: "long.txt", minHeightLines: 3 });
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(true);
	});

	it("fails with invalid config path", async () => {
		const grader = new ArtifactGrader({});
		const task = { ...artifactTask({ path: "" }), scoring: { method: "artifact" as const, config: {} } };
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(false);
		expect(result.reason).toContain("artifact grader requires config.path");
	});

	it("scores proportionally for partial checks", async () => {
		setupTempDir();
		writeFileSync(path.join(tmpDir, "f.txt"), "content");
		const grader = new ArtifactGrader({ workspaceDir: tmpDir });
		const task = artifactTask({ path: "f.txt", exists: true, contains: ["missing"], maxScore: 10 });
		const result = await grader.grade(agent, task, {});
		expect(result.score).toBe(5);
		expect(result.passed).toBe(false);
	});
});

describe("CompositeGrader (custom method)", () => {
	it("aggregates subscore results with weights", async () => {
		setupTempDir();
		writeFileSync(path.join(tmpDir, "answer.txt"), "pong");
		const registry = createDefaultRegistry();
		const ctx = { workspaceDir: tmpDir };
		const grader = new CompositeGrader(registry, ctx);
		const task = customTask([
			{ method: "exact", weight: 1, config: { expected: "pong" } },
			{ method: "artifact", weight: 2, config: { path: "answer.txt", exists: true } },
		]);
		const result = await grader.grade(agent, task, { answer: "pong" });
		expect(result.passed).toBe(true);
		expect(result.score).toBe(1);
		expect(result.details).toMatchObject({ totalWeight: 3, earnedWeight: 3 });
	});

	it("respects passThreshold", async () => {
		setupTempDir();
		writeFileSync(path.join(tmpDir, "answer.txt"), "wrong");
		const registry = createDefaultRegistry();
		const ctx = { workspaceDir: tmpDir };
		const grader = new CompositeGrader(registry, ctx);
		const task = customTask([
			{ method: "exact", weight: 1, config: { expected: "pong" } },
			{ method: "artifact", weight: 2, config: { path: "answer.txt", exists: true } },
		], 0.5);
		const result = await grader.grade(agent, task, { answer: "wrong" });
		expect(result.passed).toBe(true); // 2/3 = 0.67 >= 0.5
	});

	it("fails below passThreshold", async () => {
		setupTempDir();
		const registry = createDefaultRegistry();
		const ctx = { workspaceDir: tmpDir };
		const grader = new CompositeGrader(registry, ctx);
		const task = customTask([
			{ method: "exact", weight: 1, config: { expected: "pong" } },
		], 0.9);
		const result = await grader.grade(agent, task, { answer: "wrong" });
		expect(result.passed).toBe(false);
	});

	it("fails with invalid subscores config", async () => {
		const registry = createDefaultRegistry();
		const grader = new CompositeGrader(registry, {});
		const task = { ...customTask([]), scoring: { method: "custom" as const, config: {} } };
		const result = await grader.grade(agent, task, {});
		expect(result.passed).toBe(false);
		expect(result.reason).toContain("custom scoring requires config.subscores");
	});
});

describe("GraderRegistry", () => {
	it("creates graders via factory", () => {
		const registry = createDefaultRegistry();
		expect(registry.has("exact")).toBe(true);
		expect(registry.has("rubric")).toBe(true);
		expect(registry.has("llm-judge")).toBe(true);
		expect(registry.has("command")).toBe(true);
		expect(registry.has("artifact")).toBe(true);
		expect(registry.has("custom")).toBe(true);
		expect(registry.has("unknown")).toBe(false);
	});

	it("throws for unknown method", () => {
		const registry = createDefaultRegistry();
		expect(() => registry.create("unknown", {})).toThrow("Unknown grader method");
	});

	it("allows custom registration", () => {
		const registry = new GraderRegistry();
		expect(registry.has("exact")).toBe(false);
		registry.register("exact", () => ({ async grade() { return { score: 0, maxScore: 1, passed: false, reason: "custom" }; } }));
		expect(registry.has("exact")).toBe(true);
		const grader = registry.create("exact", {});
		expect(grader).toBeDefined();
	});
});

function commandTask(config: Record<string, unknown> & { maxScore?: number }): TaskSpec {
	const { maxScore, ...rest } = config;
	return {
		id: "task", type: "general", title: "Command Task", prompt: "Run a command",
		scoring: { method: "command", maxScore: maxScore ?? 1, config: rest },
	};
}

function artifactTask(config: Record<string, unknown> & { maxScore?: number }): TaskSpec {
	const { maxScore, ...rest } = config;
	return {
		id: "task", type: "general", title: "Artifact Task", prompt: "Check artifacts",
		scoring: { method: "artifact", maxScore: maxScore ?? 1, config: rest },
	};
}

function customTask(subscores: Array<{ method: string; weight: number; config: Record<string, unknown> }>, passThreshold?: number): TaskSpec {
	return {
		id: "task", type: "general", title: "Custom Task", prompt: "Multi-score task",
		scoring: { method: "custom", maxScore: 1, config: { subscores, ...(passThreshold !== undefined ? { passThreshold } : {}) } },
	};
}
