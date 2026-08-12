import { useState } from "react";
import type { TraceEvent } from "../types";
import { JsonBlock } from "./Markdown";

const EVENT_COLORS: Record<string, string> = {
	run_start: "event-run",
	run_end: "event-run",
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

export function TraceView({ trace }: { trace: TraceEvent[] }): React.ReactElement {
	const [selected, setSelected] = useState<TraceEvent | undefined>(undefined);
	const [filter, setFilter] = useState("");

	const events = trace.filter((event) => !filter || event.type.includes(filter));

	return (
		<div className="trace-view">
			<div className="trace-header">
				<input
					className="trace-filter"
					placeholder="Filter by event type…"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
				<span className="trace-count">{events.length} / {trace.length} events</span>
			</div>
			<table className="trace-table">
				<thead>
					<tr>
						<th>time</th>
						<th>type</th>
						<th>summary</th>
					</tr>
				</thead>
				<tbody>
					{events.map((event) => (
						<tr key={event.id} className={`trace-row ${EVENT_COLORS[event.type] ?? ""}`} onClick={() => setSelected(event)}>
							<td className="trace-time">{new Date(event.timestamp).toLocaleTimeString()}</td>
							<td className="trace-type">{event.type}</td>
							<td className="trace-summary">{summarize(event.payload)}</td>
						</tr>
					))}
				</tbody>
			</table>
			{selected && (
				<div className="trace-detail">
					<div className="trace-detail-head">
						<strong>{selected.type}</strong>
						<span>{selected.id}</span>
						<button className="btn btn-small" onClick={() => setSelected(undefined)}>close</button>
					</div>
					<JsonBlock value={selected.payload} maxChars={8000} />
				</div>
			)}
		</div>
	);
}

function summarize(payload: unknown): string {
	if (payload === undefined || payload === null) return "";
	if (typeof payload === "string") return payload.length > 100 ? `${payload.slice(0, 97)}…` : payload;
	try {
		const text = JSON.stringify(payload);
		return text.length > 100 ? `${text.slice(0, 97)}…` : text;
	} catch {
		return String(payload);
	}
}
