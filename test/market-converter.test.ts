import { describe, expect, it } from "vitest";
import { parseMarketSkillContent, marketSkillToSopSpec } from "../src/skills/market-converter.js";
import type { SOPSpec } from "../src/sop/types.js";

const basicSKILL = `---
name: Example Skill
description: An example SKILL.md for testing
params:
  input_file:
    type: string
    description: Path to input file
    required: true
  verbose:
    type: boolean
    description: Enable verbose output
tools:
  - bash
  - read_file
timeoutMs: 30000
tags:
  - example
  - testing
triggers:
  - example
  - test
---

This is the body of the skill. It contains instructions.
`;

const minimalSKILL = `---
name: Minimal
description: Minimal skill
---

Body content.
`;

describe("parseMarketSkillContent", () => {
  it("parses YAML frontmatter and body", async () => {
    const { config, body } = await parseMarketSkillContent(basicSKILL);
    expect(config.name).toBe("Example Skill");
    expect(config.description).toBe("An example SKILL.md for testing");
    expect(config.params).toEqual({
      input_file: { type: "string", description: "Path to input file", required: true },
      verbose: { type: "boolean", description: "Enable verbose output" },
    });
    expect(config.tools).toEqual(["bash", "read_file"]);
    expect(config.timeoutMs).toBe(30000);
    expect(config.tags).toEqual(["example", "testing"]);
    expect(config.triggers).toEqual(["example", "test"]);
    expect(body).toBe("This is the body of the skill. It contains instructions.");
  });

  it("parses minimal frontmatter", async () => {
    const { config, body } = await parseMarketSkillContent(minimalSKILL);
    expect(config.name).toBe("Minimal");
    expect(config.description).toBe("Minimal skill");
    expect(body).toBe("Body content.");
  });

  it("rejects markdown without frontmatter", async () => {
    await expect(parseMarketSkillContent("Just plain markdown")).rejects.toThrow("SKILL.md must start with YAML frontmatter");
  });

  it("rejects empty input", async () => {
    await expect(parseMarketSkillContent("")).rejects.toThrow("SKILL.md must start with YAML frontmatter");
  });

  it("handles empty body", async () => {
    const md = "---\nname: NoBody\ndescription: No body skill\n---\n";
    const { config, body } = await parseMarketSkillContent(md);
    expect(config.name).toBe("NoBody");
    expect(body).toBe("");
  });
});

describe("marketSkillToSopSpec", () => {
  it("converts MarketSkillConfig to SOPSpec", () => {
    const config = {
      name: "Test Skill",
      description: "A test skill",
      params: {
        input: { type: "string", description: "Input param" },
        flag: { type: "boolean", description: "A flag", required: true },
      },
      tools: ["bash", "read_file"],
      timeoutMs: 5000,
    };
    const body = "Execute the following steps:\n1. Read the input file\n2. Run the command";

    const sop = marketSkillToSopSpec(config, body, "custom-id");

    expect(sop.id).toBe("custom-id");
    expect(sop.version).toBe("1.0.0");
    expect(sop.name).toBe("Test Skill");
    expect(sop.description).toBe("A test skill");

    // params schema
    expect(sop.params.type).toBe("object");
    expect(sop.params.properties).toHaveProperty("input");
    expect(sop.params.properties).toHaveProperty("flag");
    expect(sop.params.required).toEqual(["flag"]);

    // steps
    const promptStep = sop.steps[sop.steps.length - 1];
    expect(promptStep?.id).toBe("run");
    expect(promptStep?.action.type).toBe("prompt");
    expect(promptStep?.action.template).toBe(body);
    expect(promptStep?.verification?.method).toBe("regex");

    // timeout
    expect(sop.timeoutMs).toBe(5000);
  });

  it("generates slug id when no id provided", () => {
    const config = { name: "My Example Skill!", description: "Desc" };
    const sop = marketSkillToSopSpec(config, "body");
    expect(sop.id).toBe("my-example-skill");
  });

  it("does not include required when no required params", () => {
    const config = {
      name: "No Required",
      description: "No required params",
      params: { opt: { type: "string", description: "Optional" } },
    };
    const sop = marketSkillToSopSpec(config, "body");
    expect(sop.params.required).toBeUndefined();
  });

  it("generates check_tools step for unknown tools", () => {
    const config = {
      name: "Tool Check",
      description: "Checks tools",
      tools: ["bash", "unknown_tool", "another_unknown"],
    };
    const sop = marketSkillToSopSpec(config, "body");
    const checkStep = sop.steps.find((s) => s.id === "check_tools");
    expect(checkStep).toBeDefined();
    expect(checkStep?.action.template).toContain("unknown_tool");
    expect(checkStep?.action.template).toContain("another_unknown");
  });

  it("skips check_tools for known tools only", () => {
    const config = {
      name: "Known Tools",
      description: "Only known tools",
      tools: ["bash", "read_file", "write_file", "grep", "edit_file", "find_files", "list_dir"],
    };
    const sop = marketSkillToSopSpec(config, "body");
    const checkStep = sop.steps.find((s) => s.id === "check_tools");
    expect(checkStep).toBeUndefined();
  });
});
