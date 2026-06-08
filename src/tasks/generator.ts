import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBenchmarkSuite } from "../benchmark/validation.js";
import type { BenchmarkSuite } from "../benchmark/types.js";

const DIMENSION_NAMES: Record<string, string> = {
  "tool-orchestration": "工具编排（tool-orchestration）",
  "context-compression": "上下文压缩（context-compression）",
  "error-recovery": "错误恢复（error-recovery）",
  "permission-boundary": "权限边界（permission-boundary）",
  "subtask-decomposition": "子任务拆分（subtask-decomposition）",
  "long-range-memory": "长程记忆（long-range-memory）",
};

export interface GenerateSuiteOptions {
  dimension: string;
  taskCount?: number;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  suitesDir?: string;
  force?: boolean;
  maxTokens?: number;
}

interface LocalConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export async function generateSuite(options: GenerateSuiteOptions): Promise<BenchmarkSuite> {
  const dimensionName = DIMENSION_NAMES[options.dimension];
  if (!dimensionName) {
    throw new Error(`Unknown dimension: ${options.dimension}. Valid: ${Object.keys(DIMENSION_NAMES).join(", ")}`);
  }

  const local = await loadLocalConfig();

  const taskCount = options.taskCount ?? 2;
  const model = options.model ?? process.env.EVOLVING_AGENT_MODEL ?? local.model ?? "gpt-4o";
  const baseURL = options.baseURL ?? process.env.OPENAI_BASE_URL ?? local.baseURL ?? "https://api.openai.com/v1";
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? local.apiKey;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const maxTokens = options.maxTokens ?? 16000;

  const templatePath = path.resolve(fileURLToPath(import.meta.url), "../../../tasks/generation-prompt.md");
  const template = await readFile(templatePath, "utf-8");

  const userPrompt = `请生成 ${dimensionName} 维度的 BenchmarkSuite，包含 ${taskCount} 道题目。严格按 Schema 输出纯 JSON（不要 markdown 代码块包裹）。`;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: template },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: maxTokens,
  };

  const response = await fetch(`${normalizeBaseURL(baseURL)}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const err = json.error as Record<string, unknown> | undefined;
    throw new Error(err?.message ? String(err.message) : `Chat Completions request failed with status ${response.status}`);
  }

  const content = extractAssistantContent(json);
  if (!content) throw new Error("LLM returned empty response");

  const suiteJson = extractJson(content);
  if (!suiteJson) throw new Error("Failed to extract JSON from LLM response");

  let suite: BenchmarkSuite;
  try {
    const parsed: unknown = JSON.parse(suiteJson);
    suite = validateBenchmarkSuite(parsed);
  } catch (err) {
    throw new Error(`Generated JSON validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return suite;
}

export async function generateAndWriteSuite(options: GenerateSuiteOptions): Promise<BenchmarkSuite> {
  const suitesDir = options.suitesDir ?? path.resolve(fileURLToPath(import.meta.url), "../../../tasks/suites");

  let suite: BenchmarkSuite;
  try {
    suite = await generateSuite(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`First attempt failed: ${message}`);
    suite = await generateSuite(options);
  }

  const filePath = path.join(suitesDir, `${suite.id}.json`);
  const exists = await fileExists(filePath);
  if (exists && !options.force) {
    console.warn(`File ${filePath} already exists. Use --force to overwrite.`);
    return suite;
  }

  await writeFile(filePath, JSON.stringify(suite, null, 2) + "\n", "utf-8");
  console.log(`Suite written to ${filePath} (${suite.tasks.length} tasks)`);
  return suite;
}

function extractAssistantContent(json: Record<string, unknown>): string | undefined {
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

function extractJson(text: string): string | undefined {
  const stripped = text
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    JSON.parse(stripped);
    return stripped;
  } catch {
    /* continue */
  }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || start >= end) return undefined;
  return stripped.slice(start, end + 1);
}

function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf-8");
    return true;
  } catch {
    return false;
  }
}

async function loadLocalConfig(): Promise<LocalConfig> {
  try {
    const configPath = path.resolve(fileURLToPath(import.meta.url), "../../../.evolving-agent/config.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const providerKey = typeof config.provider === "string" ? config.provider : undefined;
    const providers = config.providers as Record<string, Record<string, unknown>> | undefined;
    const defaultAlias = config.models && typeof config.models === "object"
      ? (config.models as Record<string, unknown>).defaultAlias
      : undefined;
    const aliases = config.models && typeof config.models === "object"
      ? (config.models as Record<string, unknown>).aliases as Record<string, Record<string, unknown>> | undefined
      : undefined;
    const defaultModel = defaultAlias && typeof defaultAlias === "string" && aliases
      ? aliases[defaultAlias]?.model
      : undefined;

    const result: LocalConfig = {};
    if (providerKey && providers?.[providerKey]) {
      const p = providers[providerKey];
      if (typeof p?.baseURL === "string") result.baseURL = p.baseURL;
      if (typeof p?.apiKey === "string") result.apiKey = p.apiKey;
    }
    if (typeof defaultModel === "string") result.model = defaultModel;

    return result;
  } catch {
    return {};
  }
}
