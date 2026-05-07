import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OpenAIModelClient } from "../src/models/openai-client.js";
import type { AgentSpec, TaskSpec } from "../src/specs.js";

interface ProbeSettings {
	baseURL: string;
	apiKey: string;
	model: string;
	prompt: string;
}

const runProbe = process.env.EVOLVING_AGENT_RUN_OPENAI_PROBE === "1";
const probeIt = runProbe ? it : it.skip;

describe("OpenAI-compatible raw response probe", () => {
	probeIt("prints the raw /responses payload and parsed text", async () => {
		const settings = await loadProbeSettings();
		const raw = await requestRawResponse(settings);
		const parsed = await parseWithModelClient(settings);

		console.log("\n[openai-raw-probe] request", JSON.stringify({ baseURL: settings.baseURL, model: settings.model, prompt: settings.prompt }));
		console.log("[openai-raw-probe] raw", JSON.stringify(raw, null, 2));
		console.log("[openai-raw-probe] parsed", JSON.stringify({ text: parsed.text, usage: parsed.usage }, null, 2));

		expect(raw.status).toBeGreaterThanOrEqual(200);
		expect(raw.status).toBeLessThan(300);
	}, 30_000);
});

async function requestRawResponse(settings: ProbeSettings): Promise<Record<string, unknown>> {
	const response = await fetch(`${normalizeBaseURL(settings.baseURL)}/responses`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${settings.apiKey}`,
		},
		body: JSON.stringify({
			model: settings.model,
			input: [{ role: "user", content: settings.prompt }],
			store: false,
			max_output_tokens: 256,
		}),
	});
	const text = await response.text();
	return {
		status: response.status,
		statusText: response.statusText,
		body: parseJson(text) ?? text,
	};
}

async function parseWithModelClient(settings: ProbeSettings) {
	const agent: AgentSpec = {
		id: "probe-agent",
		version: "1.0.0",
		name: "Probe Agent",
		kind: "baseline",
		model: { provider: "openai", model: settings.model },
		prompts: { system: "You are concise." },
		tools: { allowedTools: [] },
		runtime: { maxTurns: 1 },
	};
	const task: TaskSpec = {
		id: "probe-task",
		type: "general",
		title: "Probe",
		prompt: settings.prompt,
		scoring: { method: "exact" },
	};
	return new OpenAIModelClient({ apiKey: settings.apiKey, baseURL: settings.baseURL }).complete({
		agent,
		task,
		turn: 1,
		messages: [{ role: "user", content: settings.prompt }],
		sessionId: "openai-raw-probe",
	});
}

async function loadProbeSettings(): Promise<ProbeSettings> {
	const config = record(await readConfig());
	const provider = stringEnv("EVOLVING_AGENT_PROBE_PROVIDER") ?? stringField(config, "provider");
	const providerConfig = provider ? record(record(config.providers)[provider]) : {};
	return {
		baseURL: stringEnv("EVOLVING_AGENT_PROBE_BASE_URL") ?? stringField(providerConfig, "baseURL") ?? stringField(config, "baseURL") ?? "http://localhost:8317/v1",
		apiKey: stringEnv("EVOLVING_AGENT_PROBE_API_KEY") ?? process.env.OPENAI_API_KEY ?? stringField(providerConfig, "apiKey") ?? stringField(config, "apiKey") ?? "12345678",
		model: stringEnv("EVOLVING_AGENT_PROBE_MODEL") ?? stringField(config, "model") ?? defaultAliasModel(config) ?? "mimo-v2.5-pro",
		prompt: stringEnv("EVOLVING_AGENT_PROBE_PROMPT") ?? "你是什么模型",
	};
}

async function readConfig(): Promise<unknown> {
	try {
		return parseJson(await readFile(".evolving-agent/config.json", "utf8"));
	} catch {
		return {};
	}
}

function defaultAliasModel(config: Record<string, unknown>): string | undefined {
	const models = record(config.models);
	const defaultAlias = stringField(models, "defaultAlias") ?? "default";
	return stringField(record(record(models.aliases)[defaultAlias]), "model");
}

function stringEnv(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" && field.length > 0 ? field : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJson(value: string): unknown | undefined {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

function normalizeBaseURL(baseURL: string): string {
	return baseURL.replace(/\/+$/, "");
}
