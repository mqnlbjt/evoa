import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadBenchmarkSuite } from "../src/benchmark/loader.js";
import type { BenchmarkSuite } from "../src/benchmark/types.js";

export async function loadAllTaskSuites(suitesDir: string): Promise<BenchmarkSuite[]> {
  const files = (await readdir(suitesDir)).filter((f) => f.endsWith(".json")).sort();
  const suites: BenchmarkSuite[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(suitesDir, file), "utf-8");
    suites.push(loadBenchmarkSuite(JSON.parse(raw)));
  }
  return suites;
}

export async function loadTaskSuite(suitesDir: string, id: string): Promise<BenchmarkSuite> {
  const filePath = path.join(suitesDir, `${id}.json`);
  const raw = await readFile(filePath, "utf-8");
  return loadBenchmarkSuite(JSON.parse(raw));
}
