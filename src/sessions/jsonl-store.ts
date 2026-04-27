import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTaskRunResult, SuiteRunResult } from "../benchmark/types.js";
import type { RunStore } from "./run-store.js";

export type JsonlRunStoreRecord =
	| { type: "task_run"; run: AgentTaskRunResult }
	| { type: "suite_run"; run: SuiteRunResult };

export class JsonlRunStore implements RunStore {
	constructor(private readonly filePath: string) {}

	async saveTaskRun(run: AgentTaskRunResult): Promise<void> {
		await this.append({ type: "task_run", run });
	}

	async saveSuiteRun(run: SuiteRunResult): Promise<void> {
		await this.append({ type: "suite_run", run });
	}

	async readRecords(): Promise<JsonlRunStoreRecord[]> {
		let content: string;
		try {
			content = await readFile(this.filePath, "utf-8");
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}

		return content
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as JsonlRunStoreRecord);
	}

	private async append(record: JsonlRunStoreRecord): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
