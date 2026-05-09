import type { ModelMessage } from "../models/types.js";
import type { TraceEvent } from "../runtime/events.js";

export type MemoryLayer = "trace" | "episode" | "knowledge" | "doctrine";
export type StoredMemoryLayer = Exclude<MemoryLayer, "trace">;
export type MemoryStatus = "verified" | "quarantined" | "revoked";
export type MemoryScope = "user" | "project" | "agent" | "session";

export interface MemorySourceRef {
	kind: "message" | "trace_event" | "memory";
	id: string;
	sessionId?: string;
	traceEventId?: string;
	messageIndex?: number;
	layer?: MemoryLayer;
	excerptHash: string;
}

export interface MemoryItem {
	id: string;
	agentId: string;
	layer: StoredMemoryLayer;
	content: string;
	sourceRefs: MemorySourceRef[];
	confidence: number;
	status: MemoryStatus;
	createdAt: number;
	updatedAt: number;
	scope?: MemoryScope;
	metadata?: {
		topic?: string;
		sessionId?: string;
		stable?: boolean;
		reason?: string;
		key?: string;
		projectId?: string;
		expiresAt?: number;
		staleAfterMs?: number;
		priority?: number;
		supersedes?: string[];
	};
}

export interface MemoryCandidate {
	layer: StoredMemoryLayer;
	scope?: MemoryScope;
	content: string;
	sourceRefs: MemorySourceRef[];
	metadata?: MemoryItem["metadata"] & {
		suitability?: "long_term" | "quarantine";
		safety?: "safe" | "unsafe_or_sensitive";
	};
}

export interface MemoryExtractor {
	extract(input: MemoryTurnInput): Promise<MemoryCandidate[]>;
}

export interface MemoryVerification {
	confidence: number;
	status: Extract<MemoryStatus, "verified" | "quarantined">;
	issues: string[];
}

export interface MemoryStore {
	append(item: MemoryItem): Promise<void>;
	list(agentId: string, layer?: StoredMemoryLayer): Promise<MemoryItem[]>;
	latestVerified(agentId: string, options?: { perLayer?: number; maxItems?: number }): Promise<MemoryItem[]>;
	revokeBySource(agentId: string, sourceRef: MemorySourceRef): Promise<void>;
}

export interface MemoryContext {
	stable?: ModelMessage;
	dynamic?: ModelMessage;
	stableItemIds: string[];
	dynamicItemIds: string[];
}

export interface MemoryContextItems {
	stable: MemoryItem[];
	dynamic: MemoryItem[];
}

export interface MemoryContextRequest {
	agentId: string;
	sessionId?: string;
	projectId?: string;
	prompt: string;
	now: () => number;
	maxStableItems?: number;
	maxDynamicItems?: number;
	maxStableTokens?: number;
	maxDynamicTokens?: number;
	maxContextTokens?: number;
}

export interface MemorySearchRequest extends MemoryContextRequest {
	query: string;
	scope?: MemoryScope;
	layer?: StoredMemoryLayer;
	limit?: number;
}

export interface MemoryReadRequest extends MemoryContextRequest {
	ids: string[];
}

export interface ManualMemoryInput extends MemoryContextRequest {
	content: string;
	layer: StoredMemoryLayer;
	scope: MemoryScope;
	topic?: string;
	key?: string;
	stable?: boolean;
	reason?: string;
	supersedes?: string[];
	sourceRef: MemorySourceRef;
	createId: () => string;
}

export interface MemoryUpdateInput extends MemoryContextRequest {
	id: string;
	content: string;
	reason: string;
	topic?: string;
	key?: string;
	stable?: boolean;
	sourceRef: MemorySourceRef;
	createId: () => string;
}

export interface MemoryForgetInput extends MemoryContextRequest {
	ids: string[];
	reason: string;
	sourceRef: MemorySourceRef;
	createId: () => string;
}

export interface MemoryReadResult {
	items: MemoryItem[];
	missing: string[];
}

export interface MemoryForgetResult {
	revoked: string[];
	missing: string[];
}

export interface MemoryTurnInput {
	agentId: string;
	sessionId: string;
	projectId?: string;
	messages: ModelMessage[];
	trace: TraceEvent[];
	startMessageIndex: number;
	now: () => number;
	createId: () => string;
	force?: boolean;
}

export interface MemoryReplayResult {
	agentId: string;
	items: MemoryItem[];
	quarantined: MemoryItem[];
	warnings: string[];
}

export interface MemoryDiffSummary {
	added: string[];
	removed: string[];
	changed: string[];
	missingSourceRefs: string[];
	confidenceDrops: string[];
	doctrineChanges: string[];
}
