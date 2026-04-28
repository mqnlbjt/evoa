import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonSessionStore } from "../src/sessions/json-session-store.js";


describe("JsonSessionStore", () => {
	it("saves and loads sessions", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-session-"));
		const store = new JsonSessionStore(root);

		await store.saveSession({
			id: "demo",
			agentId: "agent",
			messages: [{ role: "assistant", content: "hi", contentBlocks: [{ type: "text", text: "hi" }] }],
			createdAt: 1,
			updatedAt: 2,
		});

		expect(await store.loadSession("demo")).toMatchObject({
			id: "demo",
			agentId: "agent",
			messages: [{ role: "assistant", contentBlocks: [{ type: "text", text: "hi" }] }],
		});
	});

	it("round-trips startup context", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-session-"));
		const store = new JsonSessionStore(root);

		await store.saveSession({
			id: "demo",
			agentId: "agent",
			messages: [],
			startupContext: {
				agentPath: "agent.json",
				provider: "local",
				model: "model",
				baseURL: "url",
				providerFormat: "openai-responses",
				toolProfile: "coding",
				sessionDir: "sessions",
			},
			createdAt: 1,
			updatedAt: 2,
		});

		expect(await store.loadSession("demo")).toMatchObject({
			startupContext: { agentPath: "agent.json", provider: "local", model: "model", baseURL: "url", toolProfile: "coding" },
		});
	});

	it("loads old sessions without startup context", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-session-"));
		const store = new JsonSessionStore(root);

		await store.saveSession({ id: "demo", agentId: "agent", messages: [], createdAt: 1, updatedAt: 2 });

		expect(await store.loadSession("demo")).toMatchObject({ id: "demo", agentId: "agent" });
	});

	it("returns undefined for missing sessions", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-session-"));
		const store = new JsonSessionStore(root);

		expect(await store.loadSession("missing")).toBeUndefined();
	});
});
