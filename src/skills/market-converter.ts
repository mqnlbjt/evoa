/**
 * Market SKILL.md Converter
 *
 * Converts third-party SKILL.md files to the internal SOPSpec format.
 * SKILL.md has YAML frontmatter + Markdown body; the body becomes a
 * single prompt-action SOP step.
 */

import { readFile } from "node:fs/promises";
import type { SOPSpec, SOPSchema } from "../sop/types.js";

export interface MarketSkillConfig {
  name: string;
  description: string;
  params?: Record<string, {
    type: string;
    description: string;
    required?: boolean;
  }>;
  tools?: string[];
  timeoutMs?: number;
  tags?: string[];
  triggers?: string[];
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

export async function parseMarketSkillContent(markdown: string): Promise<{ config: MarketSkillConfig; body: string }> {
  const match = markdown.match(FRONTMATTER_RE);
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter delimited by ---");

  let frontmatter: string;
  try {
    frontmatter = match[1]!;
  } catch {
    throw new Error("Failed to extract YAML frontmatter from SKILL.md");
  }

  let body = markdown.slice(match[0].length).trim();
  if (!body) body = "";

  const config = await parseYamlFrontmatter(frontmatter);
  return { config, body };
}

export function marketSkillToSopSpec(config: MarketSkillConfig, body: string, id?: string): SOPSpec {
  const skillId = id ?? slug(config.name);
  const params = config.params ?? {};

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, def] of Object.entries(params)) {
    properties[key] = { type: def.type, description: def.description };
    if (def.required) required.push(key);
  }

  const inputSchema: SOPSchema = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };

  const steps = buildSteps(skillId, config, body);

  return {
    id: skillId,
    version: "1.0.0",
    name: config.name,
    description: config.description,
    params: inputSchema,
    steps,
    executionMode: "continue_on_failure",
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
  };
}

export async function loadMarketSkillFromFile(filePath: string): Promise<{ config: MarketSkillConfig; sop: SOPSpec }> {
  const raw = await readFile(filePath, "utf-8");
  const { config, body } = await parseMarketSkillContent(raw);
  const sop = marketSkillToSopSpec(config, body);
  return { config, sop };
}

function buildSteps(skillId: string, config: MarketSkillConfig, body: string) {
  const steps: SOPSpec["steps"] = [];

  if (config.tools?.length) {
    const missingTools = config.tools.filter(
      (tool) => tool !== "read_file" && tool !== "grep" && tool !== "find_files" && tool !== "list_dir" && tool !== "bash" && tool !== "write_file" && tool !== "edit_file",
    );
    if (missingTools.length > 0) {
      steps.push({
        id: "check_tools",
        name: "Check required tools",
        description: "Verify that required tools are available in the registry",
        action: { type: "prompt", template: `Verify these tools are available: ${missingTools.join(", ")}` },
      });
    }
  }

  steps.push({
    id: "run",
    name: config.name,
    description: config.description,
    action: { type: "prompt", template: body },
    verification: {
      method: "regex",
      config: { pattern: ".+" },
    },
  });

  return steps;
}

async function parseYamlFrontmatter(frontmatter: string): Promise<MarketSkillConfig> {
  try {
    const { parse } = await import("yaml");
    const parsed = parse(frontmatter);
    if (!parsed || typeof parsed !== "object") throw new Error("frontmatter is not a YAML mapping");
    const config: MarketSkillConfig = { name: String(parsed.name ?? ""), description: String(parsed.description ?? "") };
    if (parsed.params != null) {
      const params = parsed.params as Record<string, { type: string; description: string; required?: boolean }>;
      config.params = params;
    }
    if (parsed.tools != null) {
      const tools = parsed.tools as string[];
      config.tools = tools;
    }
    if (parsed.timeoutMs != null) config.timeoutMs = Number(parsed.timeoutMs);
    if (parsed.tags != null) {
      const tags = parsed.tags as string[];
      config.tags = tags;
    }
    if (parsed.triggers != null) {
      const triggers = parsed.triggers as string[];
      config.triggers = triggers;
    }
    return config;
  } catch (error) {
    throw new Error(`Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
