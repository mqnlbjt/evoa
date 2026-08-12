import type { ModelMessage } from "../models/types.js";
import type { ProviderConfig, ProviderFormat } from "../models/provider-types.js";
import type { SessionEntry } from "../runtime/session.js";
import type { ModelRoutingSpec } from "../specs.js";
import type { ToolProfile } from "../tools/profiles.js";

export interface StoredAgentStartupContext {
	agentPath: string;
	provider: string;
	model: string;
	baseURL: string;
	providerFormat: ProviderFormat;
	providers?: Record<string, ProviderConfig>;
	modelRouting?: ModelRoutingSpec;
	toolProfile: ToolProfile;
	sessionDir?: string;
}

export type StoredSessionEntry = SessionEntry;

export interface StoredAgentSession {
	id: string;
	agentId: string;
	agentVersion?: string;
	schemaVersion?: 2;
	messages?: ModelMessage[];
	entries?: StoredSessionEntry[];
	startupContext?: StoredAgentStartupContext;
	createdAt: number;
	updatedAt: number;
	metadata?: Record<string, unknown>;
	/** 会话统计持久化数据（token 用量等），由 ChatState.serializeStats 产出。 */
	statsData?: Record<string, unknown>;
}

export interface AgentSessionStore {
	loadSession(id: string): Promise<StoredAgentSession | undefined>;
	saveSession(session: StoredAgentSession): Promise<void>;
}
