import type { ModelMessage } from "../models/types.js";
import type { TraceEvent } from "../runtime/events.js";
import { ruleBasedMemoryExtractor } from "./extractor.js";
import type { MemoryExtractor, MemoryItem, MemoryReplayResult } from "./types.js";
import { verifyMemoryCandidate } from "./verifier.js";

export async function replayMemory(input: { agentId: string; sessionId: string; projectId?: string; messages: ModelMessage[]; trace?: TraceEvent[]; now?: () => number; createId?: () => string; extractor?: MemoryExtractor }): Promise<MemoryReplayResult> {
	const now = input.now ?? (() => 0);
	const createId = input.createId ?? sequentialId();
	const warnings: string[] = [];
	const items: MemoryItem[] = [];
	const quarantined: MemoryItem[] = [];
	const extractor = input.extractor ?? ruleBasedMemoryExtractor;
	for (const candidate of await extractor.extract({ agentId: input.agentId, sessionId: input.sessionId, ...(input.projectId ? { projectId: input.projectId } : {}), messages: input.messages, trace: input.trace ?? [], startMessageIndex: 0, now, createId })) {
		const verification = verifyMemoryCandidate(candidate);
		const item: MemoryItem = {
			id: createId(),
			agentId: input.agentId,
			layer: candidate.layer,
			...(candidate.scope ? { scope: candidate.scope } : {}),
			content: candidate.content,
			sourceRefs: candidate.sourceRefs,
			confidence: verification.confidence,
			status: verification.status,
			createdAt: now(),
			updatedAt: now(),
			metadata: { ...candidate.metadata, ...(candidate.scope === "project" && input.projectId ? { projectId: input.projectId } : {}), ...(verification.issues.length > 0 ? { reason: verification.issues.join("; ") } : {}) },
		};
		if (item.sourceRefs.length === 0) warnings.push(`memory ${item.id} has no sourceRefs`);
		if (item.status === "verified") items.push(item);
		else quarantined.push(item);
	}
	return { agentId: input.agentId, items, quarantined, warnings };
}

function sequentialId(): () => string {
	let index = 0;
	return () => `memory-replay-${++index}`;
}
