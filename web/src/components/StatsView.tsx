import type { ReactElement, ReactNode } from "react";
import { Activity, CircleDot, Clock, Cpu, Database, Gauge, List, TrendingUp, Wrench } from "lucide-react";
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

function Row({ label, value }: { label: string; value: ReactNode }): ReactElement {
	return (
		<div className="stat-row">
			<span className="stat-label">{label}</span>
			<span className="stat-value">{value}</span>
		</div>
	);
}

function Card({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }): ReactElement {
	return (
		<div className="stat-card">
			<div className="stat-card-title">
				{icon}
				<span>{title}</span>
			</div>
			{children}
		</div>
	);
}

/** Context 环形进度：conic-gradient 由 CSS 变量驱动，dark/light 自动适配。 */
function ContextRing({ fraction }: { fraction: number }): ReactElement {
	const pct = Math.max(0, Math.min(1, fraction)) * 100;
	return (
		<div className="ctx-ring" style={{ background: `conic-gradient(var(--signal) ${pct}%, var(--border) 0)` }}>
			<span className="ctx-ring-center">{pct.toFixed(0)}%</span>
		</div>
	);
}

/** 工具状态四色点条：success / error / denied / timeout。 */
function ToolDotBar({ success, error, denied, timeout }: { success: number; error: number; denied: number; timeout: number }): ReactElement {
	const dots = [
		{ label: "success", n: success, color: "var(--good)" },
		{ label: "error", n: error, color: "var(--bad)" },
		{ label: "denied", n: denied, color: "var(--warn)" },
		{ label: "timeout", n: timeout, color: "#56d4dd" },
	];
	return (
		<div className="tool-dotbar">
			{dots.map((dot) => (
				<span key={dot.label} className="tool-dot" title={dot.label}>
					<span className="tool-dot-dot" style={{ background: dot.color }} />
					<span className="tool-dot-label">{dot.label}</span>
					<span className="tool-dot-count">{dot.n}</span>
				</span>
			))}
		</div>
	);
}

export function StatsView({ snapshot }: { snapshot: ChatStateSnapshot }): ReactElement {
	const stats = snapshot.stats;
	const usage = snapshot.contextUsage;
	const hero = [
		{ label: "turns", value: fmtTokens(stats.overview.turnCount) },
		{ label: "events", value: fmtTokens(stats.overview.eventCount) },
		{ label: "tokens", value: fmtTokens(stats.model.tokens.totalTokens) },
	];
	return (
		<div className="stats-view">
			<div className="stat-hero">
				{hero.map((item) => (
					<div key={item.label} className="stat-hero-col">
						<div className="stat-hero-num">{item.value}</div>
						<div className="stat-hero-label">{item.label}</div>
					</div>
				))}
			</div>

			<div className="stat-grid">
				<Card title="Overview" icon={<Activity size={14} />}>
					<Row label="Status" value={snapshot.status} />
					<Row label="Run duration" value={snapshot.runDurationMs !== undefined ? fmt(snapshot.runDurationMs) : "-"} />
					<Row label="Tool time" value={fmt(snapshot.toolDurationMs)} />
					<Row label="MCP time" value={fmt(snapshot.mcpDurationMs)} />
					<Row label="Skill time" value={fmt(snapshot.skillDurationMs)} />
					{stats.overview.lastError && <Row label="Last error" value={<span className="error-text">{stats.overview.lastError}</span>} />}
				</Card>

				<Card title="Model" icon={<Cpu size={14} />}>
					<Row label="Calls" value={`${stats.model.requestCount} req / ${stats.model.responseCount} resp`} />
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

				<Card title="Context" icon={<CircleDot size={14} />}>
					{usage ? (
						<>
							<div className="ctx-ring-wrap">
								<ContextRing fraction={usage.usageFraction} />
								<div className="ctx-ring-meta">
									<Row label="Estimate" value={fmtTokens(usage.tokenEstimate)} />
									<Row label="Budget" value={fmtTokens(usage.budgetMaxTokens)} />
									<Row label="Effective limit" value={fmtTokens(usage.effectiveLimit)} />
								</div>
							</div>
						</>
					) : (
						<Row label="Usage" value="no context view yet" />
					)}
				</Card>

				<Card title="Tools" icon={<Wrench size={14} />}>
					<Row label="Calls / results" value={`${stats.tools.callCount} / ${stats.tools.resultCount}`} />
					<ToolDotBar
						success={stats.tools.statuses.success}
						error={stats.tools.statuses.error}
						denied={stats.tools.statuses.denied}
						timeout={stats.tools.statuses.timeout}
					/>
					<Row label="Limit exceeded" value={stats.tools.statuses.limit_exceeded} />
					<Row label="Total duration" value={fmt(stats.tools.totalDurationMs)} />
					<Row label="MCP tools" value={`${stats.tools.mcpCount} calls, ${fmt(stats.tools.mcpDurationMs)}`} />
					<Row label="Skill tools" value={`${stats.tools.skillCount} calls, ${fmt(stats.tools.skillDurationMs)}`} />
				</Card>

				<Card title="Scores" icon={<TrendingUp size={14} />}>
					<Row label="Scored turns" value={stats.scores.count} />
					<Row label="Passed" value={stats.scores.passed} />
					{stats.scores.avgRatio !== undefined && <Row label="Avg ratio" value={`${(stats.scores.avgRatio * 100).toFixed(1)}%`} />}
					{stats.scores.latestRatio !== undefined && <Row label="Latest ratio" value={`${(stats.scores.latestRatio * 100).toFixed(1)}%`} />}
				</Card>

				<Card title="Top tools by duration" icon={<Clock size={14} />}>
					{stats.topToolsByDuration.length === 0 ? (
						<Row label="-" value="no tools called" />
					) : (
						stats.topToolsByDuration.slice(0, 10).map((tool) => (
							<Row key={tool.name} label={tool.name} value={`${tool.count}x · ${fmt(tool.totalDurationMs)}${tool.errors > 0 ? ` · ${tool.errors} err` : ""}`} />
						))
					)}
				</Card>

				<Card title="Top tools by count" icon={<List size={14} />}>
					{stats.topToolsByCount.length === 0 ? (
						<Row label="-" value="no tools called" />
					) : (
						stats.topToolsByCount.slice(0, 10).map((tool) => (
							<Row key={tool.name} label={tool.name} value={`${tool.count}x`} />
						))
					)}
				</Card>

				{Object.keys(stats.tools.memory).length > 0 && (
					<Card title="Memory access" icon={<Database size={14} />}>
						{Object.entries(stats.tools.memory).map(([name, count]) => (
							<Row key={name} label={name} value={count} />
						))}
					</Card>
				)}

				{stats.runs.count > 0 && (
					<Card title="Runs" icon={<Gauge size={14} />}>
						<Row label="Total runs" value={stats.runs.count} />
						<Row label="Passed / failed" value={`${stats.runs.passed} / ${stats.runs.failed}`} />
						<Row label="Errored / timeout" value={`${stats.runs.errored} / ${stats.runs.timeout}`} />
						<Row label="Total duration" value={fmt(stats.runs.totalDurationMs)} />
						{stats.runs.avgDurationMs !== undefined && <Row label="Avg duration" value={fmt(stats.runs.avgDurationMs)} />}
					</Card>
				)}
			</div>
		</div>
	);
}
