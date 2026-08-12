import { useState } from "react";
import type { ReactElement } from "react";
import { X } from "lucide-react";
import type { TraceEvent } from "../types";
import { JsonBlock } from "./Markdown";

/** 事件类型 → 时间线圆点/类型着色修饰类（颜色由 styles.css 按 .event-* 定义）。 */
const EVENT_COLORS: Record<string, string> = {
	run_start: "event-run",
	run_end: "event-run",
	run_error: "event-error",
	model_request: "event-model",
	model_response: "event-model",
	assistant_delta: "event-model",
	context_view: "event-context",
	context_compaction: "event-context",
	context_trim: "event-context",
	micro_compact: "event-context",
	tool_call: "event-tool",
	tool_result: "event-tool",
	score: "event-score",
	error: "event-error",
};

export function TraceView({ trace }: { trace: TraceEvent[] }): ReactElement {
	const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
	const [filter, setFilter] = useState("");

	const events = trace.filter((event) => !filter || event.type.toLowerCase().includes(filter.toLowerCase()));
	const selected = events.find((event) => event.id === selectedId);

	return (
		<div className="trace-view">
			<div className="trace-toolbar">
				<input
					className="trace-filter"
					placeholder="Filter by event type…"
					value={filter}
					onChange={(event) => {
						setFilter(event.target.value);
						setSelectedId(undefined);
					}}
				/>
				<span className="trace-count">
					{events.length} / {trace.length} events
				</span>
			</div>

			<div className="trace-timeline">
				{events.length === 0 ? (
					<div className="trace-empty">no events match filter</div>
				) : (
					events.map((event) => {
						const color = EVENT_COLORS[event.type] ?? "event-run";
						const isSelected = event.id === selectedId;
						return (
							<div
								key={event.id}
								className={`trace-item ${color}${isSelected ? " trace-item-selected" : ""}`}
								onClick={() => setSelectedId(isSelected ? undefined : event.id)}
							>
								<span className="trace-dot" />
								<span className="trace-time">{new Date(event.timestamp).toLocaleTimeString()}</span>
								<span className="trace-type">{event.type}</span>
								<span className="trace-summary">{summarize(event.payload)}</span>
							</div>
						);
					})
				)}
			</div>

			{selected && (
				<div className="trace-detail">
					<div className="trace-detail-head">
						<strong className="trace-type">{selected.type}</strong>
						<span>{selected.id}</span>
						<button className="btn btn-ghost btn-icon" title="close" onClick={() => setSelectedId(undefined)}>
							<X size={14} />
						</button>
					</div>
					<JsonBlock value={selected.payload} maxChars={8000} />
				</div>
			)}
		</div>
	);
}

function summarize(payload: unknown): string {
	if (payload === undefined || payload === null) return "";
	if (typeof payload === "string") return payload.length > 120 ? `${payload.slice(0, 117)}…` : payload;
	try {
		const text = JSON.stringify(payload);
		return text.length > 120 ? `${text.slice(0, 117)}…` : text;
	} catch {
		return String(payload);
	}
}
