import type { ChatView, SessionSummary } from "../types";

interface SidebarProps {
	view: ChatView;
	onView: (view: ChatView) => void;
	sessions: SessionSummary[];
	currentSessionId: string | undefined;
	connected: boolean;
	onNewSession: () => void;
	onResume: (sessionId: string) => void;
}

const NAV_ITEMS: Array<{ view: ChatView; label: string; icon: string }> = [
	{ view: "chat", label: "Chat", icon: "💬" },
	{ view: "stats", label: "Stats", icon: "📊" },
	{ view: "trace", label: "Trace", icon: "🔍" },
	{ view: "evolve", label: "Evolve", icon: "🧬" },
];

export function Sidebar({ view, onView, sessions, currentSessionId, connected, onNewSession, onResume }: SidebarProps): React.ReactElement {
	return (
		<aside className="sidebar">
			<div className="sidebar-brand">
				<span className="brand-dot" /> evoa
				<span className={`conn ${connected ? "conn-on" : "conn-off"}`} title={connected ? "connected" : "reconnecting…"} />
			</div>
			<nav className="sidebar-nav">
				{NAV_ITEMS.map((item) => (
					<button
						key={item.view}
						className={`nav-item ${view === item.view ? "nav-active" : ""}`}
						onClick={() => onView(item.view)}
					>
						<span>{item.icon}</span> {item.label}
					</button>
				))}
			</nav>
			<div className="sidebar-sessions">
				<div className="sidebar-section-head">
					<span>Sessions</span>
					<button className="btn btn-small" onClick={onNewSession} title="New session">+ New</button>
				</div>
				<div className="session-list">
					{sessions.length === 0 && <div className="session-empty">No saved sessions</div>}
					{sessions.map((session) => (
						<button
							key={session.id}
							className={`session-item ${session.id === currentSessionId ? "session-active" : ""}`}
							onClick={() => onResume(session.id)}
							title={session.id}
						>
							<div className="session-preview">{session.preview || "(empty)"}</div>
							<div className="session-meta">{session.agentId} · {new Date(session.updatedAt).toLocaleString()}</div>
						</button>
					))}
				</div>
			</div>
		</aside>
	);
}
