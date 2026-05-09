import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createToolRegistryForProfile } from "../src/tools/profiles.js";
import { createWebFetchTool, type FetchLike, type FetchResponseLike } from "../src/tools/web-fetch.js";

class HeadersLike {
	constructor(private readonly values: Record<string, string> = {}) {}

	get(name: string): string | null {
		return this.values[name.toLowerCase()] ?? null;
	}
}

describe("web_fetch tool", () => {
	it("fetches HTML and converts it to Markdown", async () => {
		const tool = createWebFetchTool({ fetch: mockFetch(htmlResponse(`<!doctype html>
<html><head><title>Hello &amp; World</title><style>.x{}</style></head>
<body><h1>Hello</h1><p>This is <strong>bold</strong> and <a href="https://example.com/a">link</a>.</p><script>alert(1)</script></body></html>`)) });

		const output = await tool.execute({ url: "https://example.com/page" });

		expect(output).toMatchObject({ url: "https://example.com/page", finalUrl: "https://example.com/page", status: 200, contentType: "text/html", title: "Hello & World", truncated: false });
		expect(output.markdown).toContain("# Hello");
		expect(output.markdown).toContain("**bold**");
		expect(output.markdown).toContain("[link](https://example.com/a)");
		expect(output.markdown).not.toContain("alert(1)");
		expect(output.markdown).not.toContain(".x{}");
	});

	it("returns plain text content", async () => {
		const tool = createWebFetchTool({ fetch: mockFetch(textResponse("hello\nworld")) });

		const output = await tool.execute({ url: "https://example.com/readme.txt" });

		expect(output).toMatchObject({ status: 200, contentType: "text/plain", markdown: "hello\nworld", truncated: false });
	});

	it("rejects non HTTP URLs", async () => {
		const tool = createWebFetchTool({ fetch: mockFetch(textResponse("never")) });

		await expect(tool.execute({ url: "file:///etc/passwd" })).rejects.toThrow("url must be an absolute HTTP(S) URL");
		await expect(tool.execute({ url: "data:text/html,hi" })).rejects.toThrow("url must be an absolute HTTP(S) URL");
		await expect(tool.execute({ url: "javascript:alert(1)" })).rejects.toThrow("url must be an absolute HTTP(S) URL");
		await expect(tool.execute({ url: "/relative" })).rejects.toThrow("url must be an absolute HTTP(S) URL");
	});

	it("rejects URL credentials", async () => {
		const tool = createWebFetchTool({ fetch: mockFetch(textResponse("never")) });

		await expect(tool.execute({ url: "https://user:pass@example.com" })).rejects.toThrow("URL credentials are not allowed");
	});

	it("reports HTTP failures", async () => {
		const tool = createWebFetchTool({ fetch: mockFetch(textResponse("missing", { status: 404, statusText: "Not Found" })) });

		await expect(tool.execute({ url: "https://example.com/missing" })).rejects.toThrow("HTTP request failed with status 404 Not Found");
	});

	it("rejects binary content types", async () => {
		const tool = createWebFetchTool({ fetch: mockFetch(response("pdf", { contentType: "application/pdf" })) });

		await expect(tool.execute({ url: "https://example.com/file.pdf" })).rejects.toThrow("Unsupported content type: application/pdf");
	});

	it("truncates large content by UTF-8 byte limit", async () => {
		const tool = createWebFetchTool({ fetch: mockFetch(textResponse("hello 世界 hello")), maxContentBytes: 64 });

		const output = await tool.execute({ url: "https://example.com/large", maxBytes: 10 });

		expect(output.truncated).toBe(true);
		expect(output.bytesRead).toBe(10);
		expect(Buffer.byteLength(output.markdown, "utf8")).toBeLessThanOrEqual(10);
	});

	it("fails when aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const tool = createWebFetchTool({ fetch: mockFetch(textResponse("never")) });

		await expect(tool.execute({ url: "https://example.com" }, controller.signal)).rejects.toThrow("Operation aborted");
	});

	it("allows same-origin redirects and rejects cross-origin redirects", async () => {
		const sameOriginTool = createWebFetchTool({
			fetch: sequenceFetch([
				textResponse("", { status: 301, location: "https://example.com/final" }),
				textResponse("ok"),
			]),
		});
		const crossOriginTool = createWebFetchTool({
			fetch: sequenceFetch([
				textResponse("", { status: 301, location: "https://evil.example/final" }),
			]),
		});

		await expect(sameOriginTool.execute({ url: "https://example.com/start" })).resolves.toMatchObject({ finalUrl: "https://example.com/final" });
		await expect(crossOriginTool.execute({ url: "https://example.com/start" })).rejects.toThrow("Cross-origin redirects are not allowed");
	});

	it("rejects localhost and internal IP addresses", async () => {
		const tool = createWebFetchTool({ fetch: mockFetch(textResponse("never")) });

		await expect(tool.execute({ url: "http://localhost/" })).rejects.toThrow("Access to localhost is not allowed");
		await expect(tool.execute({ url: "http://localhost:8080/path" })).rejects.toThrow("Access to localhost is not allowed");
		await expect(tool.execute({ url: "http://127.0.0.1/" })).rejects.toThrow("Access to 127.0.0.1 is not allowed");
		await expect(tool.execute({ url: "http://[::1]/" })).rejects.toThrow("Access to ::1 is not allowed");
		await expect(tool.execute({ url: "http://10.0.0.1/" })).rejects.toThrow("Access to 10.0.0.1 is not allowed");
		await expect(tool.execute({ url: "http://172.16.0.1/" })).rejects.toThrow("Access to 172.16.0.1 is not allowed");
		await expect(tool.execute({ url: "http://192.168.1.1/" })).rejects.toThrow("Access to 192.168.1.1 is not allowed");
		await expect(tool.execute({ url: "http://169.254.1.1/" })).rejects.toThrow("Access to 169.254.1.1 is not allowed");
		await expect(tool.execute({ url: "http://169.254.169.254/" })).rejects.toThrow("Access to 169.254.169.254 is not allowed");
	});

	it("is included in read-only and dangerous profiles", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "evolving-agent-web-fetch-"));
		const fetch = mockFetch(textResponse("ok"));

		expect(createToolRegistryForProfile({ workspaceRoot: root, profile: "read-only", fetch }).list().map((tool) => tool.name)).toContain("web_fetch");
		expect(createToolRegistryForProfile({ workspaceRoot: root, profile: "dangerous", fetch }).list().map((tool) => tool.name)).toContain("web_fetch");
	});
});

function mockFetch(response: FetchResponseLike): FetchLike {
	return async () => response;
}

function sequenceFetch(responses: FetchResponseLike[]): FetchLike {
	let index = 0;
	return async () => {
		const response = responses[index] ?? responses[responses.length - 1];
		if (index < responses.length) index += 1;
		return response!;
	};
}

function htmlResponse(body: string): FetchResponseLike {
	return response(body, { contentType: "text/html" });
}

function textResponse(body: string, options: Partial<FetchResponseLike> & { contentType?: string; location?: string } = {}): FetchResponseLike {
	return response(body, { contentType: "text/plain", ...options });
}

function response(body: string, options: Partial<FetchResponseLike> & { contentType?: string; location?: string } = {}): FetchResponseLike {
	const headers: Record<string, string> = {};
	if (options.contentType) headers["content-type"] = options.contentType;
	if (options.location) headers["location"] = options.location;
	return {
		status: options.status ?? 200,
		statusText: options.statusText ?? "OK",
		url: options.url ?? "https://example.com/page",
		headers: new HeadersLike(headers),
		async text() {
			return body;
		},
	};
}

