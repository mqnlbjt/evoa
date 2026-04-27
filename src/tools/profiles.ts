import { ToolRegistry } from "./registry.js";
import { createReadOnlyTools, type ReadOnlyToolOptions } from "./read-only.js";
import { createCodingTools, createMutatingTools, type MutatingToolOptions } from "./mutating.js";

export type ToolProfile = "read-only" | "coding" | "benchmark-sandbox" | "dangerous";

export interface ToolProfileOptions extends ReadOnlyToolOptions, MutatingToolOptions {
	profile?: ToolProfile;
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
	if (profile === "read-only") return new ToolRegistry(createReadOnlyTools(options));
	if (profile === "coding") return new ToolRegistry([...createReadOnlyTools(options), ...createCodingTools(options)]);
	return new ToolRegistry([...createReadOnlyTools(options), ...createMutatingTools(options)]);
}
