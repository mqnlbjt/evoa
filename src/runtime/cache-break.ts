import type { ModelToolDefinition } from "../models/types.js";

export interface CacheBreakResult {
	broken: boolean;
	reason: "content_changed" | "cache_evicted" | "none";
	previousCacheReadTokens?: number;
	currentCacheReadTokens?: number;
	previousSystemHash?: string;
	currentSystemHash?: string;
	previousToolHash?: string;
	currentToolHash?: string;
}

export interface CacheSnapInput {
	systemContent: string;
	toolDefinitions: ModelToolDefinition[];
	cacheReadTokens: number | undefined;
}

export class CacheBreakDetector {
	private lastSystemHash: string | undefined;
	private lastToolHash: string | undefined;
	private lastCacheReadTokens: number | undefined;

	detect(input: CacheSnapInput): CacheBreakResult {
		const currentSystemHash = computeContentHash(input.systemContent);
		const currentToolHash = computeToolHash(input.toolDefinitions);
		const currentCacheReadTokens = input.cacheReadTokens ?? 0;

		const result: CacheBreakResult = {
			broken: false,
			reason: "none",
			currentSystemHash,
			currentToolHash,
			currentCacheReadTokens,
		};
		if (this.lastCacheReadTokens !== undefined) result.previousCacheReadTokens = this.lastCacheReadTokens;
		if (this.lastSystemHash !== undefined) result.previousSystemHash = this.lastSystemHash;
		if (this.lastToolHash !== undefined) result.previousToolHash = this.lastToolHash;

		if (this.lastSystemHash !== undefined && this.lastSystemHash !== currentSystemHash) {
			result.broken = true;
			result.reason = "content_changed";
		} else if (this.lastToolHash !== undefined && this.lastToolHash !== currentToolHash) {
			result.broken = true;
			result.reason = "content_changed";
		} else if (this.lastCacheReadTokens !== undefined && this.lastCacheReadTokens > 0 && currentCacheReadTokens < this.lastCacheReadTokens * 0.5) {
			result.broken = true;
			result.reason = "cache_evicted";
		}

		this.lastSystemHash = currentSystemHash;
		this.lastToolHash = currentToolHash;
		if (currentCacheReadTokens > 0 || this.lastCacheReadTokens === undefined) {
			this.lastCacheReadTokens = currentCacheReadTokens;
		}

		return result;
	}

	reset(): void {
		this.lastSystemHash = undefined;
		this.lastToolHash = undefined;
		this.lastCacheReadTokens = undefined;
	}
}

export function computeContentHash(content: string): string {
	return djb2a(content);
}

export function computeToolHash(tools: ModelToolDefinition[]): string {
	if (tools.length === 0) return "no-tools";
	const normalized = tools
		.map((t) => `${t.name}:${JSON.stringify(t.inputSchema ?? {})}`)
		.sort()
		.join("|");
	return djb2a(normalized);
}

function djb2a(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i += 1) {
		hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
		hash = hash >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
