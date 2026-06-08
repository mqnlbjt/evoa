import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateAndWriteSuite } from "../tasks/generator.js";
import { EvolvingAgentTool, ToolExecutionContext } from "./types.js";
import { objectInput, optionalBooleanField, optionalNumberField, stringField } from "./workspace.js";

export interface GenerateTaskSuiteOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  suitesDir?: string;
  maxTokens?: number;
}

const DIMENSIONS = [
  "tool-orchestration",
  "context-compression",
  "error-recovery",
  "permission-boundary",
  "subtask-decomposition",
  "long-range-memory",
] as const;

export function createGenerateTaskSuiteTool(options: GenerateTaskSuiteOptions): EvolvingAgentTool {
  const suitesDir = options.suitesDir ?? path.resolve(fileURLToPath(import.meta.url), "../../../tasks/suites");

  return {
    name: "generate_task_suite",
    description:
      "生成新的 benchmark 题目 suite，写入 tasks/suites/ 目录。支持 6 个压力维度：tool-orchestration（工具编排）、context-compression（上下文压缩）、error-recovery（错误恢复）、permission-boundary（权限边界）、subtask-decomposition（子任务拆分）、long-range-memory（长程记忆）。",
    inputSchema: {
      type: "object",
      properties: {
        dimension: { type: "string", enum: DIMENSIONS, description: "压力维度" },
        taskCount: { type: "number", description: "题目数量，默认 2，范围 1-5" },
        force: { type: "boolean", description: "是否覆盖已有文件，默认 false" },
      },
      required: ["dimension"],
      additionalProperties: false,
    },
    permission: {
      defaultDecision: "allow",
      riskLevel: "medium",
    },
    concurrency: "sequential",
    timeoutMs: 120_000,

    async execute(input, _signal, _context: ToolExecutionContext | undefined) {
      const parsed = objectInput(input);
      const dimension = stringField(parsed, "dimension");
      const taskCount = optionalNumberField(parsed, "taskCount") ?? 2;
      const force = optionalBooleanField(parsed, "force") ?? false;

      if (!DIMENSIONS.includes(dimension as (typeof DIMENSIONS)[number])) {
        throw new Error(`Unknown dimension: ${dimension}. Valid: ${DIMENSIONS.join(", ")}`);
      }
      if (taskCount < 1 || taskCount > 5) {
        throw new Error("taskCount must be between 1 and 5");
      }

      const suite = await generateAndWriteSuite({
        dimension,
        taskCount,
        force,
        model: options.model,
        baseURL: options.baseURL,
        apiKey: options.apiKey,
        suitesDir,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      });

      return {
        suiteId: suite.id,
        name: suite.name,
        taskCount: suite.tasks.length,
        taskIds: suite.tasks.map((t) => t.id),
      };
    },
  };
}
