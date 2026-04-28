import type { EvolvingAgentTool } from "./types.js";
import { objectInput, optionalNumberField, stringField, throwIfAborted } from "./workspace.js";

export interface FetchResponseLike {
	status: number;
	statusText: string;
	url?: string;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; redirect?: "follow"; headers?: Record<string, string> }) => Promise<FetchResponseLike>;

export interface WebFetchToolOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
	maxContentBytes?: number;
	userAgent?: string;
}

export interface WebFetchOutput {
	url: string;
	finalUrl: string;
	status: number;
	statusText: string;
	markdown: string;
	truncated: boolean;
	bytesRead: number;
	contentType?: string;
	title?: string;
}

interface ResolvedOptions {
	fetch: FetchLike;
	timeoutMs: number;
	maxContentBytes: number;
	userAgent: string;
}

const defaultMaxContentBytes = 64 * 1024;
const defaultUserAgent = "evolving-agent/0.1 web_fetch";

export function createWebFetchTools(options: WebFetchToolOptions = {}): EvolvingAgentTool[] {
	return [createWebFetchTool(options)];
}

export function createWebFetchTool(options: WebFetchToolOptions = {}): EvolvingAgentTool<Record<string, unknown>, WebFetchOutput> {
	const resolved = resolveOptions(options);
	return {
		name: "web_fetch",
		description: "Fetch a public HTTP(S) URL and return simple Markdown converted from HTML.",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string" },
				maxBytes: { type: "number" },
			},
			required: ["url"],
			additionalProperties: false,
		},
		permission: { defaultDecision: "allow", riskLevel: "low" },
		concurrency: "parallel-safe",
		timeoutMs: resolved.timeoutMs,
		maxResultBytes: defaultMaxContentBytes,
		async execute(input, signal) {
			throwIfAborted(signal);
			const parsed = objectInput(input);
			const url = parseHttpUrl(stringField(parsed, "url"));
			const maxBytes = validateMaxBytes(optionalNumberField(parsed, "maxBytes"), resolved.maxContentBytes);
			const response = await resolved.fetch(url.toString(), {
				...(signal ? { signal } : {}),
				redirect: "follow",
				headers: {
					accept: "text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,text/*;q=0.8,*/*;q=0.1",
					"user-agent": resolved.userAgent,
				},
			});
			throwIfAborted(signal);
			const finalUrl = assertAllowedFinalUrl(url, response.url);
			const contentType = header(response, "content-type");
			if (response.status < 200 || response.status >= 300) throw new Error(`HTTP request failed with status ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
			if (!isTextualContentType(contentType)) throw new Error(`Unsupported content type: ${contentType}`);
			const text = await response.text();
			throwIfAborted(signal);
			const bytes = byteLength(text);
			const truncated = bytes > maxBytes;
			const limited = truncated ? truncateUtf8(text, maxBytes) : text;
			const converted = shouldConvertHtml(contentType, limited) ? htmlToMarkdown(limited) : { markdown: normalizeMarkdown(limited) };
			return {
				url: url.toString(),
				finalUrl,
				status: response.status,
				statusText: response.statusText,
				...(contentType ? { contentType } : {}),
				...(converted.title ? { title: converted.title } : {}),
				markdown: converted.markdown,
				truncated,
				bytesRead: Math.min(bytes, maxBytes),
			};
		},
	};
}

function resolveOptions(options: WebFetchToolOptions): ResolvedOptions {
	return {
		fetch: options.fetch ?? globalFetch,
		timeoutMs: options.timeoutMs ?? 10_000,
		maxContentBytes: options.maxContentBytes ?? defaultMaxContentBytes,
		userAgent: options.userAgent ?? defaultUserAgent,
	};
}

async function globalFetch(url: string, init?: { signal?: AbortSignal; redirect?: "follow"; headers?: Record<string, string> }): Promise<FetchResponseLike> {
	return globalThis.fetch(url, init);
}

function parseHttpUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("url must be an absolute HTTP(S) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must be an absolute HTTP(S) URL");
	if (url.username || url.password) throw new Error("URL credentials are not allowed");
	return url;
}

function validateMaxBytes(value: number | undefined, configuredMax: number): number {
	if (configuredMax <= 0 || !Number.isFinite(configuredMax)) throw new Error("maxContentBytes must be a positive finite number");
	if (value === undefined) return configuredMax;
	if (value <= 0 || !Number.isFinite(value)) throw new Error("maxBytes must be a positive finite number");
	if (value > configuredMax) throw new Error("maxBytes exceeds configured maximum");
	return Math.floor(value);
}

function assertAllowedFinalUrl(initial: URL, finalUrl: string | undefined): string {
	if (!finalUrl) return initial.toString();
	const parsed = parseHttpUrl(finalUrl);
	if (parsed.origin !== initial.origin) throw new Error("Cross-origin redirects are not allowed");
	return parsed.toString();
}

function header(response: FetchResponseLike, name: string): string | undefined {
	return response.headers.get(name) ?? response.headers.get(name.toLowerCase()) ?? undefined;
}

function isTextualContentType(contentType: string | undefined): boolean {
	if (!contentType) return true;
	const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return normalized.startsWith("text/") || normalized === "application/xhtml+xml" || normalized === "application/xml" || normalized === "application/json";
}

function shouldConvertHtml(contentType: string | undefined, text: string): boolean {
	const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
	return normalized === "text/html" || normalized === "application/xhtml+xml" || /<\s*(html|head|body|title|h[1-6]|p|div|article|main)\b/i.test(text);
}

function htmlToMarkdown(html: string): { markdown: string; title?: string } {
	const title = extractTitle(html);
	let markdown = html
		.replace(/<!doctype[\s\S]*?>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<script\b[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
		.replace(/<title\b[\s\S]*?<\/title>/gi, "")
		.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, text: string) => {
			const label = stripTags(text).trim();
			return label ? `[${label}](${decodeHtmlEntities(href)})` : "";
		})
		.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
		.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
		.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
		.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
		.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
		.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
		.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
		.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
		.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|main|header|footer|ul|ol|blockquote)>/gi, "\n\n")
		.replace(/<(p|div|section|article|main|header|footer|ul|ol|blockquote)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, "");
	markdown = normalizeMarkdown(decodeHtmlEntities(markdown));
	return { markdown, ...(title ? { title } : {}) };
}

function extractTitle(html: string): string | undefined {
	const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const title = match ? normalizeMarkdown(decodeHtmlEntities(stripTags(match[1]!))) : "";
	return title || undefined;
}

function stripTags(html: string): string {
	return decodeHtmlEntities(html.replace(/<[^>]+>/g, ""));
}

function decodeHtmlEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (_match, entity: string) => {
		const normalized = entity.toLowerCase();
		if (normalized === "amp") return "&";
		if (normalized === "lt") return "<";
		if (normalized === "gt") return ">";
		if (normalized === "quot") return '"';
		if (normalized === "apos" || normalized === "#39") return "'";
		if (normalized.startsWith("#x")) return entityFromCodePoint(Number.parseInt(normalized.slice(2), 16));
		if (normalized.startsWith("#")) return entityFromCodePoint(Number.parseInt(normalized.slice(1), 10));
		return `&${entity};`;
	});
}

function entityFromCodePoint(value: number): string {
	if (!Number.isFinite(value)) return "";
	try {
		return String.fromCodePoint(value);
	} catch {
		return "";
	}
}

function normalizeMarkdown(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
	let bytes = 0;
	let result = "";
	for (const char of value) {
		const next = byteLength(char);
		if (bytes + next > maxBytes) break;
		bytes += next;
		result += char;
	}
	return result;
}
