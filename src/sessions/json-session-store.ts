import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSessionStore, StoredAgentSession } from "./session-store.js";

export class JsonSessionStore implements AgentSessionStore {
	constructor(private readonly root: string) {}

	async loadSession(id: string): Promise<StoredAgentSession | undefined> {
		try {
			return JSON.parse(await readFile(this.sessionPath(id), "utf8")) as StoredAgentSession;
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
	}

	async saveSession(session: StoredAgentSession): Promise<void> {
		await mkdir(this.root, { recursive: true });
		await writeFile(this.sessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
	}

	private sessionPath(id: string): string {
		return path.join(this.root, `${safeSessionId(id)}.json`);
	}
}

function safeSessionId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
