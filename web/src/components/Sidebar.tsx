import { useEffect, useRef } from "react";
import { Activity, Dna, Hexagon, MessageSquare, Moon, Plus, ScanSearch, Sun, Wifi, WifiOff } from "lucide-react";
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
	// 抽屉开关状态由 App 持有
	drawerOpen: boolean;
	onToggleDrawer: () => void;
	onCloseDrawer: () => void;
}

const NAV_ITEMS: Array<{ view: ChatView; label: string; icon: LucideIcon }> = [
	{ view: "chat", label: "Chat", icon: MessageSquare },
	{ view: "stats", label: "Stats", icon: Activity },
	{ view: "trace", label: "Trace", icon: ScanSearch },
	{ view: "evolve", label: "Evolve", icon: Dna },
];

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
	drawerOpen,
	onToggleDrawer,
	onCloseDrawer,
}: SidebarProps): React.ReactElement {
	const drawerRef = useRef<HTMLDivElement>(null);

	// 抽屉外点击关闭（mousedown 判断目标是否在抽屉内部）
	useEffect(() => {
		if (!drawerOpen) return;
		const onPointerDown = (event: MouseEvent): void => {
			if (drawerRef.current && !drawerRef.current.contains(event.target as Node)) {
				onCloseDrawer();
			}
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [drawerOpen, onCloseDrawer]);

	return (
		<>
			<aside className="rail">
				<button
					type="button"
					className="rail-logo"
					onClick={onToggleDrawer}
					title="Sessions"
					aria-label="Sessions"
					aria-expanded={drawerOpen}
				>
					<Hexagon size={26} strokeWidth={1.75} />
				</button>

				<nav className="rail-nav">
					{NAV_ITEMS.map((item) => {
						const Icon = item.icon;
						const active = view === item.view;
						return (
							<button
								key={item.view}
								type="button"
								className={`rail-item${active ? " rail-item-active" : ""}`}
								onClick={() => onView(item.view)}
								title={item.label}
								aria-label={item.label}
							>
								<Icon size={20} strokeWidth={1.75} />
							</button>
						);
					})}
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

			<div
				ref={drawerRef}
				className={`sessions-drawer${drawerOpen ? " drawer-open" : ""}`}
				aria-hidden={!drawerOpen}
			>
				<div className="sessions-drawer-head">
					<span className="sessions-drawer-title">Sessions</span>
					<button type="button" className="btn btn-primary" onClick={onNewSession}>
						<Plus size={14} strokeWidth={2.25} /> New
					</button>
				</div>
				<div className="session-list">
					{sessions.length === 0 && <div className="session-empty">No sessions yet — start a new one.</div>}
					{sessions.map((session) => (
						<button
							key={session.id}
							type="button"
							className={`session-item${session.id === currentSessionId ? " session-active" : ""}`}
							onClick={() => {
								onResume(session.id);
								onCloseDrawer();
							}}
							title={session.id}
						>
							<div className="session-preview">{session.preview || "(empty)"}</div>
							<div className="session-meta">
								{session.agentId} · {new Date(session.updatedAt).toLocaleString()}
							</div>
						</button>
					))}
				</div>
			</div>
		</>
	);
}
