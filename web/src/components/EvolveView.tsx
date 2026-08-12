import { useEffect, useState } from "react";
import { api } from "../api";
import type { EvolutionHistoryRecord } from "../types";
import { JsonBlock } from "./Markdown";

export function EvolveView({ historyPath }: { historyPath: string | undefined }): React.ReactElement {
	const [records, setRecords] = useState<EvolutionHistoryRecord[]>([]);
	const [path, setPath] = useState(historyPath ?? "");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [expanded, setExpanded] = useState<string | undefined>(undefined);

	const load = async (history: string): Promise<void> => {
		if (!history.trim()) {
			setRecords([]);
			return;
		}
		setLoading(true);
		setError(undefined);
		try {
			setRecords(await api.evolution(history.trim()));
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : String(loadError));
			setRecords([]);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		if (path.trim()) void load(path);
		// 只在首次挂载时自动加载（historyPath 来自 CLI 参数）
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="evolve-view">
			<div className="evolve-header">
				<input
					className="trace-filter"
					placeholder="Evolution history JSONL path…"
					value={path}
					onChange={(event) => setPath(event.target.value)}
					onKeyDown={(event) => { if (event.key === "Enter") void load(path); }}
				/>
				<button className="btn btn-primary" onClick={() => void load(path)} disabled={loading}>
					{loading ? "Loading…" : "Load"}
				</button>
			</div>
			{error && <div className="error-text">{error}</div>}
			{records.length === 0 && !error && <div className="evolve-empty">No evolution history loaded. Point to a JSONL file produced by <code>evoa evolve --history &lt;file&gt;</code>.</div>}
			<div className="evolve-list">
				{records.map((record) => (
					<div key={record.timestamp + record.suiteId + record.baselineAgent.id} className="evolve-card">
						<div className="evolve-card-head">
							<span className={`evolve-badge ${record.deltaScore >= 0 ? "badge-good" : "badge-bad"}`}>
								Δ{(record.deltaScore >= 0 ? "+" : "")}{record.deltaScore.toFixed(2)}
							</span>
							<span className={`evolve-badge ${record.deltaPassRate >= 0 ? "badge-good" : "badge-bad"}`}>
								pass {(record.deltaPassRate >= 0 ? "+" : "")}{(record.deltaPassRate * 100).toFixed(0)}%
							</span>
							<span className="evolve-suite">{record.suiteId}</span>
							<span className="evolve-time">{new Date(record.timestamp).toLocaleString()}</span>
						</div>
						<div className="evolve-card-body">
							<div className="evolve-agents">
								<span>baseline: <code>{record.baselineAgent.id}</code></span>
								<span>candidate: <code>{record.candidateAgent.id}</code>{record.candidate ? ` (${record.candidate.kind})` : ""}</span>
							</div>
							{record.candidate?.description && <p className="evolve-desc">{record.candidate.description}</p>}
							<div className="evolve-reco">recommendation: <strong>{record.recommendation}</strong></div>
							{(record.improvements.length > 0 || record.regressions.length > 0) && (
								<button className="btn btn-small" onClick={() => setExpanded(expanded === record.timestamp ? undefined : record.timestamp)}>
									{expanded === record.timestamp ? "Hide details" : "Show details"}
								</button>
							)}
							{expanded === record.timestamp && (
								<div className="evolve-details">
									{record.improvements.length > 0 && (
										<div className="evolve-improvements">
											<strong>improvements</strong>
											<ul>{record.improvements.map((item) => <li key={item}>{item}</li>)}</ul>
										</div>
									)}
									{record.regressions.length > 0 && (
										<div className="evolve-regressions">
											<strong>regressions</strong>
											<ul>{record.regressions.map((item) => <li key={item}>{item}</li>)}</ul>
										</div>
									)}
									{record.candidate?.patch && <JsonBlock value={record.candidate.patch} maxChars={6000} />}
								</div>
							)}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
