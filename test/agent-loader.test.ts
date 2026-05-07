import { describe, expect, it } from "vitest";
import { loadAgentDefinitions } from "../src/agents/loader.js";
import { validateAgentSpec } from "../src/agents/validation.js";
import type { AgentSpec } from "../src/specs.js";

const agent: AgentSpec = {
	id: "agent",
	version: "1.0.0",
	name: "Agent",
	kind: "baseline",
	model: { provider: "fake", model: "fake" },
	prompts: { system: "system" },
	tools: { allowedTools: ["read"], permissionMode: "allow" },
	runtime: { maxTurns: 1 },
};

describe("agent loader", () => {
	it("loads a single agent object", () => {
		const bundle = loadAgentDefinitions(agent);

		expect(bundle.agents).toEqual([agent]);
		expect(bundle.subagents).toEqual([]);
	});

	it("loads bundles and lets later duplicate ids override earlier definitions", () => {
		const newer = { ...agent, name: "New Agent" };
		const bundle = loadAgentDefinitions({ agents: [agent, newer] });

		expect(bundle.agents).toEqual([newer]);
	});

	it("loads subagent definitions", () => {
		const bundle = loadAgentDefinitions({ subagents: [{ id: "planner", role: "planner", agent }] });

		expect(bundle.subagents[0]?.id).toBe("planner");
	});

	it("rejects duplicate subagent ids", () => {
		expect(() => loadAgentDefinitions({ subagents: [
			{ id: "planner", role: "planner", agent },
			{ id: "planner", role: "critic", agent },
		] })).toThrow("duplicate subagent id: planner");
	});

	it("rejects invalid runtime policy", () => {
		expect(() => validateAgentSpec({ ...agent, runtime: { maxTurns: 0 } })).toThrow("runtime.maxTurns");
		expect(() => validateAgentSpec({ ...agent, runtime: { maxTurns: 1, timeoutMs: 0 } })).toThrow("runtime.timeoutMs");
		expect(() => validateAgentSpec({ ...agent, runtime: { maxTurns: 1, contextCompression: "always" } })).toThrow("runtime.contextCompression");
		expect(() => validateAgentSpec({ ...agent, runtime: { maxTurns: 1, memoryPolicy: "forever" } })).toThrow("runtime.memoryPolicy");
	});
});
