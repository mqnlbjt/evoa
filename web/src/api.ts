import type { EvolutionHistoryRecord, SessionSummary } from "./types";

async function getJson<T>(path: string): Promise<T> {
	const response = await fetch(path);
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return (await response.json()) as T;
}

export interface ToolInfo {
	name: string;
	description: string;
	concurrency: number;
	timeoutMs?: number;
}

export const api = {
	listSessions: (): Promise<SessionSummary[]> => getJson<SessionSummary[]>("/api/sessions"),
	sessionDetail: (id: string): Promise<unknown> => getJson<unknown>(`/api/sessions/${encodeURIComponent(id)}`),
	tools: (): Promise<ToolInfo[]> => getJson<ToolInfo[]>("/api/tools"),
	evolution: (historyPath: string): Promise<EvolutionHistoryRecord[]> => getJson<EvolutionHistoryRecord[]>(`/api/evolution?path=${encodeURIComponent(historyPath)}`),
	memory: (query: string): Promise<{ enabled: boolean; query?: string; items?: unknown }> => getJson(`/api/memory?query=${encodeURIComponent(query)}`),
};
