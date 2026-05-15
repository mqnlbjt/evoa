import { describe, expect, it } from "vitest";
import { runSOP } from "../src/sop/runner.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { EvolvingAgentTool } from "../src/tools/types.js";
import type { SOPSpec } from "../src/sop/types.js";
import type { AgentSession } from "../src/runtime/session.js";

function mockTool(name: string): EvolvingAgentTool {
  return {
    name,
    description: `Mock tool ${name}`,
    permission: { defaultDecision: "allow", riskLevel: "low" },
    concurrency: "parallel-safe",
    async execute(input) {
      return { tool: name, input };
    },
  };
}

function mockSession(): AgentSession {
  return {
    id: "test-session",
    agent: {
      id: "test-agent",
      version: "1.0.0",
      name: "Test Agent",
      kind: "baseline",
      model: { provider: "fake", model: "fake" },
      prompts: { system: "" },
      tools: { allowedTools: ["*"], permissionMode: "allow" },
      runtime: {},
    },
    task: {
      id: "test-task",
      type: "general",
      title: "Test Task",
      prompt: "test",
      scoring: { method: "exact", maxScore: 1, config: { expected: "" } },
    },
    messages: [],
    trace: [],
    turnCount: 0,
    toolCallCount: 0,
  };
}

function makeSpec(overrides: Partial<SOPSpec> = {}): SOPSpec {
  return {
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
        action: { type: "tool", tool: "mock_a", input: { value: "hello" } },
      },
    ],
    ...overrides,
  };
}

