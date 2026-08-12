import { useCallback, useEffect, useState } from "react";
import { Hexagon } from "lucide-react";
import { useWebSession } from "./ws";
import type { ChatView } from "./types";
import { ChatView as ChatPane } from "./components/ChatView";
import { StatsView } from "./components/StatsView";
import { TraceView } from "./components/TraceView";
import { EvolveView } from "./components/EvolveView";
import { Sidebar } from "./components/Sidebar";
import { StatusCorner } from "./components/StatusCorner";

type Theme = "dark" | "light";

export function App(): React.ReactElement {
	const session = useWebSession();
	const [view, setView] = useState<ChatView>("chat");
	const [theme, setTheme] = useState<Theme>(() => {
		// 默认 dark，localStorage 持久化
		return localStorage.getItem("evoa-theme") === "light" ? "light" : "dark";
	});
	const [drawerOpen, setDrawerOpen] = useState(false);

	// 主题：写 html[data-theme] 供 CSS 变量选择，并持久化
	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		localStorage.setItem("evoa-theme", theme);
	}, [theme]);

	// 鼠标光晕：跟踪 --mx/--my（px），供背景 radial-gradient 使用
	useEffect(() => {
		const onMove = (event: MouseEvent): void => {
			const root = document.documentElement;
			root.style.setProperty("--mx", `${event.clientX}px`);
			root.style.setProperty("--my", `${event.clientY}px`);
		};
		window.addEventListener("mousemove", onMove, { passive: true });
		return () => window.removeEventListener("mousemove", onMove);
	}, []);

	// 后端 activeView 变化时跟随（/stats、/trace 等斜杠命令）
	const activeView = session.snapshot?.activeView ?? "chat";
	useEffect(() => {
		setView(activeView);
	}, [activeView]);

	const toggleTheme = useCallback(() => {
		setTheme((previous) => (previous === "dark" ? "light" : "dark"));
	}, []);

	// loading 态：全屏居中 Hexagon spin + establishing uplink
	const snapshot = session.snapshot;
	if (!snapshot) {
		return (
			<div className="app-loading">
				<Hexagon className="spinner" size={44} strokeWidth={1.5} aria-hidden="true" />
				<span>establishing uplink…</span>
			</div>
		);
	}

	const busy = snapshot.status === "thinking" || snapshot.status === "running_tool";

	return (
		<div className="app-shell">
			<Sidebar
				view={view}
				onView={setView}
				sessions={session.sessions}
				currentSessionId={snapshot.sessionId}
				connected={session.connected}
				onNewSession={() => session.newSession()}
				onResume={(sessionId) => session.resume(sessionId)}
				theme={theme}
				onToggleTheme={toggleTheme}
				drawerOpen={drawerOpen}
				onToggleDrawer={() => setDrawerOpen((open) => !open)}
				onCloseDrawer={() => setDrawerOpen(false)}
			/>
			<main className="main-stage">
				<StatusCorner snapshot={snapshot} />
				{session.systemMessages.length > 0 && (
					<div className="toasts" role="status" aria-live="polite">
						{session.systemMessages.map((toast) => (
							<div key={toast.id} className="toast">{toast.text}</div>
						))}
					</div>
				)}
				{/* key 变化触发 fade-slide 视图切换动画 */}
				<div key={view} className="view-container">
					{view === "chat" && <ChatPane snapshot={snapshot} busy={busy} onSubmit={session.submit} onInterrupt={session.interrupt} />}
					{view === "stats" && <StatsView snapshot={snapshot} />}
					{view === "trace" && <TraceView trace={snapshot.trace} />}
					{view === "evolve" && <EvolveView historyPath={undefined} />}
				</div>
			</main>
		</div>
	);
}
