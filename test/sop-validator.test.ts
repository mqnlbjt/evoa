import { describe, expect, it } from "vitest";
import { validateSOPSpec } from "../src/sop/validator.js";
import type { SOPSpec } from "../src/sop/types.js";

const baseSpec: SOPSpec = {
  id: "test-sop",
  version: "1.0.0",
  name: "Test SOP",
  description: "A test SOP",
  params: { type: "object", properties: {} },
  steps: [
    {
      id: "step1",
      name: "Step 1",
      description: "First step",
      action: { type: "tool", tool: "bash", input: { command: "echo hello" } },
    },
  ],
};

describe("validateSOPSpec", () => {
  it("accepts a valid spec", () => {
    expect(() => validateSOPSpec(baseSpec)).not.toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => validateSOPSpec(null)).toThrow("must be an object");
    expect(() => validateSOPSpec("string")).toThrow("must be an object");
  });

  it("rejects missing required fields", () => {
    expect(() => validateSOPSpec({ ...baseSpec, id: "" })).toThrow("missing required field");
    expect(() => validateSOPSpec({ ...baseSpec, version: "" })).toThrow("missing required field");
    expect(() => validateSOPSpec({ ...baseSpec, name: "" })).toThrow("missing required field");
  });

  it("rejects params without type: object", () => {
    const invalid = { ...baseSpec, params: { type: "string" } };
    expect(() => validateSOPSpec(invalid)).toThrow('params.type must be "object"');
  });

  it("rejects missing params", () => {
    const { params: _, ...noParams } = baseSpec;
    expect(() => validateSOPSpec(noParams)).toThrow("params");
  });

  it("rejects empty steps", () => {
    expect(() => validateSOPSpec({ ...baseSpec, steps: [] })).toThrow("non-empty array");
  });

  it("rejects steps that are not an array", () => {
    expect(() => validateSOPSpec({ ...baseSpec, steps: "not-array" })).toThrow("non-empty array");
  });

  it("rejects duplicate step IDs", () => {
    const dup = {
      ...baseSpec,
      steps: [
        { id: "same", name: "A", description: "", action: { type: "tool", tool: "bash", input: {} } },
        { id: "same", name: "B", description: "", action: { type: "tool", tool: "bash", input: {} } },
      ],
    };
    expect(() => validateSOPSpec(dup)).toThrow('duplicate step id "same"');
  });

  it("rejects step with missing action", () => {
    const invalid = {
      ...baseSpec,
      steps: [{ id: "s1", name: "No action", description: "" }],
    };
    expect(() => validateSOPSpec(invalid)).toThrow("action");
  });

  it("rejects tool action with empty tool name", () => {
    const invalid = {
      ...baseSpec,
      steps: [{ id: "s1", name: "Bad tool", description: "", action: { type: "tool", tool: "" } }],
    };
    expect(() => validateSOPSpec(invalid)).toThrow('requires "tool"');
  });

  it("rejects prompt action with missing template", () => {
    const invalid = {
      ...baseSpec,
      steps: [{ id: "s1", name: "Bad prompt", description: "", action: { type: "prompt" } }],
    };
    expect(() => validateSOPSpec(invalid)).toThrow("template");
  });

  it("rejects sub_sop action with missing sopId", () => {
    const invalid = {
      ...baseSpec,
      steps: [{ id: "s1", name: "Bad sub", description: "", action: { type: "sub_sop", sopId: "" } }],
    };
    expect(() => validateSOPSpec(invalid)).toThrow("sopId");
  });

  it("rejects unknown action type", () => {
    const invalid = {
      ...baseSpec,
      steps: [{ id: "s1", name: "Unknown", description: "", action: { type: "unknown" } }],
    };
    expect(() => validateSOPSpec(invalid)).toThrow("unknown action type");
  });

  it("rejects dependsOn referencing non-existent step", () => {
    const invalid = {
      ...baseSpec,
      steps: [
        { id: "s1", name: "S1", description: "", dependsOn: ["nonexistent"], action: { type: "tool", tool: "bash", input: {} } },
      ],
    };
    expect(() => validateSOPSpec(invalid)).toThrow('references undefined step "nonexistent"');
  });

  it("rejects self-referencing dependsOn", () => {
    const invalid = {
      ...baseSpec,
      steps: [
        { id: "s1", name: "S1", description: "", dependsOn: ["s1"], action: { type: "tool", tool: "bash", input: {} } },
      ],
    };
    expect(() => validateSOPSpec(invalid)).toThrow("cannot reference itself");
  });

  it("accepts dependsOn referencing steps defined later in array", () => {
    const valid = {
      ...baseSpec,
      steps: [
        { id: "s2", name: "S2", description: "", dependsOn: ["s1"], action: { type: "tool", tool: "bash", input: {} } },
        { id: "s1", name: "S1", description: "", action: { type: "tool", tool: "bash", input: {} } },
      ],
    };
    expect(() => validateSOPSpec(valid)).not.toThrow();
  });

  it("detects circular dependency (A->B->A)", () => {
    const invalid = {
      ...baseSpec,
      steps: [
        { id: "a", name: "A", description: "", dependsOn: ["b"], action: { type: "tool", tool: "bash", input: {} } },
        { id: "b", name: "B", description: "", dependsOn: ["a"], action: { type: "tool", tool: "bash", input: {} } },
      ],
    };
    expect(() => validateSOPSpec(invalid)).toThrow("circular dependency");
  });

  it("detects circular dependency of length 3", () => {
    const invalid = {
      ...baseSpec,
      steps: [
        { id: "a", name: "A", description: "", dependsOn: ["b"], action: { type: "tool", tool: "bash", input: {} } },
        { id: "b", name: "B", description: "", dependsOn: ["c"], action: { type: "tool", tool: "bash", input: {} } },
        { id: "c", name: "C", description: "", dependsOn: ["a"], action: { type: "tool", tool: "bash", input: {} } },
      ],
    };
    expect(() => validateSOPSpec(invalid)).toThrow("circular dependency");
  });

  it("validates unknown tools when knownTools is provided", () => {
    const invalid = {
      ...baseSpec,
      steps: [{ id: "s1", name: "S1", description: "", action: { type: "tool", tool: "nonexistent", input: {} } }],
    };
    expect(() => validateSOPSpec(invalid, { knownTools: new Set(["bash", "grep"]) })).toThrow('unknown tool "nonexistent"');
  });

  it("accepts known tools when knownTools is provided", () => {
    expect(() => validateSOPSpec(baseSpec, { knownTools: new Set(["bash", "grep"]) })).not.toThrow();
  });

  it("rejects invalid executionMode", () => {
    const invalid = { ...baseSpec, executionMode: "never_stop" };
    expect(() => validateSOPSpec(invalid)).toThrow("executionMode");
  });

  it("accepts valid executionMode values", () => {
    expect(() => validateSOPSpec({ ...baseSpec, executionMode: "stop_on_failure" })).not.toThrow();
    expect(() => validateSOPSpec({ ...baseSpec, executionMode: "continue_on_failure" })).not.toThrow();
  });

  it("rejects negative timeoutMs", () => {
    expect(() => validateSOPSpec({ ...baseSpec, timeoutMs: -1 })).toThrow("timeoutMs");
    expect(() => validateSOPSpec({ ...baseSpec, timeoutMs: 0 })).toThrow("timeoutMs");
  });

  it("accepts valid timeoutMs", () => {
    expect(() => validateSOPSpec({ ...baseSpec, timeoutMs: 5000 })).not.toThrow();
  });

  it("rejects dependsOn that is not an array", () => {
    const invalid = {
      ...baseSpec,
      steps: [
        { id: "s1", name: "S1", description: "", dependsOn: "s2", action: { type: "tool", tool: "bash", input: {} } },
        { id: "s2", name: "S2", description: "", action: { type: "tool", tool: "bash", input: {} } },
      ],
    };
    expect(() => validateSOPSpec(invalid)).toThrow("dependsOn");
  });
});
