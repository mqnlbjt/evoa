import { generateAndWriteSuite } from "../src/tasks/generator.js";

const args = process.argv.slice(2);
const params: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg.startsWith("--")) {
    const key = arg.slice(2);
    const val = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : "";
    params[key] = val;
  }
}

const dimension = params.dimension;
if (!dimension) {
  console.error("Usage: npx tsx tasks/generate.ts --dimension <name> [--count <n>] [--model <m>] [--max-tokens <n>] [--force]");
  console.error("Dimensions: tool-orchestration, context-compression, error-recovery, permission-boundary, subtask-decomposition, long-range-memory");
  process.exit(1);
}

const suite = await generateAndWriteSuite({
  dimension,
  taskCount: params.count ? Number(params.count) : 2,
  model: params.model || undefined,
  force: params.force !== undefined,
  maxTokens: params["max-tokens"] ? Number(params["max-tokens"]) : undefined,
});

const taskIds = suite.tasks.map((t) => t.id).join(", ");
console.log(`Generated suite "${suite.name}" with tasks: ${taskIds}`);
