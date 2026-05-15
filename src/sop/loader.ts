/**
 * SOP Loader
 *
 * Loads SOP specifications from YAML files and directories.
 * Follows the existing JSON loader pattern (e.g. agents/loader.ts).
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validateSOPSpec, type ValidateOptions } from "./validator.js";
import type { SOPSpec } from "./types.js";

export interface LoadOptions extends ValidateOptions {}

export async function loadSopSpecFromFile(filePath: string, options: LoadOptions = {}): Promise<SOPSpec> {
  const raw = await readFile(filePath, "utf-8");
  const parsed = await parseYaml(raw, filePath);
  return validateSOPSpec(parsed, options);
}

export async function loadSopSpecsFromDirectory(dirPath: string, options: LoadOptions = {}): Promise<SOPSpec[]> {
  let entries: { isFile: () => boolean; name: string }[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const sopFiles = entries
    .filter((e) => e.isFile() && (e.name.endsWith(".sop.yaml") || e.name.endsWith(".sop.yml")))
    .map((e) => join(dirPath, e.name))
    .sort();

  const specs: SOPSpec[] = [];
  const seenIds = new Set<string>();

  for (const filePath of sopFiles) {
    const spec = await loadSopSpecFromFile(filePath, options);
    if (seenIds.has(spec.id)) {
      throw new Error(`Duplicate SOP id "${spec.id}" in ${filePath}`);
    }
    seenIds.add(spec.id);
    specs.push(spec);
  }

  return specs;
}

async function parseYaml(raw: string, filePath: string): Promise<unknown> {
  try {
    const { parse } = await import("yaml");
    return parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse YAML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
