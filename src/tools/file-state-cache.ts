export interface FileStateEntry {
	content: string;
	timestamp: number;
	size: number;
	offset?: number;
	limit?: number;
}

export interface FileStateCacheConfig {
	maxEntries: number;
	maxTotalSize: number;
}

type NormalizedFileStateEntry = FileStateEntry & { lastAccess: number };

const defaultConfig: FileStateCacheConfig = {
	maxEntries: 100,
	maxTotalSize: 25 * 1024 * 1024,
};

export class FileStateCache {
	private cache = new Map<string, NormalizedFileStateEntry>();
	private config: FileStateCacheConfig;
	private totalSize = 0;
	private accessCounter = 0;

	constructor(config?: Partial<FileStateCacheConfig>) {
		this.config = { ...defaultConfig, ...config };
	}

	get(path: string): FileStateEntry | undefined {
		const normalized = path;
		const entry = this.cache.get(normalized);
		if (!entry) return undefined;
		entry.lastAccess = ++this.accessCounter;
		const { lastAccess: _, ...entryWithoutAccess } = entry;
		return entryWithoutAccess;
	}

	set(path: string, entry: FileStateEntry): void {
		const normalized = path;
		const existing = this.cache.get(normalized);
		if (existing) {
			this.totalSize -= existing.size;
		}
		const withAccess: NormalizedFileStateEntry = { ...entry, lastAccess: ++this.accessCounter };
		this.cache.set(normalized, withAccess);
		this.totalSize += entry.size;
		this.evictIfNeeded();
	}

	has(path: string): boolean {
		return this.cache.has(path);
	}

	remove(path: string): void {
		const entry = this.cache.get(path);
		if (entry) {
			this.totalSize -= entry.size;
			this.cache.delete(path);
		}
	}

	clear(): void {
		this.cache.clear();
		this.totalSize = 0;
	}

	byteSize(): number {
		return this.totalSize;
	}

	get entryCount(): number {
		return this.cache.size;
	}

	private evictIfNeeded(): void {
		while (this.cache.size > 0 && (this.cache.size > this.config.maxEntries || this.totalSize > this.config.maxTotalSize)) {
			this.evictLRU();
		}
	}

	private evictLRU(): void {
		let oldest: { key: string; entry: NormalizedFileStateEntry } | undefined;
		for (const [key, entry] of this.cache) {
			if (!oldest || entry.lastAccess < oldest.entry.lastAccess) {
				oldest = { key, entry };
			}
		}
		if (oldest) {
			this.totalSize -= oldest.entry.size;
			this.cache.delete(oldest.key);
		}
	}
}
