import { useEffect, useRef, useState } from "react";
import type { ChatStateSnapshot, ClientToServerMessage, ServerToClientMessage, SessionSummary } from "./types";

export interface WebSession {
	snapshot: ChatStateSnapshot | undefined;
	sessions: SessionSummary[];
	systemMessages: string[];
	connected: boolean;
	send: (message: ClientToServerMessage) => void;
	submit: (input: string) => void;
	slash: (input: string) => void;
	interrupt: () => void;
	newSession: () => void;
	resume: (sessionId: string) => void;
}

const MAX_SYSTEM_MESSAGES = 50;

/** 连接后端 WS：开发模式经 Vite 代理（/ws），生产模式同源。 */
function wsUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}/ws`;
}

export function useWebSession(): WebSession {
	const [snapshot, setSnapshot] = useState<ChatStateSnapshot | undefined>(undefined);
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [systemMessages, setSystemMessages] = useState<string[]>([]);
	const [connected, setConnected] = useState(false);
	const socketRef = useRef<WebSocket | undefined>(undefined);
	const retryRef = useRef(0);

	useEffect(() => {
		let disposed = false;
		let socket: WebSocket | undefined;

		const connect = (): void => {
			if (disposed) return;
			socket = new WebSocket(wsUrl());
			socketRef.current = socket;
			socket.onopen = () => {
				retryRef.current = 0;
				setConnected(true);
			};
			socket.onmessage = (event) => {
				const message = JSON.parse(String(event.data)) as ServerToClientMessage;
				if (message.type === "snapshot") setSnapshot(message.snapshot);
				else if (message.type === "sessions") setSessions(message.sessions);
				else if (message.type === "system") {
					setSystemMessages((previous) => [...previous.slice(-(MAX_SYSTEM_MESSAGES - 1)), message.message]);
				}
			};
			socket.onclose = () => {
				setConnected(false);
				if (disposed) return;
				retryRef.current += 1;
				const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
				setTimeout(connect, delay);
			};
			socket.onerror = () => socket?.close();
		};

		connect();
		return () => {
			disposed = true;
			socket?.close();
		};
	}, []);

	const send = (message: ClientToServerMessage): void => {
		const socket = socketRef.current;
		if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	};

	return {
		snapshot,
		sessions,
		systemMessages,
		connected,
		send,
		submit: (input) => send({ type: "submit", input }),
		slash: (input) => send({ type: "slash", input }),
		interrupt: () => send({ type: "interrupt" }),
		newSession: () => send({ type: "new_session" }),
		resume: (sessionId) => send({ type: "resume", sessionId }),
	};
}