describe("runSOP", () => {
  it("executes a single-step SOP", async () => {
    const registry = new ToolRegistry([mockTool("mock_a")]);
    const result = await runSOP(makeSpec(), {
      params: {},
      session: mockSession(),
      toolRegistry: registry,
    });

    expect(result.sopId).toBe("test-sop");
    expect(result.status).toBe("passed");
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]!.status).toBe("passed");
  });

  it("executes steps in dependency order", async () => {
    const registry = new ToolRegistry([mockTool("mock_a"), mockTool("mock_b")]);
    const executed: string[] = [];

    const toolA: EvolvingAgentTool = {
      name: "mock_a",
      description: "",
      permission: { defaultDecision: "allow", riskLevel: "low" },
      concurrency: "sequential",
      async execute() {
        executed.push("a");
        return "a-output";
      },
    };
    const toolB: EvolvingAgentTool = {
      name: "mock_b",
      description: "",
      permission: { defaultDecision: "allow", riskLevel: "low" },
      concurrency: "sequential",
      async execute() {
        executed.push("b");
        return "b-output";
      },
    };

    const spec = makeSpec({
      steps: [
        { id: "a", name: "A", description: "", action: { type: "tool", tool: "mock_a", input: {} } },
        { id: "b", name: "B", description: "", dependsOn: ["a"], action: { type: "tool", tool: "mock_b", input: {} } },
      ],
    });

    const result = await runSOP(spec, {
      params: {},
      session: mockSession(),
      toolRegistry: new ToolRegistry([toolA, toolB]),
    });

    expect(executed).toEqual(["a", "b"]);
    expect(result.status).toBe("passed");
    expect(result.stepResults).toHaveLength(2);
  });

  it("resolves params interpolation", async () => {
    const tool: EvolvingAgentTool = {
      name: "echo",
      description: "",
      permission: { defaultDecision: "allow", riskLevel: "low" },
      concurrency: "sequential",
      async execute(input) {
        return input;
      },
    };

    const spec = makeSpec({
      params: { type: "object", properties: { name: { type: "string" } } },
      steps: [
        { id: "s1", name: "S1", description: "", action: { type: "tool", tool: "echo", input: { message: "hello {{params.name}}" } } },
      ],
    });

    const result = await runSOP(spec, {
      params: { name: "world" },
      session: mockSession(),
      toolRegistry: new ToolRegistry([tool]),
    });

    expect(result.stepResults[0]!.output).toEqual({ message: "hello world" });
  });

  it("resolves step output interpolation", async () => {
    const toolA: EvolvingAgentTool = {
      name: "mock_a",
      description: "",
      permission: { defaultDecision: "allow", riskLevel: "low" },
      concurrency: "sequential",
      async execute() {
        return { result: 42 };
      },
    };
    const toolB: EvolvingAgentTool = {
      name: "mock_b",
      description: "",
      permission: { defaultDecision: "allow", riskLevel: "low" },
      concurrency: "sequential",
      async execute(input) {
        return input;
      },
    };

    const spec = makeSpec({
      steps: [
        { id: "a", name: "A", description: "", action: { type: "tool", tool: "mock_a", input: {} } },
        { id: "b", name: "B", description: "", dependsOn: ["a"], action: { type: "tool", tool: "mock_b", input: { value: "{{steps.a.output}}" } } },
      ],
    });

    const result = await runSOP(spec, {
      params: {},
      session: mockSession(),
      toolRegistry: new ToolRegistry([toolA, toolB]),
    });

    // step b should have received the JSON-stringified output of step a
    expect(result.stepResults[1]!.output).toEqual({ value: '{"result":42}' });
  });

  it("resolves nested step output path", async () => {
    const toolA: EvolvingAgentTool = {
      name: "mock_a",
      description: "",
      permission: { defaultDecision: "allow", riskLevel: "low" },
      concurrency: "sequential",
      async execute() {
        return { data: { nested: { value: 99 } } };
      },
    };
    const toolB: EvolvingAgentTool = {
      name: "mock_b",
      description: "",
      permission: { defaultDecision: "allow", riskLevel: "low" },
      concurrency: "sequential",
      async execute(input) {
        return input;
      },
    };

    const spec = makeSpec({
      steps: [
        { id: "a", name: "A", description: "", action: { type: "tool", tool: "mock_a", input: {} } },
        { id: "b", name: "B", description: "", dependsOn: ["a"], action: { type: "tool", tool: "mock_b", input: { value: "{{steps.a.output.data.nested.value}}" } } },
      ],
    });

    const result = await runSOP(spec, {
      params: {},
      session: mockSession(),
      toolRegistry: new ToolRegistry([toolA, toolB]),
    });

    expect(result.stepResults[1]!.output).toEqual({ value: "99" });
  });

  it("stop_on_failure skips remaining steps after error", async () => {
    const failTool: EvolvingAgentTool = {
      name: "fail",
      description: "",
      permission: { defaultDecision: "allow", riskLevel: "low" },
      concurrency: "sequential",
      async execute() {
        throw new Error("intentional failure");
      },
    };

    const spec: SOPSpec = {
      ...makeSpec(),
      executionMode: "stop_on_failure",
      steps: [
        { id: "a", name: "A", description: "", action: { type: "tool", tool: "fail", input: {} } },
        { id: "b", name: "B", description: "", action: { type: "tool", tool: "mock_a", input: {} } },
      ],
    };

    const result = await runSOP(spec, {
      params: {},
      session: mockSession(),
      toolRegistry: new ToolRegistry([failTool, mockTool("mock_a")]),
    });

    expect(result.stepResults[0]!.status).toBe("error");
    expect(result.stepResults[1]!.status).toBe("skipped");
    expect(result.status).toBe("failed");
  });

  it("continue_on_failure allows independent steps to run after failure", async () => {
    const failTool: EvolvingAgentTool = {
      name: "fail",
      description: "",
      permission: { defaultDecision: "allow", riskLevel: "low" },
      concurrency: "sequential",
      async execute() {
        throw new Error("intentional failure");
      },
    };

    const spec: SOPSpec = {
      ...makeSpec(),
      executionMode: "continue_on_failure",
      steps: [
        { id: "a", name: "A", description: "", action: { type: "tool", tool: "fail", input: {} } },
        { id: "b", name: "B", description: "", action: { type: "tool", tool: "mock_a", input: {} } },
        { id: "c", name: "C", description: "", dependsOn: ["a"], action: { type: "tool", tool: "mock_a", input: {} } },
      ],
    };

    const result = await runSOP(spec, {
      params: {},
      session: mockSession(),
      toolRegistry: new ToolRegistry([failTool, mockTool("mock_a")]),
    });

    expect(result.stepResults[0]!.status).toBe("error");   // a failed
    expect(result.stepResults[1]!.status).toBe("passed");  // b runs (independent)
    expect(result.stepResults[2]!.status).toBe("skipped"); // c skipped (depends on a)
    expect(result.status).toBe("partial");
  });

  it("throws on circular dependency in DAG", async () => {
    const spec = makeSpec({
      steps: [
        { id: "a", name: "A", description: "", dependsOn: ["b"], action: { type: "tool", tool: "mock_a", input: {} } },
        { id: "b", name: "B", description: "", dependsOn: ["a"], action: { type: "tool", tool: "mock_a", input: {} } },
      ],
    });

    await expect(
      runSOP(spec, {
        params: {},
        session: mockSession(),
        toolRegistry: new ToolRegistry([mockTool("mock_a")]),
      }),
    ).rejects.toThrow("circular dependency");
  });

  it("skips step with unmet precondition", async () => {
    const spec = makeSpec({
      steps: [
        {
          id: "s1",
          name: "S1",
          description: "",
          precondition: { type: "artifact_exists", config: { path: "/nonexistent/file" } },
          action: { type: "tool", tool: "mock_a", input: {} },
        },
      ],
    });

    const result = await runSOP(spec, {
      params: {},
      session: mockSession(),
      toolRegistry: new ToolRegistry([mockTool("mock_a")]),
    });

    expect(result.stepResults[0]!.status).toBe("skipped");
    expect(result.stepResults[0]!.error).toBe("precondition not met");
  });

  it("tool_available precondition passes when tool exists", async () => {
    const spec = makeSpec({
      steps: [
        {
          id: "s1",
          name: "S1",
          description: "",
          precondition: { type: "tool_available", config: { tool: "mock_a" } },
          action: { type: "tool", tool: "mock_a", input: {} },
        },
      ],
    });

    const result = await runSOP(spec, {
      params: {},
      session: mockSession(),
      toolRegistry: new ToolRegistry([mockTool("mock_a")]),
    });

    expect(result.stepResults[0]!.status).toBe("passed");
  });

  it("tool_available precondition fails when tool missing", async () => {
    const spec = makeSpec({
      steps: [
        {
          id: "s1",
          name: "S1",
          description: "",
          precondition: { type: "tool_available", config: { tool: "nonexistent" } },
          action: { type: "tool", tool: "mock_a", input: {} },
        },
      ],
    });

    const result = await runSOP(spec, {
      params: {},
      session: mockSession(),
      toolRegistry: new ToolRegistry([mockTool("mock_a")]),
    });

    expect(result.stepResults[0]!.status).toBe("skipped");
  });

  it("fails on unknown tool in action", async () => {
    const spec = makeSpec({
      steps: [
        { id: "s1", name: "S1", description: "", action: { type: "tool", tool: "nonexistent", input: {} } },
      ],
    });

    const result = await runSOP(spec, {
      params: {},
      session: mockSession(),
      toolRegistry: new ToolRegistry([]),
    });

    expect(result.stepResults[0]!.status).toBe("error");
    expect(result.stepResults[0]!.error).toContain("not found");
  });

  it("step verification passes on regex match", async () => {
    const echo: EvolvingAgentTool = {
      name: "echo",
      description: "",
      permission: { defaultDecision: "allow", riskLevel: "low" },
      concurrency: "sequential",
      async execute() {
        return "success output";
      },
    };

    const spec = makeSpec({
      steps: [
        {
          id: "s1",
          name: "S1",
          description: "",
          action: { type: "tool", tool: "echo", input: {} },
          verification: { method: "regex", config: { pattern: "success" } },
        },
      ],
    });

    const result = await runSOP(spec, {
      params: {},
      session: mockSession(),
      toolRegistry: new ToolRegistry([echo]),
    });

    expect(result.stepResults[0]!.status).toBe("passed");
    expect(result.stepResults[0]!.verification?.passed).toBe(true);
  });

  it("step verification fails on regex mismatch", async () => {
    const echo: EvolvingAgentTool = {
      name: "echo",
      description: "",
      permission: { defaultDecision: "allow", riskLevel: "low" },
      concurrency: "sequential",
      async execute() {
        return "wrong output";
      },
    };

    const spec = makeSpec({
      steps: [
        {
          id: "s1",
          name: "S1",
          description: "",
          action: { type: "tool", tool: "echo", input: {} },
          verification: { method: "regex", config: { pattern: "success" } },
        },
      ],
    });

    const result = await runSOP(spec, {
      params: {},
      session: mockSession(),
      toolRegistry: new ToolRegistry([echo]),
    });

    expect(result.stepResults[0]!.status).toBe("failed");
    expect(result.status).toBe("partial");
  });
});
