import { useEffect, useState } from "react";
import { useWebSession } from "./ws";
import type { ChatView } from "./types";
import { ChatView as ChatPane } from "./components/ChatView";
import { StatsView } from "./components/StatsView";
import { TraceView } from "./components/TraceView";
import { EvolveView } from "./components/EvolveView";
import { Sidebar } from "./components/Sidebar";

export function App(): React.ReactElement {
	const session = useWebSession();
	const [view, setView] = useState<ChatView>("chat");

	// 后端 activeView 变化时跟随（/stats、/trace 等斜杠命令）
	const activeView = session.snapshot?.activeView ?? "chat";
	useEffect(() => {
		setView(activeView);
	}, [activeView]);

	const snapshot = session.snapshot;
	if (!snapshot) {
		return (
			<div className="app-loading">
				<div className="spinner" /> connecting to evoa server…
			</div>
		);
	}

	const busy = snapshot.status === "thinking" || snapshot.status === "running_tool";

	return (
		<div className="app">
			<Sidebar
				view={view}
				onView={setView}
				sessions={session.sessions}
				currentSessionId={snapshot.sessionId}
				connected={session.connected}
				onNewSession={() => session.newSession()}
				onResume={(sessionId) => session.resume(sessionId)}
			/>
			<main className="main">
				{session.systemMessages.length > 0 && (
					<div className="toasts">
						{session.systemMessages.map((message, index) => (
							<div key={`${index}-${message.slice(0, 24)}`} className="toast">{message}</div>
						))}
					</div>
				)}
				{view === "chat" && <ChatPane snapshot={snapshot} busy={busy} onSubmit={session.submit} onInterrupt={session.interrupt} />}
				{view === "stats" && <StatsView snapshot={snapshot} />}
				{view === "trace" && <TraceView trace={snapshot.trace} />}
				{view === "evolve" && <EvolveView historyPath={undefined} />}
			</main>
		</div>
	);
}
