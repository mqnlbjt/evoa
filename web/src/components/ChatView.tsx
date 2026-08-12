import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import {
	AlertTriangle,
	Archive,
	ArrowUp,
	BrainCircuit,
	CheckCircle2,
	ChevronDown,
	Loader2,
	ShieldOff,
	Square,
	Timer,
	Wrench,
	XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ChatLogEntry, ChatLogSeverity, ChatStateSnapshot, ChatStatus } from "../types";
import { JsonBlock, Markdown } from "./Markdown";

interface ChatViewProps {
	snapshot: ChatStateSnapshot;
	busy: boolean;
	onSubmit: (input: string) => void;
	onInterrupt: () => void;
}

const SLASH_HINTS = ["/help", "/clear", "/new", "/status", "/stats", "/tools", "/memory", "/trace", "/evolve"];

/** 等宽小字（时间戳 / 工具名共用）。 */
const MONO: CSSProperties = {
	fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", monospace',
	fontSize: 11,
};

const SEVERITY_COLOR: Record<ChatLogSeverity, string> = {
	info: "var(--text-dim)",
	success: "var(--good)",
	warning: "var(--warn)",
	error: "var(--bad)",
};

interface ToolStatusInfo {
	icon: LucideIcon;
	color: string;
}

/** 工具结果状态 → Lucide 图标 + 语义色。 */
function toolStatusInfo(status: string | undefined, severity?: ChatLogSeverity): ToolStatusInfo {
	switch (status) {
		case "success":
			return { icon: CheckCircle2, color: "var(--good)" };
		case "denied":
			return { icon: ShieldOff, color: "var(--warn)" };
		case "timeout":
			return { icon: Timer, color: "var(--warn)" };
		case "limit_exceeded":
			return { icon: AlertTriangle, color: "var(--warn)" };
		case "error":
			return { icon: XCircle, color: "var(--bad)" };
	}
	if (severity === "success") return { icon: CheckCircle2, color: "var(--good)" };
	if (severity === "error") return { icon: XCircle, color: "var(--bad)" };
	return { icon: XCircle, color: "var(--text-faint)" };
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function preview(text: string): string {
	return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

export function ChatView({ snapshot, busy, onSubmit, onInterrupt }: ChatViewProps): React.ReactElement {
	const [input, setInput] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// 新消息/状态变化时自动滚底；用户上翻超过 80px 后暂停跟随（逻辑保留）。
	const stickToBottom = useRef(true);
	useEffect(() => {
		const element = scrollRef.current;
		if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
	}, [snapshot.log.length, snapshot.log.at(-1)?.text, snapshot.status, snapshot.runningTools.length]);

	const toggle = useCallback((id: string) => {
		setExpanded((previous) => {
			const next = new Set(previous);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const submit = useCallback((): void => {
		const value = input.trim();
		if (!value || busy) return;
		onSubmit(value);
		setInput("");
		stickToBottom.current = true;
		inputRef.current?.focus();
	}, [input, busy, onSubmit]);

	const handleComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<div className="chat-view">
			{/* 消息区：自动滚底，上翻 80px 内暂停跟随 */}
			<div
				className="chat-scroll"
				ref={scrollRef}
				onScroll={(event) => {
					const element = event.currentTarget;
					stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
				}}
			>
				{snapshot.log.length === 0 && (
					<div className="chat-empty">
						<div className="chat-empty-title">evoa</div>
						<div className="chat-empty-meta">
							{snapshot.agentName} · {snapshot.provider}/{snapshot.model} · {snapshot.toolProfile} profile
						</div>
						<div className="chat-empty-hints">
							{SLASH_HINTS.map((hint) => (
								<button key={hint} className="btn btn-ghost hint-chip" onClick={() => setInput(hint)}>
									{hint}
								</button>
							))}
						</div>
					</div>
				)}
				{snapshot.log.map((entry, index) => {
					const isTool = entry.kind === "tool_call" || entry.kind === "tool_result";
					const prev = snapshot.log[index - 1];
					const next = snapshot.log[index + 1];
					const prevIsTool = prev ? (prev.kind === "tool_call" || prev.kind === "tool_result") : false;
					const nextIsTool = next ? (next.kind === "tool_call" || next.kind === "tool_result") : false;
					const groupClass = isTool
						? `${!prevIsTool ? " tool-group-start" : ""}${!nextIsTool ? " tool-group-end" : ""}`
						: "";
					return (
						<LogEntry
							key={entry.id}
							entry={entry}
							groupClass={groupClass}
							expanded={expanded.has(entry.id)}
							onToggle={() => toggle(entry.id)}
						/>
					);
				})}
				{snapshot.status === "thinking" && (
					<div className="status-dot" style={{ color: "var(--signal)" }}>
						<BrainCircuit className="pulse" size={14} />
						reasoning…
					</div>
				)}
				{snapshot.runningTools.map((tool) => (
					<div key={tool.id} className="running-tool">
						<Loader2 className="spin" size={14} />
						<span style={MONO}>{tool.name}</span>
					</div>
				))}
			</div>

			{/* 底部输入栏 */}
			<div className="chat-composer">
				<textarea
					ref={inputRef}
					className="composer-input"
					value={input}
					placeholder={busy ? "Agent is busy…" : "Message evoa…"}
					rows={Math.min(6, Math.max(1, input.split("\n").length))}
					disabled={busy}
					aria-label="Message"
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={handleComposerKey}
				/>
				<div className="composer-actions">
					{busy ? (
						<button className="btn btn-icon btn-danger" onClick={onInterrupt} title="Interrupt" aria-label="Interrupt agent">
							<Square size={16} />
						</button>
					) : (
						<button className="btn btn-icon btn-primary" onClick={submit} disabled={!input.trim()} title="Send" aria-label="Send message">
							<ArrowUp size={16} />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

function LogEntry({ entry, expanded, onToggle, groupClass = "" }: { entry: ChatLogEntry; expanded: boolean; onToggle: () => void; groupClass?: string }): React.ReactElement {
	if (entry.kind === "reasoning") {
		// 思考过程：默认折叠为小胶囊，点击展开全文（可能几万 token，防刷屏）
		const charCount = entry.text.length;
		return (
			<div
				className="msg msg-reasoning"
				onClick={onToggle}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
			>
				<div className="reasoning-head">
					<BrainCircuit size={13} className="reasoning-icon" />
					<span>thinking</span>
					<span className="reasoning-count">{charCount} chars</span>
					<span className="reasoning-caret">{expanded ? "hide" : "show"}</span>
				</div>
				{expanded && (
					<div className="reasoning-body">
						<Markdown text={entry.text} />
					</div>
				)}
			</div>
		);
	}
	if (entry.kind === "user") {
		const isCompacted = entry.text.startsWith("[Compacted conversation summary]");
		if (isCompacted) {
			const cleanText = entry.text.replace("[Compacted conversation summary]", "").trim();
			return (
				<div
					className="msg msg-compaction"
					onClick={onToggle}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
				>
					<div className="compaction-head">
						<Archive size={13} className="compaction-icon" />
						<span>Compacted Conversation History</span>
						<span className="compaction-caret">{expanded ? "hide" : "show"}</span>
					</div>
					{expanded && (
						<div className="compaction-body">
							<Markdown text={cleanText} />
						</div>
					)}
				</div>
			);
		}
		return (
			<div className="msg msg-user">
				<Markdown text={entry.text} />
				<div className="msg-time">{formatTime(entry.timestamp)}</div>
			</div>
		);
	}
	if (entry.kind === "assistant") {
		return (
			<div className="msg msg-assistant">
				<Markdown text={entry.text} />
				<div className="msg-time">{formatTime(entry.timestamp)}</div>
			</div>
		);
	}
	if (entry.kind === "tool_call") {
		const call = entry.raw as { name?: string; input?: unknown } | undefined;
		const name = call?.name ?? entry.toolName ?? "tool";
		return (
			<div className={`msg msg-tool${groupClass}`}>
				<div
					className="tool-head"
					role="button"
					tabIndex={0}
					aria-expanded={expanded}
					onClick={onToggle}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							onToggle();
						}
					}}
				>
					<span className="tool-status-icon" style={{ color: "var(--signal)" }}>
						<Wrench size={14} />
					</span>
					<span className="tool-name" style={MONO}>{name}</span>
					{call?.input !== undefined && <span className="tool-input-preview" style={MONO}>{preview(JSON.stringify(call.input))}</span>}
					<span className="tool-caret" style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}>
						<ChevronDown size={14} />
					</span>
				</div>
				{expanded && (
					<div className="tool-result-body">
						<JsonBlock value={call?.input} />
					</div>
				)}
			</div>
		);
	}
	if (entry.kind === "tool_result") {
		const result = entry.raw as { output?: unknown; errorMessage?: string; status?: string; durationMs?: number } | undefined;
		const { icon: StatusIcon, color } = toolStatusInfo(result?.status, entry.severity);
		return (
			<div className={`msg msg-tool${groupClass}`}>
				<div
					className="tool-head"
					role="button"
					tabIndex={0}
					aria-expanded={expanded}
					onClick={onToggle}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							onToggle();
						}
					}}
				>
					<span className="tool-status-icon" style={{ color }}>
						<StatusIcon size={14} />
					</span>
					<span className="tool-name" style={MONO}>{entry.toolName ?? "tool"}</span>
					{typeof result?.durationMs === "number" && <span className="tool-duration" style={MONO}>{formatDuration(result.durationMs)}</span>}
					<span className="tool-caret" style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}>
						<ChevronDown size={14} />
					</span>
				</div>
				{expanded && (
					<div className="tool-result-body">
						{result?.errorMessage && <div className="error-text">{result.errorMessage}</div>}
						<JsonBlock value={result?.output ?? result?.errorMessage} />
					</div>
				)}
			</div>
		);
	}
	// system / error / score：居中细字，按 severity 着色
	const severity = entry.severity ?? "info";
	return (
		<div className={`msg msg-system severity-${severity}`} style={{ color: SEVERITY_COLOR[severity] }}>
			{entry.text}
		</div>
	);
}
