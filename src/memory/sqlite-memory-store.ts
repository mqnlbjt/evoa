import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { MemoryItem, MemoryScope, MemorySourceRef, MemoryStore, StoredMemoryLayer } from "./types.js";

const storedLayers: readonly StoredMemoryLayer[] = ["episode", "knowledge", "doctrine"];

interface SqliteSearchOptions {
	scope?: string;
	layer?: StoredMemoryLayer;
	limit?: number;
}

/**
 * SQLite + FTS5 backed memory store.
 *
 * Drop-in replacement for JsonMemoryStore with O(1) indexed search
 * instead of O(n) JSONL full-scan.
 *
 * Uses better-sqlite3 (synchronous API wrapped in Promises) for
 * simplicity and performance. FTS5 provides built-in BM25 scoring.
 */
export class SqliteMemoryStore implements MemoryStore {
	private db: Database.Database;
	private readonly agentRootDir: string;

	constructor(root: string) {
		this.agentRootDir = root;
		this.db = this.openDb(root);
	}

	// ── MemoryStore interface ────────────────────────────────────

	async append(item: MemoryItem): Promise<void> {
		const db = this.dbForAgent(item.agentId);
		const stmt = db.prepare(`
			INSERT OR REPLACE INTO memories (
				id, agent_id, layer, content, source_refs, confidence, status,
				created_at, updated_at, scope, metadata,
				topic, stable, project_id, session_id, key_field
			) VALUES (
				?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?,
				?, ?, ?, ?, ?
			)
		`);
		const m = item.metadata;
		stmt.run(
			item.id,
			item.agentId,
			item.layer,
			item.content,
			JSON.stringify(item.sourceRefs),
			item.confidence,
			item.status,
			item.createdAt,
			item.updatedAt,
			item.scope ?? null,
			m ? JSON.stringify(m) : null,
			m?.topic ?? null,
			m?.stable === true ? 1 : 0,
			m?.projectId ?? null,
			m?.sessionId ?? null,
			m?.key ?? null,
		);

		// Sync to FTS index
		const ftsStmt = db.prepare(`
			INSERT INTO memories_fts (id, content, topic) VALUES (?, ?, ?)
		`);
		ftsStmt.run(item.id, item.content, m?.topic ?? "");
	}

	async list(agentId: string, layer?: StoredMemoryLayer): Promise<MemoryItem[]> {
		const db = this.dbForAgent(agentId);
		if (layer) {
			const rows = db
				.prepare("SELECT * FROM memories WHERE agent_id = ? AND layer = ?")
				.all(agentId, layer) as RawRow[];
			return rows.map(rowToItem);
		}
		const rows = db
			.prepare("SELECT * FROM memories WHERE agent_id = ?")
			.all(agentId) as RawRow[];
		return rows.map(rowToItem).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	async latestVerified(agentId: string, options: { perLayer?: number; maxItems?: number } = {}): Promise<MemoryItem[]> {
		const perLayer = options.perLayer ?? 10;
		const db = this.dbForAgent(agentId);
		const items: MemoryItem[] = [];
		for (const layer of storedLayers) {
			const rows = db
				.prepare(
					"SELECT * FROM memories WHERE agent_id = ? AND layer = ? AND status = 'verified' ORDER BY updated_at DESC, id DESC LIMIT ?"
				)
				.all(agentId, layer, perLayer) as RawRow[];
			items.push(...rows.map(rowToItem));
		}
		return items.slice(0, options.maxItems ?? items.length);
	}

	async revokeBySource(agentId: string, sourceRef: MemorySourceRef): Promise<void> {
		const db = this.dbForAgent(agentId);
		// Find verified items matching the source ref
		const allItems = db
			.prepare("SELECT * FROM memories WHERE agent_id = ? AND status = 'verified'")
			.all(agentId) as RawRow[];
		const matching = allItems
			.map(rowToItem)
			.filter((item) => item.sourceRefs.some((ref) => sameSource(ref, sourceRef)));

		const now = Date.now();
		for (const item of matching) {
			const revokedId = `${item.id}:revoked:${now}`;
			const revoked: MemoryItem = {
				id: revokedId,
				agentId: item.agentId,
				layer: item.layer,
				content: item.content,
				sourceRefs: item.sourceRefs,
				confidence: item.confidence,
				status: "revoked",
				createdAt: item.createdAt,
				updatedAt: now,
			};
			if (item.scope) revoked.scope = item.scope;
			if (item.metadata) revoked.metadata = { ...item.metadata, reason: "source revoked" };
			await this.append(revoked);
		}
	}

	// ── FTS5-powered search (beyond MemoryStore interface) ───────

	async search(query: string, options: SqliteSearchOptions & { agentId: string }): Promise<MemoryItem[]> {
		const db = this.dbForAgent(options.agentId);
		const limit = Math.min(options.limit ?? 20, 50);

		// Build FTS5 query - handle CJK bigrams and multi-word queries
		const ftsQuery = buildFtsQuery(query);
		if (!ftsQuery) return [];

		// Use FTS5 bm25() for ranking. Negative scores = better match.
		let sql = `
			SELECT m.*, bm25(memories_fts) AS rank
			FROM memories_fts
			JOIN memories m ON m.id = memories_fts.id
			WHERE memories_fts MATCH ?
				AND m.agent_id = ?
				AND m.status = 'verified'
		`;
		const params: unknown[] = [ftsQuery, options.agentId];

		if (options.scope) {
			sql += " AND m.scope = ?";
			params.push(options.scope);
		}
		if (options.layer) {
			sql += " AND m.layer = ?";
			params.push(options.layer);
		}

		sql += " ORDER BY rank ASC LIMIT ?";
		params.push(limit);

		try {
			const rows = db.prepare(sql).all(...params) as (RawRow & { rank: number })[];
			return rows.map(rowToItem);
		} catch {
			// FTS query syntax error - fall back to simple LIKE search
			return this.searchLike(query, options);
		}
	}

	private searchLike(query: string, options: SqliteSearchOptions & { agentId: string }): MemoryItem[] {
		const db = this.dbForAgent(options.agentId);
		const limit = Math.min(options.limit ?? 20, 50);
		const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 2).slice(0, 8);
		if (terms.length === 0) return [];

		let sql = "SELECT * FROM memories WHERE agent_id = ? AND status = 'verified'";
		const params: unknown[] = [options.agentId];

		for (const term of terms) {
			sql += " AND LOWER(content) LIKE ?";
			params.push(`%${term}%`);
		}
		if (options.scope) {
			sql += " AND scope = ?";
			params.push(options.scope);
		}
		if (options.layer) {
			sql += " AND layer = ?";
			params.push(options.layer);
		}
		sql += " ORDER BY updated_at DESC LIMIT ?";
		params.push(limit);

		const rows = db.prepare(sql).all(...params) as RawRow[];
		return rows.map(rowToItem);
	}

