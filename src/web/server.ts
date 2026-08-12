import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { WebCommand } from "../cli/args.js";
import { createChatServiceContext, startNewChatSession, type ChatServiceDeps } from "../cli/chat-service.js";
import { JsonlEvolutionHistoryStore } from "../evolution/history-store.js";
import type { StoredAgentSession } from "../sessions/session-store.js";
import { ChatState } from "./state.js";
import { TurnController } from "./turn-controller.js";
import { createChatSession, resetChatState, type ChatSession } from "./session.js";
import { handleSlashCommand } from "./slash-commands.js";
import type { ChatStateSnapshot } from "./types.js";

/** 会话列表摘要（前端侧栏用）。 */
export interface SessionSummary {
	id: string;
	agentId: string;
	createdAt: number;
	updatedAt: number;
	preview: string;
}

export type ServerToClientMessage =
	| { type: "snapshot"; snapshot: ChatStateSnapshot }
	| { type: "system"; message: string }
	| { type: "sessions"; sessions: SessionSummary[] };

export type ClientToServerMessage =
	| { type: "submit"; input: string }
	| { type: "slash"; input: string }
	| { type: "interrupt" }
	| { type: "new_session" }
	| { type: "resume"; sessionId: string }
	| { type: "list_sessions" };

export interface WebServerOptions {
	command: WebCommand;
	deps: ChatServiceDeps;
	port: number;
	host: string;
	/** 前端构建产物目录（默认取启动目录下的 web/dist）。 */
	staticDir?: string;
	now?: () => number;
}

export class WebServer {
	private readonly httpServer = createServer((req, res) => void this.handleHttp(req, res));
	private readonly wss = new WebSocketServer({ noServer: true });
	private readonly clients = new Set<WebSocket>();
	private session: ChatSession | undefined;
	private controller: TurnController | undefined;
	private stopped = false;

	constructor(private readonly options: WebServerOptions) {
		this.httpServer.on("upgrade", (req, socket, head) => {
			this.wss.handleUpgrade(req, socket, head, (ws) => this.handleClient(ws));
		});
	}

	async start(): Promise<void> {
		// web 模式：未显式指定 session 时，分配一个持久 sessionId，
		// 否则 finalizeChatTurn 的落盘条件不成立，对话全部只存内存，重启即丢。
		if (!this.options.command.sessionId && !this.options.command.resumeSessionId) {
			this.options.command.sessionId = randomUUID();
		}
		const session = await createChatSession({
			command: this.options.command,
			deps: this.options.deps,
			...(this.options.now ? { now: this.options.now } : {}),
			onTraceEvent: () => this.broadcastSnapshot(),
		});
		this.attachController(session);
		this.session = session;
		await new Promise<void>((resolve, reject) => {
			this.httpServer.once("error", reject);
			this.httpServer.listen(this.options.port, this.options.host, () => resolve());
		});
	}

	url(): string {
		const address = this.httpServer.address();
		const port = typeof address === "object" && address ? address.port : this.options.port;
		return `http://${this.options.host}:${port}`;
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		for (const client of this.clients) client.close();
		this.clients.clear();
		await this.session?.chat.runtime.close();
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
		await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
	}

	// ------------------------------------------------------------------
	// WebSocket
	// ------------------------------------------------------------------

	private handleClient(ws: WebSocket): void {
		this.clients.add(ws);
		void this.listSessions().then((sessions) => this.send(ws, { type: "sessions", sessions }));
		this.sendSnapshot(ws);
		ws.on("message", (data) => {
			void this.handleClientMessage(ws, parseClientMessage(data));
		});
		ws.on("close", () => this.clients.delete(ws));
		ws.on("error", () => this.clients.delete(ws));
	}

	private async handleClientMessage(ws: WebSocket, message: ClientToServerMessage | undefined): Promise<void> {
		if (!message) {
			this.send(ws, { type: "system", message: "Invalid message" });
			return;
		}
		try {
			if (message.type === "submit") {
				if (message.input.trim()) await this.controller?.submit(message.input);
			} else if (message.type === "slash") {
				await this.handleSlash(message.input, ws);
			} else if (message.type === "interrupt") {
				this.controller?.interruptTurn();
			} else if (message.type === "new_session") {
				await this.newSession(ws);
			} else if (message.type === "resume") {
				await this.resumeSession(message.sessionId, ws);
			} else if (message.type === "list_sessions") {
				this.send(ws, { type: "sessions", sessions: await this.listSessions() });
			}
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			this.send(ws, { type: "system", message: `Error: ${text}` });
		}
	}

