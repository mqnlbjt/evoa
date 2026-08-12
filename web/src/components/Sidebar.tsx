import { useRef, useState } from "react";
import {
	Activity,
	Dna,
	Hexagon,
	MessageSquare,
	Moon,
	PanelLeftClose,
	PanelLeftOpen,
	Plus,
	ScanSearch,
	Sun,
	Wifi,
	WifiOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ChatView, SessionSummary } from "../types";

interface SidebarProps {
	view: ChatView;
	onView: (view: ChatView) => void;
	sessions: SessionSummary[];
	currentSessionId: string | undefined;
	connected: boolean;
	onNewSession: () => void;
	onResume: (sessionId: string) => void;
	// 可选：主题切换（由 App 传入）
	theme?: "dark" | "light";
	onToggleTheme?: () => void;
}

/** 二级菜单（Stats/Trace/Evolve） */
const MORE_ITEMS: Array<{ view: ChatView; label: string; icon: LucideIcon }> = [
	{ view: "stats", label: "Stats", icon: Activity },
	{ view: "trace", label: "Trace", icon: ScanSearch },
	{ view: "evolve", label: "Evolve", icon: Dna },
];

const PANEL_KEY = "evoa-sessions-panel-open";

/** 时间 → 友好显示。 */
function timeAgo(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return new Date(ts).toLocaleDateString();
}

export function Sidebar({
	view,
	onView,
	sessions,
	currentSessionId,
	connected,
	onNewSession,
	onResume,
	theme = "dark",
	onToggleTheme,
}: SidebarProps): React.ReactElement {
	const [moreOpen, setMoreOpen] = useState(false);
	// 面板折叠状态：localStorage 持久化，默认展开
	const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem(PANEL_KEY) !== "0");
	const moreRef = useRef<HTMLDivElement>(null);

	// 排序：最新更新的在最前（防御性，后端已按 updatedAt 降序）
	const sortedSessions = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

	const togglePanel = (): void => {
		setPanelOpen((open) => {
			localStorage.setItem(PANEL_KEY, open ? "0" : "1");
			return !open;
		});
	};

	return (
		<>
			<aside className="rail">
				<button
					type="button"
					className="rail-logo"
					onClick={togglePanel}
					title={panelOpen ? "Hide sessions" : "Show sessions"}
					aria-label={panelOpen ? "Hide sessions" : "Show sessions"}
					aria-expanded={panelOpen}
				>
					{panelOpen ? <PanelLeftClose size={20} strokeWidth={1.75} /> : <PanelLeftOpen size={20} strokeWidth={1.75} />}
				</button>

				<nav className="rail-nav">
					<button
						type="button"
						className={`rail-item${view === "chat" ? " rail-item-active" : ""}`}
						onClick={() => onView("chat")}
						title="Chat"
						aria-label="Chat"
					>
						<MessageSquare size={20} strokeWidth={1.75} />
					</button>

					{/* 二级菜单入口 */}
					<div className="rail-more" ref={moreRef}>
						<button
							type="button"
							className={`rail-item${MORE_ITEMS.some((item) => item.view === view) ? " rail-item-active" : ""}`}
							onClick={() => setMoreOpen((open) => !open)}
							title="More views"
							aria-label="More views"
							aria-expanded={moreOpen}
						>
							<ScanSearch size={20} strokeWidth={1.75} />
						</button>
						{moreOpen && (
							<div className="rail-submenu">
								{MORE_ITEMS.map((item) => {
									const Icon = item.icon;
									return (
										<button
											key={item.view}
											type="button"
											className={`rail-submenu-item${view === item.view ? " rail-submenu-active" : ""}`}
											onClick={() => {
												onView(item.view);
												setMoreOpen(false);
											}}
										>
											<Icon size={15} strokeWidth={1.75} />
											{item.label}
										</button>
									);
								})}
							</div>
						)}
					</div>
				</nav>

				<div className="rail-bottom">
					<span
						className={`conn ${connected ? "conn-on" : "conn-off"}`}
						title={connected ? "connected" : "reconnecting…"}
					>
						{connected ? <Wifi size={14} strokeWidth={2} /> : <WifiOff size={14} strokeWidth={2} />}
					</span>
					{onToggleTheme && (
						<button
							type="button"
							className="theme-toggle"
							onClick={onToggleTheme}
							title={theme === "light" ? "Switch to dark" : "Switch to light"}
							aria-label="Toggle theme"
						>
							{theme === "light" ? <Moon size={16} strokeWidth={1.75} /> : <Sun size={16} strokeWidth={1.75} />}
						</button>
					)}
				</div>
			</aside>

			{/* 常驻 Sessions 面板：可折叠，最新会话在最前 */}
			<aside className={`sessions-panel${panelOpen ? "" : " panel-collapsed"}`}>
				<div className="sessions-panel-inner">
					<div className="sessions-panel-head">
						<span className="sessions-panel-title">Sessions</span>
						<button
							type="button"
							className="btn btn-primary btn-new-session"
							onClick={onNewSession}
							title="New session"
							aria-label="New session"
						>
							<Plus size={16} strokeWidth={2.5} /> New
						</button>
					</div>
					<div className="session-list">
						{sortedSessions.length === 0 && <div className="session-empty">No sessions yet — start a new one.</div>}
						{sortedSessions.map((session) => {
							const isActive = session.active && session.id === currentSessionId;
							return (
								<button
									key={session.id}
									type="button"
									className={`session-item${isActive ? " session-active" : ""}`}
									onClick={() => onResume(session.id)}
									title={session.id}
								>
									<div className="session-item-top">
										<span className={`session-dot${isActive ? " session-dot-on" : ""}`} />
										<span className="session-preview">{session.preview || "(empty)"}</span>
									</div>
									<div className="session-meta">
										<span>{session.agentId}</span>
										<span className="session-time">{timeAgo(session.updatedAt)}</span>
									</div>
								</button>
							);
						})}
					</div>
				</div>
			</aside>
		</>
	);
}
