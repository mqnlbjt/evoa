/**
 * Skill Tool
 *
 * Universal "skill" tool for skill discovery and execution.
 * Follows Claude Code's SkillTool pattern: list action for discovery,
 * run action for delegated execution through the SOP engine.
 */

import type { EvolvingAgentTool, ToolExecutionContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ModelMessage } from "../models/types.js";
import type { AgentSession } from "../runtime/session.js";
import { runSOP, type SOPRunOptions } from "../sop/runner.js";
import type { SkillBank, Skill } from "./types.js";

export interface SkillToolInput {
  action: "list" | "run";
  query?: string;
  skillId?: string;
  params?: Record<string, unknown>;
}

export interface CreateSkillToolOptions {
  bank: SkillBank;
  toolRegistry: ToolRegistry;
  runSubSOP?: SOPRunOptions["runSubSOP"];
}

export function createSkillTool(options: CreateSkillToolOptions): EvolvingAgentTool {
  const { bank, toolRegistry, runSubSOP } = options;

  return {
    name: "skill",
    description: "List and run skills. action='list' to discover skills by keyword; action='run' to execute a skill by ID with optional params.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "run"],
          description: "Action: 'list' to search/discover skills, 'run' to execute a specific skill",
        },
        query: {
          type: "string",
          description: "Search query keyword(s) for listing matching skills",
        },
        skillId: {
          type: "string",
          description: "ID of the skill to execute (required for action='run')",
        },
        params: {
          type: "object",
          description: "Parameters to pass to the skill on execution",
        },
      },
      required: ["action"],
    },
    permission: { defaultDecision: "allow", riskLevel: "low" },
    concurrency: "sequential",
    metadata: { kind: "skill" },

    async execute(input: unknown, signal?: AbortSignal, context?: ToolExecutionContext) {
      const { action, query, skillId, params } = (input ?? {}) as SkillToolInput;

      if (action === "list") {
        return formatSkillList(bank, query);
      }

      if (action === "run") {
        if (!skillId) return JSON.stringify({ error: "skillId is required for action=run" });
        return runSkill(bank, toolRegistry, skillId, params ?? {}, context, signal, runSubSOP);
      }

      return JSON.stringify({ error: `Unknown action: ${String(action)}` });
    },
  };
}

function formatSkillList(bank: SkillBank, query?: string): string {
  const skills = query ? bank.search(query) : bank.list({ status: "active" });

  if (skills.length === 0) {
    return JSON.stringify({ skills: [], hint: query ? `No skills matching "${query}"` : "No skills available" });
  }

  const items = skills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    tags: s.tags,
    triggers: s.triggers,
  }));

  return JSON.stringify({ skills: items });
}

async function runSkill(
  bank: SkillBank,
  toolRegistry: ToolRegistry,
  skillId: string,
  params: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
  signal: AbortSignal | undefined,
  runSubSOP: SOPRunOptions["runSubSOP"],
): Promise<string> {
  const skill = bank.get(skillId);
  if (!skill) {
    return JSON.stringify({ error: `Skill not found: ${skillId}` });
  }

  if (skill.status !== "active") {
    return JSON.stringify({ error: `Skill ${skillId} is ${skill.status}`, hint: "Use skill action=list to find active alternatives" });
  }

  const version = skill.versions.find((v) => v.version === skill.currentVersion);
  if (!version) {
    return JSON.stringify({ error: `Skill ${skillId} has no version matching ${skill.currentVersion}` });
  }

  if (!context?.session) {
    return JSON.stringify({ error: "Skill execution requires an active agent session" });
  }

  try {
    const result = await runSOP(version.sop, {
      params,
      session: context.session,
      toolRegistry,
      ...(signal ? { signal } : {}),
      ...(runSubSOP ? { runSubSOP } : {}),
    });

    return JSON.stringify({ skillId, skillName: skill.name, result });
  } catch (err) {
    return JSON.stringify({
      skillId,
      skillName: skill.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── contextTransform ────────────────────────────────────────

export function createSkillContextTransform(bank: SkillBank) {
  return (messages: ModelMessage[], _session: AgentSession): ModelMessage[] => {
    const skills = bank.list({ status: "active" });
    if (skills.length === 0) return messages;

    const listing = buildSkillListingBlock(skills);
    const systemIdx = messages.findIndex((m) => m.role === "system");

    if (systemIdx >= 0) {
      const updated = [...messages];
      updated[systemIdx] = { ...updated[systemIdx]!, content: `${updated[systemIdx]!.content}\n\n${listing}` };
      return updated;
    }

    return [{ role: "system", content: listing }, ...messages];
  };
}

function buildSkillListingBlock(skills: Skill[]): string {
  const lines = skills.map((s) => `- ${s.id}: ${s.name} — ${s.description}${s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : ""}`);
  return `<skills_instructions>\nAvailable skills (use the \`skill\` tool with action="list" for details, action="run" to execute):\n${lines.join("\n")}\n</skills_instructions>`;
}

export { buildSkillListingBlock };