	private async handleSlash(input: string, ws: WebSocket): Promise<void> {
		if (!this.session || !this.controller) return;
		const beforeView = this.session.state.snapshot().activeView;
		const result = await handleSlashCommand(input, {
			state: this.session.state,
			chat: this.session.chat,
			stop: () => void this.stop(),
			newSession: async () => {
				const id = await this.newSession(ws);
				return id;
			},
			loadEvolutionHistory: async (historyPath: string) => {
				const store = new JsonlEvolutionHistoryStore(historyPath);
				return store.readRecords();
			},
		});
		const afterView = this.session.state.snapshot().activeView;
		if (result.message) this.send(ws, { type: "system", message: result.message });
		if (beforeView !== afterView) this.broadcastSnapshot();
	}

	private async newSession(ws: WebSocket): Promise<string> {
		if (!this.session || !this.controller) throw new Error("Session not ready");
		if (this.controller.isBusy()) throw new Error("A turn is already running");
		const sessionId = startNewChatSession(this.session.chat);
		resetChatState(this.session.state, this.session.chat, {
			command: this.options.command,
			deps: this.options.deps,
			...(this.options.now ? { now: this.options.now } : {}),
			onTraceEvent: () => this.broadcastSnapshot(),
		});
		this.attachController(this.session);
		this.broadcastSnapshot();
		this.broadcastSessions();
		this.send(ws, { type: "system", message: `Started new session: ${sessionId}` });
		return sessionId;
	}

	private async resumeSession(sessionId: string, ws: WebSocket): Promise<void> {
		if (this.controller?.isBusy()) throw new Error("A turn is already running");
		const command = { ...this.options.command, resumeSessionId: sessionId } as WebCommand;
		const session = await createChatSession({
			command,
			deps: this.options.deps,
			...(this.options.now ? { now: this.options.now } : {}),
			onTraceEvent: () => this.broadcastSnapshot(),
		});
		session.state.restoreMessages(session.chat.messages);
		this.session = session;
		this.attachController(session);
		this.broadcastSnapshot();
		this.send(ws, { type: "system", message: `Resumed session: ${sessionId}` });
	}

	private attachController(session: ChatSession): void {
		this.controller = new TurnController({
			chat: session.chat,
			state: session.state,
			onRenderRequested: () => this.broadcastSnapshot(),
			onStopRequested: () => void this.stop(),
			onViewChanged: () => this.broadcastSnapshot(),
		});
	}

	// ------------------------------------------------------------------
	// 广播
	// ------------------------------------------------------------------

	private sendSnapshot(ws: WebSocket): void {
		if (!this.session) return;
		this.send(ws, { type: "snapshot", snapshot: this.session.state.snapshot() });
	}

	private broadcastSnapshot(): void {
		if (!this.session) return;
		const snapshot = this.session.state.snapshot();
		for (const client of this.clients) this.send(client, { type: "snapshot", snapshot });
	}

	private broadcastSessions(): void {
		void this.listSessions().then((sessions) => {
			for (const client of this.clients) this.send(client, { type: "sessions", sessions });
		});
	}

	private send(ws: WebSocket, message: ServerToClientMessage): void {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
	}

	// ------------------------------------------------------------------
	// HTTP
	// ------------------------------------------------------------------

