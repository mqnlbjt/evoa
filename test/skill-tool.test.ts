import { describe, expect, it } from "vitest";
import { createSkillTool, createSkillContextTransform, buildSkillListingBlock, type SkillToolInput, type CreateSkillToolOptions } from "../src/skills/skill-tool.js";
import { MemorySkillBank } from "../src/skills/store.js";
import { sopToSkill } from "../src/skills/sop-bridge.js";
import type { SOPSpec } from "../src/sop/types.js";
import type { ToolExecutionContext } from "../src/tools/types.js";
import type { ToolRegistry } from "../src/tools/registry.js";
import type { ModelMessage } from "../src/models/types.js";
import type { AgentSession } from "../runtime/session.js";
import type { Skill } from "../src/skills/types.js";

function makeSOPSpec(id: string, name: string): SOPSpec {
  return {
    id,
    version: "1.0.0",
    name,
    description: `SOP: ${name}`,
    params: { type: "object", properties: { input: { type: "string", description: "Input" } } },
    steps: [{ id: "s1", name: "S1", description: "Step 1", action: { type: "prompt", template: "Do: {{params.input}}" } }],
  };
}

function makeSkill(id: string, name: string, tags: string[] = []): Skill {
  return sopToSkill(makeSOPSpec(id, name), { tags });
}

function makeSession(): AgentSession {
  return {
    id: "session-1",
    agent: {
      id: "test-agent",
      version: "1.0.0",
      name: "Test Agent",
      kind: "baseline",
      model: { provider: "test", model: "test" },
      prompts: { system: "You are a test agent." },
      tools: { allowedTools: ["skill"] },
      runtime: { maxTurns: 5 },
    },
    task: {
      id: "task-1",
      type: "general",
      title: "Test Task",
      prompt: "Test",
      scoring: { method: "rubric", config: {} },
    },
    messages: [{ role: "system", content: "You are a test agent." }],
    entries: [],
    startTime: Date.now(),
    turnCount: 0,
    toolCallCount: 0,
  };
}

describe("createSkillTool", () => {
  it("creates a skill tool with correct metadata", () => {
    const bank = new MemorySkillBank();
    const tool = createSkillTool({ bank, toolRegistry: {} as ToolRegistry });
    expect(tool.name).toBe("skill");
    expect(tool.permission.defaultDecision).toBe("allow");
    expect(tool.permission.riskLevel).toBe("low");
    expect(tool.concurrency).toBe("sequential");
    expect(tool.metadata).toEqual({ kind: "skill" });
  });

  describe("list action", () => {
    it("lists all active skills when no query", async () => {
      const bank = new MemorySkillBank();
      bank.upsert(makeSkill("alpha", "Alpha", ["tag1"]));
      bank.upsert(makeSkill("beta", "Beta", ["tag2"]));
      const tool = createSkillTool({ bank, toolRegistry: {} as ToolRegistry });

      const result = await tool.execute({ action: "list" });
      const parsed = JSON.parse(result as string);
      expect(parsed.skills).toHaveLength(2);
      expect(parsed.skills[0].id).toBe("alpha");
      expect(parsed.skills[1].id).toBe("beta");
    });

    it("searches skills by query", async () => {
      const bank = new MemorySkillBank();
      bank.upsert(makeSkill("alpha", "Alpha"));
      bank.upsert(makeSkill("beta", "Beta"));
      const tool = createSkillTool({ bank, toolRegistry: {} as ToolRegistry });

      const result = await tool.execute({ action: "list", query: "alpha" });
      const parsed = JSON.parse(result as string);
      expect(parsed.skills).toHaveLength(1);
      expect(parsed.skills[0].id).toBe("alpha");
    });

    it("returns hint when no skills match", async () => {
      const bank = new MemorySkillBank();
      const tool = createSkillTool({ bank, toolRegistry: {} as ToolRegistry });

      const result = await tool.execute({ action: "list", query: "nonexistent" });
      const parsed = JSON.parse(result as string);
      expect(parsed.skills).toEqual([]);
      expect(parsed.hint).toContain("nonexistent");
    });

    it("returns hint when bank is empty", async () => {
      const bank = new MemorySkillBank();
      const tool = createSkillTool({ bank, toolRegistry: {} as ToolRegistry });

      const result = await tool.execute({ action: "list" });
      const parsed = JSON.parse(result as string);
      expect(parsed.skills).toEqual([]);
    });
  });

  describe("run action", () => {
    it("returns error when skillId is missing", async () => {
      const bank = new MemorySkillBank();
      const tool = createSkillTool({ bank, toolRegistry: {} as ToolRegistry });

      const result = await tool.execute({ action: "run" });
      const parsed = JSON.parse(result as string);
      expect(parsed.error).toContain("skillId is required");
    });

    it("returns error when skill not found", async () => {
      const bank = new MemorySkillBank();
      const tool = createSkillTool({ bank, toolRegistry: {} as ToolRegistry });

      const result = await tool.execute({ action: "run", skillId: "nonexistent" });
      const parsed = JSON.parse(result as string);
      expect(parsed.error).toContain("Skill not found");
    });

    it("returns error for unknown action", async () => {
      const bank = new MemorySkillBank();
      const tool = createSkillTool({ bank, toolRegistry: {} as ToolRegistry });

      const result = await tool.execute({ action: "unknown" as "list" });
      const parsed = JSON.parse(result as string);
      expect(parsed.error).toContain("Unknown action");
    });
  });
});

describe("createSkillContextTransform", () => {
  it("returns messages unchanged when no skills", () => {
    const bank = new MemorySkillBank();
    const transform = createSkillContextTransform(bank);
    const messages: ModelMessage[] = [{ role: "system", content: "You are an agent." }];
    const session = makeSession();

    const result = transform(messages, session);
    expect(result).toBe(messages);
  });

  it("injects skill listing into system message", () => {
    const bank = new MemorySkillBank();
    bank.upsert(makeSkill("test-skill", "Test Skill", ["test"]));
    const transform = createSkillContextTransform(bank);
    const messages: ModelMessage[] = [{ role: "system", content: "You are an agent." }];
    const session = makeSession();

    const result = transform(messages, session);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toContain("<skills_instructions>");
    expect(result[0]!.content).toContain("test-skill");
    expect(result[0]!.content).toContain("Test Skill");
    expect(result[0]!.content).toContain("[test]");
  });

  it("prepends system message when none exists", () => {
    const bank = new MemorySkillBank();
    bank.upsert(makeSkill("a", "A"));
    const transform = createSkillContextTransform(bank);
    const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];
    const session = makeSession();

    const result = transform(messages, session);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("system");
    expect(result[0]!.content).toContain("<skills_instructions>");
    expect(result[1]!.role).toBe("user");
  });
});

describe("buildSkillListingBlock", () => {
  it("formats skills with tags", () => {
    const skills = [makeSkill("a", "Alpha", ["t1", "t2"]), makeSkill("b", "Beta")];
    const block = buildSkillListingBlock(skills);
    expect(block).toContain("<skills_instructions>");
    expect(block).toContain("a: Alpha");
    expect(block).toContain("[t1, t2]");
    expect(block).toContain("b: Beta");
    expect(block).toContain("</skills_instructions>");
  });
});
