import type { CSSProperties } from "react";
import type { ChatStateSnapshot, ChatStatus } from "../types";

/**
 * 右上角状态浮层：平时折叠为一个小胶囊（仅状态 + 模型名），
 * 悬停/聚焦时展开完整信息（路径 · think · context · tokens · session）。
 * 不挡聊天内容：折叠态宽度 ~150px，且完全透明可穿透。
 */
export function StatusCorner({ snapshot }: { snapshot: ChatStateSnapshot }): React.ReactElement {
	const usage = snapshot.contextUsage;
	const usagePct = usage ? Math.round(usage.usageFraction * 100) : 0;
	const usageColor = usage
		? usagePct >= 90
			? "var(--bad)"
			: usagePct >= 75
				? "var(--warn)"
				: "var(--signal)"
		: "var(--signal)";
	const tokens = snapshot.stats.model.tokens;
	const totalTokens = tokens.totalTokens;
	const hasTokenDetails = totalTokens > 0 || tokens.inputTokens > 0 || tokens.outputTokens > 0;

	return (
		<div className="status-corner" tabIndex={0}>
			{/* 折叠态：状态 pill + 模型名（点击/悬停展开） */}
			<div className="status-corner-mini" aria-hidden="true">
				<span className={`status-pill status-${snapshot.status}`} style={PILL_STYLE[snapshot.status]}>
					{snapshot.status}
				</span>
				<span style={MONO_DIM} className="status-model-mini">
					{snapshot.model}
				</span>
			</div>

			{/* 展开态：完整信息 */}
			<div className="status-corner-full">
				<div className="status-row">
					<span className={`status-pill status-${snapshot.status}`} style={PILL_STYLE[snapshot.status]}>
						{snapshot.status}
					</span>
					<span className="status-cwd" style={MONO_DIM} title={snapshot.cwd}>
						{shortCwd(snapshot.cwd)}
					</span>
				</div>
				<div className="status-row">
					<span style={MONO_DIM}>
						{snapshot.provider}/{snapshot.model}
					</span>
					{snapshot.reasoningLevel && (
						<span className="status-think" style={MONO_DIM} title="thinking level">
							think {snapshot.reasoningLevel}
						</span>
					)}
					<span className="session-id" style={{ ...MONO, color: "var(--text-faint)" }} title={snapshot.sessionId}>
						{snapshot.sessionId.slice(0, 8)}
					</span>
				</div>

				{/* 上下文占用：百分比 + 进度条 + 估算 token */}
				{usage && (
					<div className="status-row status-ctx-row">
						<span className="ctx-label" style={{ ...MONO, color: "var(--text-faint)" }} title={`${usage.tokenEstimate.toLocaleString()} / ${usage.budgetMaxTokens.toLocaleString()} tokens`}>
							context {usagePct}% · {formatTokens(usage.tokenEstimate)} / {formatTokens(usage.budgetMaxTokens)}
						</span>
						<span className="ctx-meter" title={`${usagePct}% of budget`}>
							<span className="ctx-meter-fill" style={{ width: `${usagePct}%`, background: usageColor }} />
						</span>
					</div>
				)}

				{/* token 明细：输入 / 输出 / 推理 / 缓存命中 / 缓存写入 / 总计 */}
				{hasTokenDetails && (
					<div className="status-token-grid">
						<TokenCell label="input" value={tokens.inputTokens} />
						<TokenCell label="output" value={tokens.outputTokens} />
						<TokenCell label="reasoning" value={tokens.reasoningTokens} />
						<TokenCell label="cache hit" value={tokens.cacheReadTokens} />
						<TokenCell label="cache write" value={tokens.cacheWriteTokens} />
						<TokenCell label="total" value={totalTokens} accent />
					</div>
				)}
			</div>
		</div>
	);
}

const MONO: CSSProperties = {
	fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", monospace',
	fontSize: 11,
};

const MONO_DIM: CSSProperties = {
	...MONO,
	color: "var(--text-dim)",
};

/** 五态状态 pill 的强调色。 */
const PILL_STYLE: Record<ChatStatus, CSSProperties> = {
	idle: { color: "var(--text-faint)" },
	thinking: { color: "var(--signal)", background: "var(--signal-soft)" },
	running_tool: { color: "var(--signal)", background: "var(--signal-soft)" },
	done: { color: "var(--good)", background: "color-mix(in srgb, var(--good) 14%, transparent)" },
	error: { color: "var(--bad)", background: "color-mix(in srgb, var(--bad) 14%, transparent)" },
};

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** token 明细小格子。 */
function TokenCell({ label, value, accent }: { label: string; value: number; accent?: boolean }): React.ReactElement {
	if (!value) return <></>;
	return (
		<span className={`status-token-cell${accent ? " token-accent" : ""}`} title={`${label}: ${value.toLocaleString()} tokens`}>
			<span className="token-cell-label">{label}</span>
			<span className="token-cell-value">{formatTokens(value)}</span>
		</span>
	);
}

/** 路径只留末尾两段，避免浮层过长。 */
function shortCwd(cwd: string): string {
	if (!cwd) return "~";
	const parts = cwd.split("/").filter(Boolean);
	if (parts.length <= 2) return cwd;
	return `…/${parts.slice(-2).join("/")}`;
}
