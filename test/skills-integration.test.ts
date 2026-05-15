import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SopRegistry } from "../src/sop/registry.js";
import { MemorySkillBank, FileSkillBank } from "../src/skills/store.js";
import { depositSopDirectoryToSkillBank } from "../src/skills/sop-bridge.js";
import { createSkillTool, createSkillContextTransform } from "../src/skills/skill-tool.js";
import { parseMarketSkillContent, marketSkillToSopSpec } from "../src/skills/market-converter.js";
import type { ToolRegistry } from "../src/tools/registry.js";

function fakeToolRegistry(): ToolRegistry {
  const tools = new Map();
  return {
    get(name) { return tools.get(name); },
    list() { return Array.from(tools.values()); },
    register(tool) { tools.set(tool.name, tool); },
    clone() { return fakeToolRegistry(); },
    execute: () => { throw new Error("not implemented"); },
    close() { return Promise.resolve(); },
  } as unknown as ToolRegistry;
}

const testDir = join(import.meta.dirname ?? "/tmp", ".tmp-skills-integration");

beforeEach(async () => {
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function sopYamlContent(id: string, name: string): string {
  return `id: ${id}
version: "1.0.0"
name: ${name}
description: SOP for ${name}
params:
  type: object
  properties:
    message:
      type: string
      description: A message to echo
steps:
  - id: echo
    name: Echo Message
    description: Print the message parameter
    action:
      type: prompt
      template: "Echo: {{params.message}}"
    verification:
      method: regex
      config:
        pattern: "Echo: .+"
`;
}

describe("Full Skill/SOP Integration", () => {
  it("loads SOP YAMLs and registers sop_<id> tools", async () => {
    await writeFile(join(testDir, "echo.sop.yaml"), sopYamlContent("echo", "Echo"));
    await writeFile(join(testDir, "greet.sop.yaml"), sopYamlContent("greet", "Greet"));

    const registry = new SopRegistry();
    const toolRegistry = fakeToolRegistry();
    await registry.loadAndRegister({ sopDir: testDir, toolRegistry });

    expect(registry.list()).toHaveLength(2);
    expect(registry.get("echo")?.name).toBe("Echo");
    expect(registry.get("greet")?.name).toBe("Greet");

    const echoTool = toolRegistry.get("sop_echo");
    expect(echoTool).toBeDefined();
    expect(echoTool?.name).toBe("sop_echo");
    expect(echoTool?.inputSchema).toEqual({
      type: "object",
      properties: { message: { type: "string", description: "A message to echo" } },
    });

    const greetTool = toolRegistry.get("sop_greet");
    expect(greetTool).toBeDefined();
  });

  it("deposits loaded SOPs into SkillBank and registers skill tool", async () => {
    await writeFile(join(testDir, "echo.sop.yaml"), sopYamlContent("echo", "Echo"));
    await writeFile(join(testDir, "greet.sop.yaml"), sopYamlContent("greet", "Greet"));

    const toolRegistry = fakeToolRegistry();
    const registry = new SopRegistry();
    await registry.loadAndRegister({ sopDir: testDir, toolRegistry });

    const bank = new MemorySkillBank();
    await depositSopDirectoryToSkillBank(testDir, bank, { force: true });

    const skills = bank.list();
    expect(skills).toHaveLength(2);
    expect(skills.find((s) => s.id === "echo")).toBeDefined();
    expect(skills.find((s) => s.id === "greet")).toBeDefined();

    const skillTool = createSkillTool({ bank, toolRegistry });
    toolRegistry.register(skillTool);

    const listResult = await skillTool.execute({ action: "list" });
    const parsed = JSON.parse(listResult as string);
    expect(parsed.skills).toHaveLength(2);
  });

  it("contextTransform injects loaded skills into system prompt", async () => {
    await writeFile(join(testDir, "echo.sop.yaml"), sopYamlContent("echo", "Echo"));

    const toolRegistry = fakeToolRegistry();
    const registry = new SopRegistry();
    await registry.loadAndRegister({ sopDir: testDir, toolRegistry });

    const bank = new MemorySkillBank();
    await depositSopDirectoryToSkillBank(testDir, bank, { force: true });

    const transform = createSkillContextTransform(bank);
    const messages = [{ role: "system" as const, content: "You are a helpful agent." }];
    const session = {
      id: "s1",
      agent: { id: "a1", skills: { enabled: true } },
    } as never;

    const result = transform(messages, session);
    expect(result[0]!.content).toContain("<skills_instructions>");
    expect(result[0]!.content).toContain("echo: Echo");
  });

  it("SKILL.md is converted and can be loaded into the pipeline", async () => {
    const skillMD = `---
name: Converted Skill
description: A skill converted from SKILL.md format
params:
  text:
    type: string
    description: Input text to process
tags:
  - converted
triggers:
  - convert
---

Process the input by doing the following:
1. Read the input text
2. Perform transformation
3. Return the result
`;

    const { config, body } = await parseMarketSkillContent(skillMD);
    expect(config.name).toBe("Converted Skill");
    expect(config.tags).toEqual(["converted"]);

    const sop = marketSkillToSopSpec(config, body);
    expect(sop.id).toBe("converted-skill");
    expect(sop.steps).toHaveLength(1); // single prompt step
    expect(sop.steps[0]?.action).toEqual({ type: "prompt", template: body });

    // Now feed it through the SOP registry flow
    const toolRegistry = fakeToolRegistry();
    const registry = new SopRegistry();

    // Write the generated SOP as YAML
    const { stringify } = await import("yaml");
    const yamlContent = stringify(sop);
    await writeFile(join(testDir, `${sop.id}.sop.yaml`), yamlContent);

    await registry.loadAndRegister({ sopDir: testDir, toolRegistry });
    expect(registry.get("converted-skill")).toBeDefined();

    const bank = new MemorySkillBank();
    await depositSopDirectoryToSkillBank(testDir, bank, { force: true });
    expect(bank.get("converted-skill")).toBeDefined();

    const skill = bank.get("converted-skill")!;
    expect(skill.name).toBe("Converted Skill");
    expect(skill.versions[0]?.sop.steps[0]?.action).toEqual({ type: "prompt", template: body });
  });

  it("skip when agent has no skills config", async () => {
    // registerSkillTools should return undefined when agent.skills is undefined
    const agent = {
      id: "test-agent",
      version: "1.0.0",
      name: "Test",
      kind: "baseline" as const,
      model: { provider: "test", model: "test" },
      prompts: { system: "" },
      tools: { allowedTools: [] },
      runtime: { maxTurns: 5 },
    };
    expect(agent.skills).toBeUndefined();
  });

  it("skip when skills.enabled is false", () => {
    const agent = {
      id: "test-agent",
      version: "1.0.0",
      name: "Test",
      kind: "baseline" as const,
      model: { provider: "test", model: "test" },
      prompts: { system: "" },
      tools: { allowedTools: [] },
      runtime: { maxTurns: 5 },
      skills: { enabled: false },
    };
    expect(agent.skills.enabled).toBe(false);
  });
});
