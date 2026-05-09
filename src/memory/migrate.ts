import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryItem, StoredMemoryLayer } from "./types.js";

const storedLayers: readonly StoredMemoryLayer[] = ["episode", "knowledge", "doctrine"];

/**
 * Migrate all JSONL memory files from a JsonMemoryStore root directory
 * to a new SQLite database in the same location.
 *
 * After migration, memory.db will contain all data and the .jsonl files
 * are left intact (not deleted) so you can verify before cleanup.
 */
export async function migrateJsonlToSqlite(root: string): Promise<{ agents: number; items: number }> {
	const store = new SqliteMemoryStore(root);
	let totalItems = 0;
	let agentCount = 0;

	// Find all agent directories
	let entries: string[];
	try {
		const dirEntries = await readdir(root, { withFileTypes: true });
		entries = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return { agents: 0, items: 0 };
	}

	for (const agentId of entries) {
		const agentDir = path.join(root, agentId);
		let hasData = false;

		for (const layer of [...storedLayers, "quarantine" as const]) {
			const jsonlPath = path.join(agentDir, `${layer}.jsonl`);
			try {
				const content = await readFile(jsonlPath, "utf8");
				const items = parseJsonl(content, agentId);
				if (items.length > 0) hasData = true;
				for (const item of items) {
					await store.append(item);
					totalItems++;
				}
			} catch {
				// File doesn't exist - skip
			}
		}

		if (hasData) agentCount++;
	}

	store.close();
	return { agents: agentCount, items: totalItems };
}

function parseJsonl(content: string, agentId: string): MemoryItem[] {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const item = JSON.parse(line) as MemoryItem;
			// Ensure agentId matches directory name if not set
			if (!item.agentId) item.agentId = agentId;
			return item;
		});
}
