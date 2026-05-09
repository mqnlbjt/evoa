import type { EvolvingAgentTool } from "./types.js";
import { objectInput, optionalNumberField, stringField, throwIfAborted } from "./workspace.js";
import { isIP } from "node:net";

export interface FetchResponseLike {
	status: number;
	statusText: string;
	url?: string;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; redirect?: "follow" | "manual"; headers?: Record<string, string> }) => Promise<FetchResponseLike>;

export interface WebFetchToolOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
	requestTimeoutMs?: number;
	maxRetries?: number;
	retryBaseDelayMs?: number;
	retryMaxDelayMs?: number;
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
	attempts: number;
	retried: boolean;
	contentType?: string;
	title?: string;
}

interface ResolvedOptions {
	fetch: FetchLike;
	timeoutMs: number;
	requestTimeoutMs: number;
	maxRetries: number;
	retryBaseDelayMs: number;
	retryMaxDelayMs: number;
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
			const maxRedirects = 5;
			let currentUrl = url.toString();
			let totalAttempts = 0;
			let response: FetchResponseLike | undefined;
			for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
				const result = await fetchWithTimeoutAndRetry(currentUrl, {
					redirect: "manual",
					headers: {
						accept: "text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,text/*;q=0.8,*/*;q=0.1",
						"user-agent": resolved.userAgent,
					},
				}, resolved, signal);
				throwIfAborted(signal);
				response = result.response;
				totalAttempts += result.attempts;
				if (isRedirectStatus(response.status)) {
					const location = header(response, "location");
					if (!location) throw new Error(`Redirect with status ${response.status} but no Location header`);
					const next = parseHttpUrl(location.startsWith("/") ? new URL(location, url.origin).toString() : location);
					if (next.origin !== url.origin) throw new Error("Cross-origin redirects are not allowed");
					currentUrl = next.toString();
					continue;
				}
				break;
			}
			if (response === undefined || isRedirectStatus(response.status)) throw new Error("Too many redirects");
			const finalUrl = currentUrl;
			const attempts = totalAttempts;
			const contentType = header(response, "content-type");
			if (response.status < 200 || response.status >= 300) throw new Error(`HTTP request failed with status ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${attempts > 1 ? ` after ${attempts} attempts` : ""}`);
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
				attempts,
				retried: attempts > 1,
			};
		},
	};
}

function resolveOptions(options: WebFetchToolOptions): ResolvedOptions {
	return {
		fetch: options.fetch ?? globalFetch,
		timeoutMs: options.timeoutMs ?? 10_000,
		requestTimeoutMs: options.requestTimeoutMs ?? Math.min(options.timeoutMs ?? 10_000, 8_000),
		maxRetries: options.maxRetries ?? 2,
		retryBaseDelayMs: options.retryBaseDelayMs ?? 250,
		retryMaxDelayMs: options.retryMaxDelayMs ?? 2_000,
		maxContentBytes: options.maxContentBytes ?? defaultMaxContentBytes,
		userAgent: options.userAgent ?? defaultUserAgent,
	};
}

async function globalFetch(url: string, init?: { signal?: AbortSignal; redirect?: "follow" | "manual"; headers?: Record<string, string> }): Promise<FetchResponseLike> {
	return globalThis.fetch(url, init);
}

