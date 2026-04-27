import type { AgentTaskRunResult, SuiteRunResult } from "../benchmark/types.js";

export interface RunStore {
	saveTaskRun(run: AgentTaskRunResult): Promise<void>;
	saveSuiteRun(run: SuiteRunResult): Promise<void>;
}

export class MemoryRunStore implements RunStore {
	readonly taskRuns: AgentTaskRunResult[] = [];
	readonly suiteRuns: SuiteRunResult[] = [];

	async saveTaskRun(run: AgentTaskRunResult): Promise<void> {
		this.taskRuns.push(run);
	}

	async saveSuiteRun(run: SuiteRunResult): Promise<void> {
		this.suiteRuns.push(run);
	}
}
