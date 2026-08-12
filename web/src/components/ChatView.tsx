import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatLogEntry, ChatStateSnapshot } from "../types";
import { JsonBlock, Markdown } from "./Markdown";

interface ChatViewProps {
	snapshot: ChatStateSnapshot;
	busy: boolean;
	onSubmit: (input: string) => void;
	onInterrupt: () => void;
}

const SLASH_HINTS = ["/help", "/clear", "/new", "/status", "/stats", "/tools", "/memory", "/trace", "/evolve"];

export function ChatView({ snapshot, busy, onSubmit, onInterrupt }: ChatViewProps): React.ReactElement {
	const [input, setInput] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// 新消息到达时自动滚动到底部（用户主动上翻时不打扰）
	const stickToBottom = useRef(true);
	useEffect(() => {
		const element = scrollRef.current;
		if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
	}, [snapshot.log.length, snapshot.log.at(-1)?.text]);

	const toggle = useCallback((id: string) => {
		setExpanded((previous) => {
			const next = new Set(previous);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const submit = (): void => {
		const value = input.trim();
		if (!value || busy) return;
		onSubmit(value);
		setInput("");
		stickToBottom.current = true;
	};

	return (
		<div className="chat-view">
			<div
				className="chat-log"
				ref={scrollRef}
				onScroll={(event) => {
					const element = event.currentTarget;
					stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
				}}
			>
				{snapshot.log.length === 0 && (
					<div className="chat-empty">
						<h1>evoa</h1>
						<p>
							{snapshot.agentName} · {snapshot.provider}/{snapshot.model} · {snapshot.toolProfile} profile
						</p>
						<p className="hint">
							发送消息开始对话。输入 <code>/</code> 开头使用命令：{SLASH_HINTS.join(" ")}
						</p>
					</div>
				)}
				{snapshot.log.map((entry) => (
					<LogEntry key={entry.id} entry={entry} expanded={expanded.has(entry.id)} onToggle={() => toggle(entry.id)} />
				))}
				{snapshot.status === "thinking" && <div className="status-dot">thinking…</div>}
				{snapshot.runningTools.map((tool) => (
					<div key={tool.id} className="running-tool">
						<span className="spinner" /> {tool.name}
					</div>
				))}
			</div>
			<div className="chat-input-bar">
				<div className="chat-status-line">
					<span className={`status status-${snapshot.status}`}>{snapshot.status}</span>
					<span className="model-label">{snapshot.provider}/{snapshot.model}</span>
					{snapshot.contextUsage && (
						<span className="context-label">
							context {(snapshot.contextUsage.usageFraction * 100).toFixed(0)}% ({snapshot.contextUsage.tokenEstimate.toLocaleString()} tokens)
						</span>
					)}
					<span className="session-label">session {snapshot.sessionId.slice(0, 8)}</span>
				</div>
				<div className="input-row">
					<textarea
						ref={inputRef}
						value={input}
						placeholder={busy ? "Agent is busy…" : "Message evoa…"}
						rows={Math.min(6, Math.max(1, input.split("\n").length))}
						disabled={busy}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								submit();
							}
						}}
					/>
					{busy ? (
						<button className="btn btn-danger" onClick={onInterrupt}>⏹ Interrupt</button>
					) : (
						<button className="btn btn-primary" onClick={submit} disabled={!input.trim()}>Send</button>
					)}
				</div>
			</div>
		</div>
	);
}

function LogEntry({ entry, expanded, onToggle }: { entry: ChatLogEntry; expanded: boolean; onToggle: () => void }): React.ReactElement {
	if (entry.kind === "user") {
		return (
			<div className="log-entry user-entry">
				<div className="entry-body"><Markdown text={entry.text} /></div>
			</div>
		);
	}
	if (entry.kind === "assistant") {
		return (
			<div className="log-entry assistant-entry">
				<div className="entry-body"><Markdown text={entry.text} /></div>
			</div>
		);
	}
	if (entry.kind === "tool_call") {
		const call = entry.raw as { name?: string; input?: unknown } | undefined;
		return (
			<div className="log-entry tool-entry" onClick={onToggle} role="button" tabIndex={0}>
				<div className="tool-head">
					<span className="tool-icon">🔧</span>
					<span className="tool-name">{call?.name ?? entry.toolName ?? "tool"}</span>
					{call?.input !== undefined && <span className="tool-input-preview">{preview(JSON.stringify(call.input))}</span>}
					<span className="tool-caret">{expanded ? "▾" : "▸"}</span>
				</div>
				{expanded && <JsonBlock value={call?.input} />}
			</div>
		);
	}
	if (entry.kind === "tool_result") {
		const result = entry.raw as { output?: unknown; errorMessage?: string; status?: string; durationMs?: number } | undefined;
		const isError = entry.severity === "error";
		return (
			<div className="log-entry tool-entry">
				<div className="tool-head" onClick={onToggle} role="button" tabIndex={0}>
					<span className={`tool-status ${result?.status ?? ""}`}>{statusIcon(result?.status)}</span>
					<span className="tool-name">{entry.toolName ?? "tool"}</span>
					{typeof result?.durationMs === "number" && <span className="tool-duration">{result.durationMs}ms</span>}
					<span className="tool-caret">{expanded ? "▾" : "▸"}</span>
				</div>
				{expanded && (
					<div className="tool-result-body">
						{result?.errorMessage && <div className={`error-text ${isError ? "severity-error" : ""}`}>{result.errorMessage}</div>}
						<JsonBlock value={result?.output ?? result?.errorMessage} />
					</div>
				)}
			</div>
		);
	}
	// system / error / score
	return (
		<div className={`log-entry system-entry severity-${entry.severity ?? "info"}`}>
			{entry.text}
		</div>
	);
}

function statusIcon(status: string | undefined): string {
	if (status === "success") return "✓";
	if (status === "denied") return "⛔";
	if (status === "timeout") return "⏱";
	if (status === "limit_exceeded") return "⚠";
	return "✗";
}

function preview(text: string): string {
	return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}