async function fetchWithTimeoutAndRetry(url: string, init: { redirect: "follow" | "manual"; headers: Record<string, string> }, options: ResolvedOptions, signal?: AbortSignal): Promise<{ response: FetchResponseLike; attempts: number }> {
	let lastError: unknown;
	const maxAttempts = options.maxRetries + 1;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		throwIfAborted(signal);
		try {
			const response = await fetchOnceWithTimeout(url, init, options, signal);
			if (!isRetryableStatus(response.status) || attempt === maxAttempts) return { response, attempts: attempt };
			lastError = new Error(`HTTP request failed with status ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
		} catch (error) {
			if (!isRetryableFetchError(error, signal) || attempt === maxAttempts) throw retryError(error, attempt);
			lastError = error;
		}
		await delayWithAbort(retryDelayMs(attempt, options), signal);
	}
	throw retryError(lastError, maxAttempts);
}

async function fetchOnceWithTimeout(url: string, init: { redirect: "follow" | "manual"; headers: Record<string, string> }, options: ResolvedOptions, signal?: AbortSignal): Promise<FetchResponseLike> {
	if (options.requestTimeoutMs <= 0 || !Number.isFinite(options.requestTimeoutMs)) throw new Error("requestTimeoutMs must be a positive finite number");
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) throwIfAborted(signal);
	signal?.addEventListener("abort", abort, { once: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				controller.abort();
				reject(new WebFetchRequestTimeoutError(options.requestTimeoutMs));
			}, options.requestTimeoutMs);
		});
		return await Promise.race([options.fetch(url, { ...init, signal: controller.signal }), timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableFetchError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return false;
	return error instanceof WebFetchRequestTimeoutError || error instanceof Error;
}

function retryError(error: unknown, attempts: number): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`${message} after ${attempts} attempt${attempts === 1 ? "" : "s"}`);
}

function retryDelayMs(attempt: number, options: ResolvedOptions): number {
	return Math.min(options.retryMaxDelayMs, options.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1));
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		const abort = () => {
			clearTimeout(timeout);
			reject(new Error("Operation aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

class WebFetchRequestTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`web_fetch request timed out after ${timeoutMs}ms`);
		this.name = "WebFetchRequestTimeoutError";
	}
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
	const host = stripBrackets(url.hostname);
	if (isBlockedHostname(url.hostname)) throw new Error(`Access to ${host} is not allowed`);
	if (isBlockedIpAddress(url.hostname)) throw new Error(`Access to ${host} is not allowed`);
	return url;
}

function validateMaxBytes(value: number | undefined, configuredMax: number): number {
	if (configuredMax <= 0 || !Number.isFinite(configuredMax)) throw new Error("maxContentBytes must be a positive finite number");
	if (value === undefined) return configuredMax;
	if (value <= 0 || !Number.isFinite(value)) throw new Error("maxBytes must be a positive finite number");
	if (value > configuredMax) throw new Error("maxBytes exceeds configured maximum");
	return Math.floor(value);
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

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function stripBrackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isBlockedHostname(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	if (lower === "localhost" || lower === "localhost.localdomain") return true;
	return false;
}

function isBlockedIpAddress(address: string): boolean {
	const normalized = stripBrackets(address);
	if (isIP(normalized) === 4) return isBlockedIpv4(parseIpv4(normalized));
	if (isIP(normalized) === 6) return isBlockedIpv6(normalized);
	return false;
}

function parseIpv4(address: string): number {
	const parts = address.split(".");
	if (parts.length !== 4) return 0;
	let result = 0;
	for (let i = 0; i < 4; i++) {
		const num = parseInt(parts[i]!, 10);
		if (isNaN(num) || num < 0 || num > 255 || String(num) !== parts[i]) return 0;
		result = (result << 8) | num;
	}
	return result >>> 0;
}

function isBlockedIpv4(ip: number): boolean {
	if (((ip & 0xff000000) >>> 0) === 0x7f000000) return true;  // 127.0.0.0/8  loopback
	if (((ip & 0xff000000) >>> 0) === 0x0a000000) return true;  // 10.0.0.0/8   RFC1918
	if (((ip & 0xfff00000) >>> 0) === 0xac100000) return true;  // 172.16.0.0/12 RFC1918
	if (((ip & 0xffff0000) >>> 0) === 0xc0a80000) return true;  // 192.168.0.0/16 RFC1918
	if (((ip & 0xffff0000) >>> 0) === 0xa9fe0000) return true;  // 169.254.0.0/16 link-local
	if (((ip & 0xffc00000) >>> 0) === 0x64400000) return true;  // 100.64.0.0/10 CGN
	return false;
}

function isBlockedIpv6(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("fe80:")) return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
	return false;
}
