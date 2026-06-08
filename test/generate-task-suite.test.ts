import { describe, expect, it, vi } from "vitest";
import { createGenerateTaskSuiteTool } from "../src/tools/generate-task-suite.js";

vi.mock("../src/tasks/generator.js", () => ({
  generateAndWriteSuite: vi.fn(),
}));

describe("createGenerateTaskSuiteTool", () => {
  const defaultOptions = {
    apiKey: "test-key",
    baseURL: "http://localhost:8317/v1",
    model: "deepseek-v4-pro",
  };

  function makeTool() {
    return createGenerateTaskSuiteTool(defaultOptions);
  }

  it("creates a tool with correct metadata", () => {
    const tool = makeTool();
    expect(tool.name).toBe("generate_task_suite");
    expect(tool.permission.riskLevel).toBe("medium");
    expect(tool.concurrency).toBe("sequential");
    expect(tool.timeoutMs).toBe(120_000);
  });

  it("inputSchema accepts valid dimension", () => {
    const tool = makeTool();
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    const dim = props.dimension as Record<string, unknown>;
    expect(dim.enum).toContain("tool-orchestration");
    expect(dim.enum).toContain("error-recovery");
  });

  it("rejects unknown dimension", async () => {
    const tool = makeTool();
    await expect(tool.execute({ dimension: "unknown" })).rejects.toThrow("Unknown dimension");
  });

  it("rejects taskCount out of range", async () => {
    const tool = makeTool();
    await expect(tool.execute({ dimension: "tool-orchestration", taskCount: 0 })).rejects.toThrow("taskCount");
    await expect(tool.execute({ dimension: "tool-orchestration", taskCount: 6 })).rejects.toThrow("taskCount");
  });

  it("calls generateAndWriteSuite with correct params", async () => {
    const { generateAndWriteSuite } = await import("../src/tasks/generator.js");
    const mockSuite = {
      id: "suite-test",
      name: "测试",
      tasks: [{ id: "task-001", type: "general", title: "Test", prompt: "Test", scoring: { method: "exact" as const, config: { expected: "x" } } }],
    };
    (generateAndWriteSuite as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockSuite);

    const tool = makeTool();
    const result = await tool.execute({ dimension: "error-recovery", taskCount: 3, force: true }) as { suiteId: string; name: string; taskCount: number; taskIds: string[] };

    expect(generateAndWriteSuite).toHaveBeenCalledWith(expect.objectContaining({
      dimension: "error-recovery",
      taskCount: 3,
      force: true,
      model: "deepseek-v4-pro",
      baseURL: "http://localhost:8317/v1",
      apiKey: "test-key",
    }));
    expect(result).toEqual({
      suiteId: "suite-test",
      name: "测试",
      taskCount: 1,
      taskIds: ["task-001"],
    });
  });

  it("works with default taskCount", async () => {
    const { generateAndWriteSuite } = await import("../src/tasks/generator.js");
    const mockSuite = {
      id: "suite-test",
      name: "测试",
      tasks: [],
    };
    (generateAndWriteSuite as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockSuite);

    const tool = makeTool();
    const result = await tool.execute({ dimension: "tool-orchestration" }) as { taskCount: number };

    expect(generateAndWriteSuite).toHaveBeenCalledWith(expect.objectContaining({ taskCount: 2, force: false }));
    expect(result.taskCount).toBe(0);
  });
});
