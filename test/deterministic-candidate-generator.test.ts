import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDeterministicCandidateGenerator } from "../src/evolution/deterministic-generator.js";
import { loadDeterministicCandidateGenerator, loadDeterministicCandidateGeneratorFromFile } from "../src/evolution/deterministic-generator-loader.js";
import type { AgentSpec } from "../src/specs.js";

const baseline: AgentSpec = {
	id: "baseline",
	version: "1.0.0",
	name: "Baseline",
	kind: "baseline",
	model: { provider: "local", model: "gpt-5.4-mini", options: { top_p: 1 } },
	prompts: { system: "Answer carefully." },
	tools: { allowedTools: ["grep"], deniedTools: ["write_file"], permissionMode: "allow", maxToolCalls: 1 },
	runtime: { maxTurns: 1 },
	metadata: { example: true },
};

describe("DeterministicCandidateGenerator", () => {
	it("generates stable prompt candidates without mutating the parent", async () => {
		const parentBefore = structuredClone(baseline);
		const generator = createDeterministicCandidateGenerator({
			candidateIdPrefix: "smoke",
			source: "test",
			mutations: [
				{ id: "exact", kind: "system-prompt-append", text: "Return exact tokens.", description: "append exact instruction" },
				{ id: "replace", kind: "system-prompt-replace", text: "Only say pong." },
			],
		});

		const first = await generator.generate(baseline);
		const second = await generator.generate(baseline);

		expect(first).toEqual(second);
		expect(baseline).toEqual(parentBefore);
		expect(first[0]).toMatchObject({
			id: "smoke-candidate-exact",
			kind: "prompt",
			parentAgentId: "baseline",
			description: "append exact instruction",
			patch: "prompts.system += \"Return exact tokens.\"",
			metadata: { generator: "deterministic", mutationId: "exact", mutationKind: "system-prompt-append", candidateIndex: 0, source: "test" },
		});
		expect(first[0]?.agent).toMatchObject({ id: "smoke-candidate-exact", kind: "candidate", prompts: { system: "Answer carefully.\n\nReturn exact tokens." } });
		expect(first[1]?.agent.prompts.system).toBe("Only say pong.");
		expect(first[0]?.agent.metadata).toMatchObject({ example: true, deterministicCandidate: { mutationId: "exact" } });
	});

	it("generates stable tool candidates with conflict handling", async () => {
		const generator = createDeterministicCandidateGenerator({
			mutations: [
				{ id: "allow-read", kind: "allowed-tools-add", tools: ["read_file", "grep", "read_file"] },
				{ id: "remove-grep", kind: "allowed-tools-remove", tools: ["grep"] },
			],
		});

		const candidates = await generator.generate(baseline);

		expect(candidates[0]).toMatchObject({ id: "baseline-candidate-allow-read", kind: "tool", patch: "tools.allowedTools += [grep, read_file]" });
		expect(candidates[0]?.agent.tools).toMatchObject({ allowedTools: ["grep", "read_file"], deniedTools: ["write_file"] });
		expect(candidates[1]?.agent.tools.allowedTools).toEqual([]);
		expect(candidates[1]?.agent.tools.deniedTools).toEqual(["write_file"]);
	});

	it("generates model option and reasoning candidates as runtime candidates", async () => {
		const generator = createDeterministicCandidateGenerator({
			candidateVersion: "1.1.0",
			mutations: [
				{ id: "temperature-zero", kind: "model-options-merge", options: { temperature: 0 } },
				{ id: "reasoning-low", kind: "set-reasoning-level", reasoningLevel: "low" },
			],
		});

		const candidates = await generator.generate(baseline);

		expect(candidates[0]).toMatchObject({ kind: "runtime", patch: "model.options merge keys: temperature" });
		expect(candidates[0]?.agent.version).toBe("1.1.0");
		expect(candidates[0]?.agent.model.options).toEqual({ top_p: 1, temperature: 0 });
		expect(candidates[1]).toMatchObject({ kind: "runtime", patch: "model.reasoningLevel = low" });
		expect(candidates[1]?.agent.model.reasoningLevel).toBe("low");
	});

	it("limits candidates with maxCandidates", async () => {
		const generator = createDeterministicCandidateGenerator({
			maxCandidates: 1,
			mutations: [
				{ id: "one", kind: "system-prompt-append", text: "one" },
				{ id: "two", kind: "system-prompt-append", text: "two" },
			],
		});

		expect(await generator.generate(baseline)).toHaveLength(1);
	});

	it("generates denied tools mutation candidates", async () => {
			const generator = createDeterministicCandidateGenerator({
				mutations: [
					{ id: "deny-write", kind: "denied-tools-add", tools: ["bash"] },
					{ id: "allow-write", kind: "denied-tools-remove", tools: ["write_file"] },
				],
			});

			const candidates = await generator.generate(baseline);

			expect(candidates[0]).toMatchObject({ id: "baseline-candidate-deny-write", kind: "tool", patch: "tools.deniedTools += [bash]" });
			expect(candidates[0]?.agent.tools.deniedTools).toEqual(["bash", "write_file"]);
			expect(candidates[0]?.agent.tools.allowedTools).toEqual(["grep"]);
			expect(candidates[1]?.agent.tools.deniedTools).toEqual([]);
		});

		it("generates runtime parameter mutation candidates", async () => {
			const generator = createDeterministicCandidateGenerator({
				mutations: [
					{ id: "more-turns", kind: "set-max-turns", maxTurns: 5 },
					{ id: "longer-timeout", kind: "set-timeout-ms", timeoutMs: 120_000 },
					{ id: "more-tool-calls", kind: "set-max-tool-calls", maxToolCalls: 10 },
				],
			});

			const candidates = await generator.generate(baseline);

			expect(candidates[0]).toMatchObject({ id: "baseline-candidate-more-turns", kind: "runtime", patch: "runtime.maxTurns = 5" });
			expect(candidates[0]?.agent.runtime.maxTurns).toBe(5);
			expect(candidates[0]?.agent.runtime.timeoutMs).toBeUndefined();
			expect(candidates[1]).toMatchObject({ id: "baseline-candidate-longer-timeout", kind: "runtime", patch: "runtime.timeoutMs = 120000" });
			expect(candidates[1]?.agent.runtime.timeoutMs).toBe(120_000);
			expect(candidates[2]).toMatchObject({ id: "baseline-candidate-more-tool-calls", kind: "runtime", patch: "tools.maxToolCalls = 10" });
			expect(candidates[2]?.agent.tools.maxToolCalls).toBe(10);
		});

		it("rejects invalid mutations", () => {
		expect(() => createDeterministicCandidateGenerator({ mutations: [] })).toThrow("mutations");
		expect(() => createDeterministicCandidateGenerator({ mutations: [{ id: "bad", kind: "system-prompt-append", text: "" }] })).toThrow("mutation.text");
		expect(() => createDeterministicCandidateGenerator({ maxCandidates: 0, mutations: [{ id: "ok", kind: "system-prompt-append", text: "ok" }] })).toThrow("maxCandidates");
	});

	it("loads generator specs from objects and files", async () => {
		const generator = loadDeterministicCandidateGenerator({ mutations: [{ id: "exact", kind: "system-prompt-append", text: "exact" }] });
		expect(await generator.generate(baseline)).toHaveLength(1);

		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-generator-"));
		const filePath = path.join(root, "generator.json");
		await writeFile(filePath, JSON.stringify({ mutations: [{ id: "reasoning", kind: "set-reasoning-level", reasoningLevel: "minimal" }] }));
		const fileGenerator = await loadDeterministicCandidateGeneratorFromFile(filePath);
		const candidates = await fileGenerator.generate(baseline);

		expect(candidates[0]?.metadata).toMatchObject({ source: filePath, mutationId: "reasoning" });
	});

	it("rejects invalid loader specs", () => {
		expect(() => loadDeterministicCandidateGenerator({})).toThrow("mutations");
		expect(() => loadDeterministicCandidateGenerator({ mutations: [{ id: "bad", kind: "missing" }] })).toThrow("mutation.kind");
	});
});