	private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", this.url());
		try {
			if (url.pathname === "/api/sessions") return await this.sendJson(res, await this.listSessions());
			if (url.pathname.startsWith("/api/sessions/")) return await this.handleSessionDetail(url.pathname, res);
			if (url.pathname === "/api/tools") return await this.sendJson(res, this.toolsList());
			if (url.pathname === "/api/evolution") return await this.handleEvolution(url, res);
			if (url.pathname === "/api/memory") return await this.handleMemory(url, res);
			if (url.pathname.startsWith("/api/")) return sendError(res, 404, "Not found");
			return await this.serveStatic(url.pathname, res);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendError(res, 500, message);
		}
	}

	private async handleSessionDetail(pathname: string, res: ServerResponse): Promise<void> {
		const id = decodeURIComponent(pathname.slice("/api/sessions/".length));
		if (!id) return sendError(res, 400, "Missing session id");
		const stored = await this.loadStoredSession(id);
		if (!stored) return sendError(res, 404, `Session ${id} not found`);
		await this.sendJson(res, stored);
	}

	private async handleEvolution(url: URL, res: ServerResponse): Promise<void> {
		const historyPath = url.searchParams.get("path");
		if (!historyPath) return sendError(res, 400, "Missing ?path= parameter");
		const store = new JsonlEvolutionHistoryStore(historyPath);
		await this.sendJson(res, await store.readRecords());
	}

	private async handleMemory(url: URL, res: ServerResponse): Promise<void> {
		const manager = this.session?.chat.memoryManager;
		if (!manager) return this.sendJson(res, { enabled: false });
		const query = url.searchParams.get("query") ?? "";
		const chat = this.session!.chat;
		const request = { agentId: chat.agent.id, sessionId: chat.sessionId, projectId: chat.memoryProjectId, prompt: query, now: chat.now };
		if (query.trim()) {
			const items = await manager.search({ ...request, query: query.trim() });
			return this.sendJson(res, { enabled: true, query, items });
		}
		const items = await manager.loadContextItems(request);
		return this.sendJson(res, { enabled: true, items: { stable: items.stable, dynamic: items.dynamic } });
	}

	private toolsList(): unknown {
		const registry = this.session?.chat.toolRegistry;
		if (!registry) return [];
		return registry.list().map((tool) => ({ name: tool.name, description: tool.description, concurrency: tool.concurrency, timeoutMs: tool.timeoutMs }));
	}

	private sessionsDir(): string {
		return this.options.command.sessionDir ?? path.join(process.cwd(), ".evolving-agent", "sessions");
	}

	private async loadStoredSession(id: string): Promise<StoredAgentSession | undefined> {
		try {
			const content = await readFile(path.join(this.sessionsDir(), `${safeSessionId(id)}.json`), "utf8");
			return JSON.parse(content) as StoredAgentSession;
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
	}

	private async listSessions(): Promise<SessionSummary[]> {
		const dir = this.sessionsDir();
		let files: string[];
		try {
			files = await readdir(dir);
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		const summaries = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
			const stored = await this.loadStoredSession(file.slice(0, -".json".length));
			if (!stored) return undefined;
			return {
				id: stored.id,
				agentId: stored.agentId,
				createdAt: stored.createdAt,
				updatedAt: stored.updatedAt,
				preview: sessionPreview(stored),
			} satisfies SessionSummary;
		}));
		return summaries
			.filter((summary): summary is SessionSummary => summary !== undefined)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
		const staticDir = this.options.staticDir ?? path.join(process.cwd(), "web", "dist");
		const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
		const filePath = path.resolve(staticDir, relative);
		if (!filePath.startsWith(path.resolve(staticDir))) return sendError(res, 403, "Forbidden");
		try {
			const content = await readFile(filePath);
			res.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-cache" });
			res.end(content);
		} catch (error) {
			if (isNotFound(error) && !path.extname(relative)) {
				// SPA fallback：无扩展名的路径回退到 index.html
				try {
					const index = await readFile(path.join(staticDir, "index.html"));
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(index);
					return;
				} catch {
					/* fall through to 404 */
				}
			}
			if (isNotFound(error)) {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(notBuiltPage());
				return;
			}
			throw error;
		}
	}

	private async sendJson(res: ServerResponse, value: unknown): Promise<void> {
		const body = JSON.stringify(value);
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
		res.end(body);
	}
}

// ------------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------------

function parseClientMessage(data: unknown): ClientToServerMessage | undefined {
	const text = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : undefined;
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as ClientToServerMessage;
	} catch {
		return undefined;
	}
}

function sessionPreview(stored: StoredAgentSession): string {
	const messages = stored.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (!message || message.role === "system") continue;
		const text = message.content.trim();
		if (text) return text.length > 80 ? `${text.slice(0, 77)}...` : text;
	}
	return "(empty)";
}

function safeSessionId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sendError(res: ServerResponse, status: number, message: string): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify({ error: message }));
}

function contentType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".html": return "text/html; charset=utf-8";
		case ".js": return "text/javascript; charset=utf-8";
		case ".mjs": return "text/javascript; charset=utf-8";
		case ".css": return "text/css; charset=utf-8";
		case ".json": return "application/json; charset=utf-8";
		case ".svg": return "image/svg+xml";
		case ".png": return "image/png";
		case ".jpg": case ".jpeg": return "image/jpeg";
		case ".ico": return "image/x-icon";
		case ".woff2": return "font/woff2";
		case ".map": return "application/json";
		default: return "application/octet-stream";
	}
}

function notBuiltPage(): string {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>evoa web</title></head>
<body style="font-family: system-ui; background: #14161a; color: #e8eaed; padding: 40px;">
<h1>evoa web</h1>
<p>The web UI has not been built yet.</p>
<pre style="background:#1e2126;padding:16px;border-radius:8px;">cd web && npm install && npm run build</pre>
<p>Then restart <code>evoa web</code>.</p>
</body>
</html>`;
}


