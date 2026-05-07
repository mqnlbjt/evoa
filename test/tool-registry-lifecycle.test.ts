import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import type { EvolvingAgentTool } from "../src/tools/types.js";

const tool: EvolvingAgentTool = {
	name: "bash",
	description: "Bash",
	permission: { defaultDecision: "allow", riskLevel: "high", requiresSandbox: true },
	concurrency: "sequential",
	async execute() {
		return "ok";
	},
};

describe("ToolRegistry lifecycle", () => {
	it("closes registered disposables", async () => {
		const dispose = vi.fn();
		const registry = new ToolRegistry([], { disposables: [dispose] });
		const later = vi.fn();
		registry.registerDisposable(later);

		await registry.close();

		expect(dispose).toHaveBeenCalledOnce();
		expect(later).toHaveBeenCalledOnce();
	});

	it("clones tools and sandbox policy without copying disposables", async () => {
		const dispose = vi.fn();
		const registry = new ToolRegistry([tool], { disposables: [dispose], sandboxPolicy: { mode: "workspace", workspaceRoot: "/workspace", allowNetwork: false, allowBash: true } });
		const clone = registry.clone();

		expect(clone.get("bash")).toBe(tool);
		await clone.close();
		expect(dispose).not.toHaveBeenCalled();
	});
});
