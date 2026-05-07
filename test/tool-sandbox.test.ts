import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/runtime/session.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";
import { decideSandboxUse, type SandboxPolicy } from "../src/tools/sandbox.js";
import type { EvolvingAgentTool } from "../src/tools/types.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "system" },
	tools: { allowedTools: ["write_file", "edit_file", "web_fetch", "bash"], permissionMode: "allow" },
	runtime: { maxTurns: 1 },
};

const task: TaskSpec = {
	id: "task",
	type: "tool",
	title: "Tool task",
	prompt: "use tool",
	scoring: { method: "exact" },
};

const session: AgentSession = { id: "session", agent, task, messages: [], trace: [], turnCount: 0, toolCallCount: 0 };
const workspacePolicy: SandboxPolicy = { mode: "workspace", workspaceRoot: "/workspace", allowNetwork: false, allowBash: true };

describe("sandbox policy", () => {
	it("allows workspace write tools", () => {
		expect(decideSandboxUse(context("write_file", { path: "note.txt", content: "hello" })).decision).toBe("allow");
		expect(decideSandboxUse(context("edit_file", { path: "note.txt", edits: [] })).decision).toBe("allow");
	});

	it("denies protected write paths", () => {
		const result = decideSandboxUse(context("write_file", { path: ".claude/settings.json", content: "{}" }));

		expect(result.decision).toBe("deny");
		expect(result.reason).toContain("write path is denied");
	});

	it("denies web_fetch when network is disabled", () => {
		const result = decideSandboxUse(context("web_fetch", { url: "https://example.com" }));

		expect(result.decision).toBe("deny");
		expect(result.reason).toContain("network access is disabled");
	});

	it("denies bash when bash is disabled", () => {
		const result = decideSandboxUse(context("bash", { command: "npm test" }, { ...workspacePolicy, allowBash: false }));

		expect(result.decision).toBe("deny");
		expect(result.reason).toContain("bash is disabled");
	});

	it.each([
		"sudo whoami",
		"rm -rf /",
		"chmod 777 file.txt",
		"curl https://example.com",
		"git clone https://example.com/repo.git",
		"node server.js &",
		"echo x > /tmp/x",
	])("denies risky bash command %s", (command) => {
		const result = decideSandboxUse(context("bash", { command }));

		expect(result.decision).toBe("deny");
	});

	it.each(["npm test", "npm run typecheck", "node -e \"console.log('ok')\""])("allows ordinary bash command %s", (command) => {
		const result = decideSandboxUse(context("bash", { command }));

		expect(result.decision).toBe("allow");
	});

	it("off mode does not deny and marks metadata", () => {
		const result = decideSandboxUse(context("bash", { command: "curl https://example.com" }, { mode: "off", workspaceRoot: "/workspace", allowNetwork: true, allowBash: true }));

		expect(result).toMatchObject({ decision: "allow", metadata: { sandboxMode: "off" } });
	});

	it("denies docker bash without a container", () => {
		const result = decideSandboxUse(context("bash", { command: "npm test" }, { mode: "docker", workspaceRoot: "/workspace", allowNetwork: false, allowBash: true }));

		expect(result.decision).toBe("deny");
		expect(result.reason).toContain("configured container");
	});
});

function context(name: string, input: unknown, policy: SandboxPolicy = workspacePolicy) {
	return { session, tool: tool(name), call: { id: "call", name, input }, policy };
}

function tool(name: string): EvolvingAgentTool {
	return {
		name,
		description: name,
		permission: { defaultDecision: "allow", riskLevel: name === "bash" ? "high" : "low", requiresSandbox: name === "bash" || name.endsWith("file") },
		concurrency: "parallel-safe",
		async execute() {
			return "ok";
		},
	};
}
