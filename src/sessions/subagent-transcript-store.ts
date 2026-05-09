import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TraceEvent } from "../runtime/events.js";
import type { SubagentTraceSummary } from "../tools/subagent.js";

export interface StoredSubagentSession {
	sessionId: string;
	parentSessionId: string;
	parentToolCallId: string;
	subagentId: string;
	agentId: string;
	taskId: string;
	trace: TraceEvent[];
	summary: SubagentTraceSummary;
	createdAt: number;
}

export interface SubagentTranscriptStore {
	saveTranscript(data: StoredSubagentSession): Promise<void>;
}

export class JsonlSubagentTranscriptStore implements SubagentTranscriptStore {
	private readonly baseDir: string;

	constructor(baseDir: string) {
		this.baseDir = baseDir;
	}

	async saveTranscript(data: StoredSubagentSession): Promise<void> {
		const subagentsDir = `${this.baseDir}/subagents`;
		await mkdir(subagentsDir, { recursive: true });
		const filePath = `${subagentsDir}/agent-${data.subagentId}-${data.sessionId}.jsonl`;
		await appendFile(filePath, `${JSON.stringify(data)}\n`, "utf-8");
	}
}
