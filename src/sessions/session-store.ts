import type { ModelMessage } from "../models/types.js";
import type { ProviderFormat } from "../models/provider-types.js";
import type { ToolProfile } from "../tools/profiles.js";

export interface StoredAgentStartupContext {
	agentPath: string;
	provider: string;
	model: string;
	baseURL: string;
	providerFormat: ProviderFormat;
	toolProfile: ToolProfile;
	sessionDir?: string;
}

export interface StoredAgentSession {
	id: string;
	agentId: string;
	agentVersion?: string;
	messages: ModelMessage[];
	startupContext?: StoredAgentStartupContext;
	createdAt: number;
	updatedAt: number;
	metadata?: Record<string, unknown>;
}

export interface AgentSessionStore {
	loadSession(id: string): Promise<StoredAgentSession | undefined>;
	saveSession(session: StoredAgentSession): Promise<void>;
}
