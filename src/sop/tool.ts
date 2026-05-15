/**
 * SOP Tool Adapter
 *
 * Wraps an SOPSpec as an EvolvingAgentTool, allowing SOPs to be called
 * by agents through the standard ToolRegistry mechanism.
 */

import type { EvolvingAgentTool, ToolExecutionContext } from "../tools/types.js";
import type { SOPSpec } from "./types.js";
import { runSOP, type SOPRunOptions } from "./runner.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface CreateSopToolOptions {
  spec: SOPSpec;
  /** ToolRegistry used to execute SOP step actions. */
  toolRegistry: ToolRegistry;
  /** Optional fallback for running sub-SOPs from this tool. */
  runSubSOP?: SOPRunOptions["runSubSOP"];
}

export function createSopTool(options: CreateSopToolOptions): EvolvingAgentTool {
  const { spec, toolRegistry, runSubSOP } = options;

  return {
    name: `sop_${spec.id}`,
    description: spec.description,
    inputSchema: spec.params,
    permission: { defaultDecision: "allow", riskLevel: "medium" },
    concurrency: "sequential",
    ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    metadata: { kind: "sop", sopId: spec.id, sopVersion: spec.version },

    async execute(input: unknown, signal?: AbortSignal, context?: ToolExecutionContext) {
      const params = (input ?? {}) as Record<string, unknown>;

      const result = await runSOP(spec, {
        params,
        session: context!.session,
        toolRegistry,
        ...(signal ? { signal } : {}),
        ...(runSubSOP ? { runSubSOP } : {}),
      });

      return result;
    },
  };
}
