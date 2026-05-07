import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryItem, MemorySourceRef, MemoryStore, StoredMemoryLayer } from "./types.js";

const storedLayers: readonly StoredMemoryLayer[] = ["episode", "knowledge", "doctrine"];

export class JsonMemoryStore implements MemoryStore {
	constructor(private readonly root: string) {}

	async append(item: MemoryItem): Promise<void> {
		await mkdir(this.agentRoot(item.agentId), { recursive: true });
		await appendFile(this.layerPath(item.agentId, fileLayer(item)), `${JSON.stringify(item)}\n`, "utf8");
	}

	async list(agentId: string, layer?: StoredMemoryLayer): Promise<MemoryItem[]> {
		const layers = layer ? [layer] : storedLayers;
		const items = await Promise.all(layers.map((current) => this.readLayer(agentId, current)));
		return items.flat().sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
	}

	async latestVerified(agentId: string, options: { perLayer?: number; maxItems?: number } = {}): Promise<MemoryItem[]> {
		const perLayer = options.perLayer ?? 10;
		const items: MemoryItem[] = [];
		for (const layer of storedLayers) {
			const verified = (await this.readLayer(agentId, layer))
				.filter((item) => item.status === "verified")
				.sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
				.slice(0, perLayer);
			items.push(...verified);
		}
		return items.slice(0, options.maxItems ?? items.length);
	}

	async revokeBySource(agentId: string, sourceRef: MemorySourceRef): Promise<void> {
		const items = (await this.list(agentId)).filter((item) => item.status === "verified" && item.sourceRefs.some((ref) => sameSource(ref, sourceRef)));
		const now = Date.now();
		for (const item of items) {
			await this.append({ ...item, id: `${item.id}:revoked:${now}`, status: "revoked", updatedAt: now, metadata: { ...item.metadata, reason: "source revoked" } });
		}
	}

	private async readLayer(agentId: string, layer: StoredMemoryLayer): Promise<MemoryItem[]> {
		try {
			return parseJsonl(await readFile(this.layerPath(agentId, layer), "utf8"));
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
	}

	private agentRoot(agentId: string): string {
		return path.join(this.root, safeId(agentId));
	}

	private layerPath(agentId: string, layer: StoredMemoryLayer | "quarantine"): string {
		return path.join(this.agentRoot(agentId), `${layer}.jsonl`);
	}
}

function fileLayer(item: MemoryItem): StoredMemoryLayer | "quarantine" {
	return item.status === "quarantined" ? "quarantine" : item.layer;
}

function parseJsonl(content: string): MemoryItem[] {
	return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as MemoryItem);
}

function safeId(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sameSource(left: MemorySourceRef, right: MemorySourceRef): boolean {
	return left.kind === right.kind && left.id === right.id && left.excerptHash === right.excerptHash;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
