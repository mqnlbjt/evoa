import type { ChatStateSnapshot } from "../types";

function fmt(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "-";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtTokens(n: number): string {
	return n.toLocaleString();
}

function Row({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
	return (
		<div className="stat-row">
			<span className="stat-label">{label}</span>
			<span className="stat-value">{value}</span>
		</div>
	);
}

function Card({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
	return (
		<div className="stat-card">
			<h3>{title}</h3>
			{children}
		</div>
	);
}

export function StatsView({ snapshot }: { snapshot: ChatStateSnapshot }): React.ReactElement {
	const stats = snapshot.stats;
	const usage = snapshot.contextUsage;
	return (
		<div className="stats-view">
			<div className="stats-grid">
				<Card title="Overview">
					<Row label="Status" value={snapshot.status} />
					<Row label="Turns" value={stats.overview.turnCount} />
					<Row label="Events" value={stats.overview.eventCount} />
					<Row label="Run duration" value={snapshot.runDurationMs !== undefined ? fmt(snapshot.runDurationMs) : "-"} />
					<Row label="Tool time" value={fmt(snapshot.toolDurationMs)} />
					{stats.overview.lastError && <Row label="Last error" value={<span className="error-text">{stats.overview.lastError}</span>} />}
				</Card>
				<Card title="Model">
					<Row label="Calls" value={`${stats.model.requestCount} req / ${stats.model.responseCount} resp`} />
					<Row label="Total tokens" value={fmtTokens(stats.model.tokens.totalTokens)} />
					<Row label="Input tokens" value={fmtTokens(stats.model.tokens.inputTokens)} />
					<Row label="Output tokens" value={fmtTokens(stats.model.tokens.outputTokens)} />
					<Row label="Reasoning tokens" value={fmtTokens(stats.model.tokens.reasoningTokens)} />
					<Row label="Cache read / write" value={`${fmtTokens(stats.model.tokens.cacheReadTokens)} / ${fmtTokens(stats.model.tokens.cacheWriteTokens)}`} />
					{stats.model.latency.count > 0 && (
						<>
							<Row label="Latency" value={`${fmt(stats.model.latency.totalMs)} over ${stats.model.latency.count} calls`} />
					{stats.model.latency.p50Ms !== undefined && stats.model.latency.p95Ms !== undefined && stats.model.latency.p99Ms !== undefined && (
						<Row label="p50 / p95 / p99" value={`${fmt(stats.model.latency.p50Ms)} / ${fmt(stats.model.latency.p95Ms)} / ${fmt(stats.model.latency.p99Ms)}`} />
					)}
						</>
					)}
					{stats.model.ttftMs !== undefined && <Row label="TTFT" value={fmt(stats.model.ttftMs)} />}
					{stats.model.outputTokensPerSecond !== undefined && <Row label="Output speed" value={`${stats.model.outputTokensPerSecond.toFixed(1)} tok/s`} />}
					<Row label="Compactions" value={stats.model.compactionCount} />
					{stats.model.latestTurnUsage && (
						<Row label="Last turn" value={`${stats.model.latestTurnUsage.purpose}: ${fmtTokens(stats.model.latestTurnUsage.totalTokens)} tokens`} />
					)}
				</Card>
				<Card title="Context">
					{usage ? (
						<>
							<Row label="Usage" value={`${(usage.usageFraction * 100).toFixed(1)}%`} />
							<Row label="Estimate" value={fmtTokens(usage.tokenEstimate)} />
							<Row label="Budget" value={fmtTokens(usage.budgetMaxTokens)} />
							<Row label="Effective limit" value={fmtTokens(usage.effectiveLimit)} />
						</>
					) : (
						<Row label="Usage" value="no context view yet" />
					)}
				</Card>
				<Card title="Tools">
					<Row label="Calls / results" value={`${stats.tools.callCount} / ${stats.tools.resultCount}`} />
					<Row label="Success / error / denied" value={`${stats.tools.statuses.success} / ${stats.tools.statuses.error} / ${stats.tools.statuses.denied}`} />
					<Row label="Timeout / limit" value={`${stats.tools.statuses.timeout} / ${stats.tools.statuses.limit_exceeded}`} />
					<Row label="Total duration" value={fmt(stats.tools.totalDurationMs)} />
					<Row label="MCP tools" value={`${stats.tools.mcpCount} calls, ${fmt(stats.tools.mcpDurationMs)}`} />
					<Row label="Skill tools" value={`${stats.tools.skillCount} calls, ${fmt(stats.tools.skillDurationMs)}`} />
				</Card>
				<Card title="Scores">
					<Row label="Scored turns" value={stats.scores.count} />
					<Row label="Passed" value={stats.scores.passed} />
					{stats.scores.avgRatio !== undefined && <Row label="Avg ratio" value={`${(stats.scores.avgRatio * 100).toFixed(1)}%`} />}
				</Card>
				<Card title="Top tools by duration">
					{stats.topToolsByDuration.length === 0 ? (
						<Row label="-" value="no tools called" />
					) : (
						stats.topToolsByDuration.slice(0, 10).map((tool) => (
							<Row key={tool.name} label={tool.name} value={`${tool.count}x · ${fmt(tool.totalDurationMs)}${tool.errors > 0 ? ` · ${tool.errors} err` : ""}`} />
						))
					)}
				</Card>
				<Card title="Top tools by count">
					{stats.topToolsByCount.length === 0 ? (
						<Row label="-" value="no tools called" />
					) : (
						stats.topToolsByCount.slice(0, 10).map((tool) => (
							<Row key={tool.name} label={tool.name} value={`${tool.count}x`} />
						))
					)}
				</Card>
				{Object.keys(stats.tools.memory).length > 0 && (
					<Card title="Memory access">
						{Object.entries(stats.tools.memory).map(([name, count]) => (
							<Row key={name} label={name} value={count} />
						))}
					</Card>
				)}
			</div>
		</div>
	);
}