	// ── Maintenance ──────────────────────────────────────────────

	compact(): void {
		// Vacuum the database to reclaim space
		this.db.exec("VACUUM");
	}

	close(): void {
		this.db.close();
	}

	// ── Internal helpers ─────────────────────────────────────────

	private openDb(root: string): Database.Database {
		// For multi-agent support, we use a single DB file at the root
		const dbPath = path.join(root, "memory.db");
		const dir = path.dirname(dbPath);

		// Ensure directory exists (sync since better-sqlite3 is sync)
		mkdirSync(dir, { recursive: true });

		const db = new Database(dbPath);
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		this.initializeSchema(db);
		return db;
	}

	private initializeSchema(db: Database.Database): void {
		db.exec(`
			CREATE TABLE IF NOT EXISTS memories (
				id TEXT PRIMARY KEY,
				agent_id TEXT NOT NULL,
				layer TEXT NOT NULL,
				content TEXT NOT NULL,
				source_refs TEXT NOT NULL,
				confidence REAL NOT NULL,
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				scope TEXT,
				metadata TEXT,
				topic TEXT,
				stable INTEGER DEFAULT 0,
				project_id TEXT,
				session_id TEXT,
				key_field TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_memories_agent_layer ON memories(agent_id, layer);
			CREATE INDEX IF NOT EXISTS idx_memories_agent_status ON memories(agent_id, status);
			CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
		`);

		// Check if FTS table exists
		const ftsExists = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
			.get();
		if (!ftsExists) {
			db.exec(`
				CREATE VIRTUAL TABLE memories_fts USING fts5(
					id UNINDEXED,
					content,
					topic,
					tokenize='unicode61'
				);
			`);

			// Populate FTS from existing data
			db.exec(`
				INSERT INTO memories_fts (id, content, topic)
				SELECT id, content, COALESCE(topic, '') FROM memories;
			`);
		}
	}

	/** Return a database handle. Currently all agents share one DB. */
	private dbForAgent(_agentId: string): Database.Database {
		return this.db;
	}
}

// ── Row mapping ──────────────────────────────────────────────────

interface RawRow {
	id: string;
	agent_id: string;
	layer: StoredMemoryLayer;
	content: string;
	source_refs: string;
	confidence: number;
	status: string;
	created_at: number;
	updated_at: number;
	scope: string | null;
	metadata: string | null;
	topic: string | null;
	stable: number;
	project_id: string | null;
	session_id: string | null;
	key_field: string | null;
}

function rowToItem(row: RawRow): MemoryItem {
	const meta = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined;
	const item: MemoryItem = {
		id: row.id,
		agentId: row.agent_id,
		layer: row.layer,
		content: row.content,
		sourceRefs: JSON.parse(row.source_refs) as MemorySourceRef[],
		confidence: row.confidence,
		status: row.status as MemoryItem["status"],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	if (row.scope) item.scope = row.scope as MemoryScope;
	if (meta) item.metadata = meta as NonNullable<MemoryItem["metadata"]>;
	return item;
}

function sameSource(left: MemorySourceRef, right: MemorySourceRef): boolean {
	return left.kind === right.kind && left.id === right.id && left.excerptHash === right.excerptHash;
}

// ── FTS5 query builder ───────────────────────────────────────────

function buildFtsQuery(input: string): string {
	const terms: string[] = [];
	for (const raw of input.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
		if (raw.length < 2) continue;
		terms.push(raw);
		// CJK bigrams for Chinese/Japanese/Korean text
		if (/\p{Script=Han}/u.test(raw)) {
			for (let i = 0; i < raw.length - 1; i += 1) {
				terms.push(`"${raw.slice(i, i + 2)}"`);
			}
		}
	}
	// Deduplicate
	const unique = [...new Set(terms)];
	if (unique.length === 0) return "";
	// FTS5 OR query - matches any term
	return unique.join(" OR ");
}
