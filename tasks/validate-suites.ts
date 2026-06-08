import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "suites");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
let totalTasks = 0;

for (const f of files) {
  const raw = readFileSync(path.join(dir, f), "utf-8");
  const suite = JSON.parse(raw);
  const count = suite.tasks.length;
  totalTasks += count;
  const taskIds = suite.tasks.map((t) => t.id);
  console.log(`${suite.name} (${count} tasks): ${taskIds.join(", ")}`);
}
console.log(`Total: ${totalTasks} tasks across ${files.length} suites`);
