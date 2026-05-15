/**
 * SOP Registry
 *
 * Loads SOP specifications from a directory, wraps each as an
 * EvolvingAgentTool, and registers them in a ToolRegistry.
 */

import { loadSopSpecsFromDirectory, type LoadOptions } from "./loader.js";
import { createSopTool, type CreateSopToolOptions } from "./tool.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SOPSpec } from "./types.js";

export interface SopRegistryOptions {
  /** Directory containing *.sop.yaml / *.sop.yml files */
  sopDir: string;
  /** Target ToolRegistry where SOP tools will be registered */
  toolRegistry: ToolRegistry;
  /** Loader options (knownTools, etc.) */
  loadOptions?: LoadOptions;
  /** Fallback for running sub-SOPs */
  runSubSOP?: CreateSopToolOptions["runSubSOP"];
}

export class SopRegistry {
  private specs = new Map<string, SOPSpec>();

  get(id: string): SOPSpec | undefined {
    return this.specs.get(id);
  }

  list(): SOPSpec[] {
    return Array.from(this.specs.values());
  }

  /**
   * Load SOP YAML files from sopDir, validate, create tools, and
   * register into the target ToolRegistry.
   */
  async loadAndRegister(options: SopRegistryOptions): Promise<void> {
    const specs = await loadSopSpecsFromDirectory(options.sopDir, options.loadOptions);

    for (const spec of specs) {
      this.specs.set(spec.id, spec);

      const tool = createSopTool({
        spec,
        toolRegistry: options.toolRegistry,
        runSubSOP: options.runSubSOP,
      });

      options.toolRegistry.register(tool);
    }
  }
}
