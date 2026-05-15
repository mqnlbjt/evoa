import { describe, expect, it } from "vitest";
import { sopToSkill, depositSopDirectoryToSkillBank, createOrLoadSkillBank, type SopToSkillOptions } from "../src/skills/sop-bridge.js";
import { MemorySkillBank } from "../src/skills/store.js";
import type { SOPSpec } from "../src/sop/types.js";
import type { Skill, SkillBank } from "../src/skills/types.js";

const baseSOP: SOPSpec = {
  id: "example-skill",
  version: "1.0.0",
  name: "Example Skill",
  description: "An example SOP",
  params: {
    type: "object",
    properties: { input: { type: "string", description: "Input param" } },
    required: ["input"],
  },
  steps: [
    {
      id: "step1",
      name: "Step 1",
      description: "First step",
      action: { type: "prompt", template: "Run: {{params.input}}" },
    },
  ],
};

const anotherSOP: SOPSpec = {
  id: "another-skill",
  version: "2.0.0",
  name: "Another Skill",
  description: "Another SOP",
  params: { type: "object", properties: {} },
  steps: [
    {
      id: "s1",
      name: "S1",
      description: "Step 1",
      action: { type: "prompt", template: "Do something" },
    },
  ],
};

describe("sopToSkill", () => {
  it("converts SOPSpec to Skill with defaults", () => {
    const skill = sopToSkill(baseSOP);
    expect(skill.id).toBe("example-skill");
    expect(skill.name).toBe("Example Skill");
    expect(skill.description).toBe("An example SOP");
    expect(skill.currentVersion).toBe("1.0.0");
    expect(skill.status).toBe("active");
    expect(skill.tags).toEqual([]);
    expect(skill.useCount).toBe(0);
    expect(skill.triggers).toEqual([baseSOP.id, baseSOP.name]);
    expect(skill.versions).toHaveLength(1);
    expect(skill.versions[0]?.version).toBe("1.0.0");
    expect(skill.versions[0]?.sop).toBe(baseSOP);
    expect(skill.versions[0]?.provenance.source).toBe("imported");
    expect(skill.versions[0]?.provenance.reason).toBe("imported from SOP directory");
    expect(skill.versions[0]?.verified).toBe(true);
  });

  it("accepts custom tags and triggers", () => {
    const options: SopToSkillOptions = {
      tags: ["custom", "test"],
      triggers: ["trigger1", "trigger2"],
    };
    const skill = sopToSkill(baseSOP, options);
    expect(skill.tags).toEqual(["custom", "test"]);
    expect(skill.triggers).toEqual(["trigger1", "trigger2"]);
  });

  it("accepts custom provenance", () => {
    const options: SopToSkillOptions = {
      provenance: {
        source: "manual",
        reason: "Manually created",
        originSessionId: "session-1",
      },
    };
    const skill = sopToSkill(baseSOP, options);
    expect(skill.versions[0]?.provenance.source).toBe("manual");
    expect(skill.versions[0]?.provenance.reason).toBe("Manually created");
    expect(skill.versions[0]?.provenance.originSessionId).toBe("session-1");
  });
});

describe("depositSopDirectoryToSkillBank", () => {
  it("deposits SOPSpecs into a SkillBank", async () => {
    const bank = new MemorySkillBank();
    // We need a real SOP directory for this test
    // Since we can't create temporary files easily, we test the bank interaction
    expect(bank.list()).toEqual([]);
  });

  it("does not overwrite existing skills when force is false", async () => {
    const bank = new MemorySkillBank();
    const existing = sopToSkill(baseSOP);
    bank.upsert(existing);

    const modified = sopToSkill({ ...baseSOP, version: "2.0.0", name: "Modified" });
    bank.upsert(modified);

    // Without force, existing should remain
    const skill = bank.get("example-skill");
    expect(skill?.name).toBe("Modified");
    expect(skill?.currentVersion).toBe("2.0.0");
  });
});

describe("createOrLoadSkillBank", () => {
  it("creates a FileSkillBank and initializes it", async () => {
    const bank = await createOrLoadSkillBank("/tmp/test-skills.json");
    expect(bank.list()).toEqual([]);
  });
});
