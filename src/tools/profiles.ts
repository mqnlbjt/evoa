import path from "node:path";
import { createDockerBashExecutor } from "./bash-executor.js";
import { ToolRegistry } from "./registry.js";
import { createReadOnlyTools, type ReadOnlyToolOptions } from "./read-only.js";
import { createCodingTools, createMutatingTools, type MutatingToolOptions } from "./mutating.js";
import { createMcpRuntimeBundle } from "../mcp/registry.js";
import type { McpServersConfig } from "../mcp/types.js";
import type { SandboxPolicy } from "./sandbox.js";
import { createTuiAutomationToolBundle, type TuiAutomationToolOptions } from "./tui-automation.js";
import { createGenerateTaskSuiteTool, type GenerateTaskSuiteOptions } from "./generate-task-suite.js";

export type ToolProfile = "read-only" | "coding" | "benchmark-sandbox" | "dangerous";

export interface ToolProfileOptions extends ReadOnlyToolOptions, MutatingToolOptions {
	profile?: ToolProfile;
	mcpServers?: McpServersConfig;
	tuiAutomation?: Omit<TuiAutomationToolOptions, "workspaceRoot">;
	generateTaskSuite?: GenerateTaskSuiteOptions;
}

export const toolProfiles: readonly ToolProfile[] = ["read-only", "coding", "benchmark-sandbox", "dangerous"];

export function parseToolProfile(value: string): ToolProfile | undefined {
	return isToolProfile(value) ? value : undefined;
}

export function isToolProfile(value: string): value is ToolProfile {
	return (toolProfiles as readonly string[]).includes(value);
}

export function createToolRegistryForProfile(options: ToolProfileOptions): ToolRegistry {
	const profile = options.profile ?? "read-only";
	const sandboxPolicy = sandboxPolicyForProfile(profile, options.workspaceRoot);
	const mutatingOptions = mutatingOptionsForProfile(options, sandboxPolicy);
	const tools = profile === "read-only"
		? createReadOnlyTools(options)
		: profile === "coding"
			? [...createReadOnlyTools(options), ...createCodingTools(mutatingOptions)]
			: [...createReadOnlyTools(options), ...createMutatingTools(mutatingOptions)];
	const registry = new ToolRegistry(tools, { sandboxPolicy });
	if (profile !== "read-only" && options.tuiAutomation) {
		const bundle = createTuiAutomationToolBundle({ ...options.tuiAutomation, workspaceRoot: options.workspaceRoot });
		for (const tool of bundle.tools) registry.register(tool);
		registry.registerDisposable(bundle.close);
	}
	if (profile !== "read-only" && profile !== "coding" && options.generateTaskSuite) {
		registry.register(createGenerateTaskSuiteTool(options.generateTaskSuite));
	}
	return registry;
}

export async function createToolRegistryForProfileAsync(options: ToolProfileOptions): Promise<ToolRegistry> {
	const registry = createToolRegistryForProfile(options);
	if (!options.mcpServers) return registry;
	const bundle = await createMcpRuntimeBundle({ servers: options.mcpServers });
	for (const tool of bundle.tools) registry.register(tool);
	registry.registerDisposable(bundle.close);
	return registry;
}

export function createToolRegistryWithBackgroundMcp(options: ToolProfileOptions): ToolRegistry {
	const registry = createToolRegistryForProfile(options);
	if (!options.mcpServers) return registry;
	createMcpRuntimeBundle({ servers: options.mcpServers }).then((bundle) => {
		for (const tool of bundle.tools) registry.register(tool);
		registry.registerDisposable(bundle.close);
	}).catch(() => {});
	return registry;
}

function sandboxPolicyForProfile(profile: ToolProfile, workspaceRoot: string): SandboxPolicy {
	const root = path.resolve(workspaceRoot);
	if (profile === "coding") return { mode: "workspace", workspaceRoot: root, allowNetwork: true, allowBash: false };
	if (profile === "benchmark-sandbox") return { mode: "workspace", workspaceRoot: root, allowNetwork: false, allowBash: true };
	return { mode: "off", workspaceRoot: root, allowNetwork: true, allowBash: true };
}

function mutatingOptionsForProfile(options: ToolProfileOptions, sandboxPolicy: SandboxPolicy): MutatingToolOptions {
	if (options.bashExecutor || sandboxPolicy.mode !== "docker" || !sandboxPolicy.dockerContainer) return options;
	return { ...options, bashExecutor: createDockerBashExecutor({ container: sandboxPolicy.dockerContainer }) };
}
