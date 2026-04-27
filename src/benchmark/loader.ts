import { readFile } from "node:fs/promises";
import type { BenchmarkSuite } from "./types.js";
import { validateBenchmarkSuite } from "./validation.js";

export async function loadBenchmarkSuiteFromFile(filePath: string): Promise<BenchmarkSuite> {
	return loadBenchmarkSuite(JSON.parse(await readFile(filePath, "utf-8")));
}

export function loadBenchmarkSuite(value: unknown): BenchmarkSuite {
	return validateBenchmarkSuite(value);
}
