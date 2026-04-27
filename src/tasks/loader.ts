import { readFile } from "node:fs/promises";
import type { TaskSpec } from "../specs.js";
import { validateTaskSpec } from "./validation.js";

export async function loadTaskSpecFromFile(filePath: string): Promise<TaskSpec> {
	return loadTaskSpec(JSON.parse(await readFile(filePath, "utf-8")));
}

export function loadTaskSpec(value: unknown): TaskSpec {
	return validateTaskSpec(value);
}
