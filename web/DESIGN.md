# evoa Web UI 设计规范（v2 重构）

所有子 agent 必须严格遵守。目标：Awwwards 级暗色先锋设计，支持 dark/light 双主题。

## 硬性规则

1. **禁止 emoji**。所有图标用 `lucide-react`（已安装）。现有组件里的 emoji（💬📊🔍🧬🔧✓⛔⏱⚠✗⏹）全部替换。
2. **数据契约不动**：`web/src/types.ts`、`web/src/ws.ts`、`web/src/api.ts` 禁止修改。
3. **组件 props 签名不动**：只改内部实现与样式类。
4. 主题切换机制：`<html data-theme="dark|light">`，由 App.tsx 管理（useState + localStorage 持久化 + 默认 dark）。CSS 变量在 `:root[data-theme="dark"]` / `:root[data-theme="light"]` 下定义。
5. 文件分工（各自只写自己的文件）：
   - Agent A：`web/src/styles.css`（唯一 CSS 文件，全部样式），可微调 `web/index.html`（字体预载/title）
   - Agent B：`web/src/App.tsx` + `web/src/components/Sidebar.tsx`
   - Agent C：`web/src/components/ChatView.tsx`
   - Agent D：`web/src/components/StatsView.tsx`、`TraceView.tsx`、`EvolveView.tsx`、`Markdown.tsx`

## 设计语言

**概念**："agent 的观测舱"——墨黑虚空 + 琥珀信号灯 + 等宽排版。沉浸、克制、精密仪器感。

### 字体

- 显示/正文：`system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`，关键数字与标签用 `ui-monospace, "JetBrains Mono", "Cascadia Code", monospace`
- 巨型字标：`clamp(4rem, 14vw, 11rem)`，字重 800，`letter-spacing: -0.04em`
- 大数字（stats）：等宽 + `font-variant-numeric: tabular-nums`

### 色板（CSS 变量，前缀 --）

**dark（默认）**：
```
--bg: #0a0b0d         页面底（墨黑）
--bg-elev: #111318    浮层/卡片
--bg-elev2: #181b21   悬浮态
--border: rgba(255,255,255,0.08)
--border-strong: rgba(255,255,255,0.14)
--text: #e8e6e1       暖白
--text-dim: #9b968d
--text-faint: #5d5953
--signal: #ffb020     琥珀信号色（主强调）
--signal-soft: rgba(255,176,32,0.14)
--good: #57d68d
--warn: #ffb020
--bad: #ff5c5c
--volt: #7fb4ff       辅助冷色（链接/次要强调）
--glow: rgba(255,176,32,0.35)
--code-bg: #0d0f12
--glass: rgba(17,19,24,0.72)
```

**light**：
```
--bg: #f4f2ee         纸白（暖调）
--bg-elev: #fbfaf7
--bg-elev2: #ece9e3
--border: rgba(20,18,14,0.10)
--border-strong: rgba(20,18,14,0.18)
--text: #1c1914
--text-dim: #57524a
--text-faint: #8a847a
--signal: #b45309     深琥珀（保持对比度）
--signal-soft: rgba(180,83,9,0.10)
--good: #1a7f37
--warn: #b45309
--bad: #c62828
--volt: #1a5fb4
--glow: rgba(180,83,9,0.25)
--code-bg: #fbfaf7
--glass: rgba(251,250,247,0.78)
```

### 动效

- 消息入场：`rise 0.35s cubic-bezier(0.22,1,0.36,1)`——from `opacity:0; translateY(14px); filter: blur(6px)`
- 视图切换：容器 key 变化时 `fade-slide 0.28s`（opacity + translateX(12px)）
- 按钮 hover：`translateY(-1px)` + box-shadow 光晕；active 按压缩放 0.97
- 状态灯（thinking/running）：琥珀 `pulse` 呼吸（scale + opacity）
- 主题切换：`body { transition: background .35s, color .35s }` + 所有带背景的元素过渡
- 鼠标光晕：App.tsx 监听 mousemove，更新 `--mx/--my`（px），背景 `radial-gradient(600px at var(--mx) var(--my), var(--glow), transparent 70%)` 仅 dark 下明显

### 布局

- 左侧 **rail**（56px 宽，竖排图标导航）：chat/stats/trace/evolve 四个 Lucide 图标 + 底部主题切换按钮。active 项：琥珀左侧 2px 竖条 + signal-soft 背景。hover：图标放大 1.08 + glow
- **Sessions 抽屉**：点击 rail 顶部 logo 或单独按钮展开的浮层面板（fixed，left: 64px，宽 300px，玻璃态），列出 sessions + New 按钮；点击外部关闭
- 主区：全高滚动，内容 max-width 860px 居中
- 顶部状态行（chat 视图内）：等宽小字，从左到右：状态 pill（idle/thinking/running_tool/done/error，琥珀色系）· model/provider · context % · session id（右侧）

## 类名清单（全组件共享，不许发明别的根类）

布局：`.app-shell` `.rail` `.rail-item` `.rail-item-active` `.rail-logo` `.rail-bottom` `.theme-toggle` `.sessions-drawer` `.drawer-open` `.main-stage` `.view-container` `.toasts` `.toast` `.conn` `.conn-on` `.conn-off`

Chat：`.chat-view` `.chat-scroll` `.chat-empty` `.chat-empty-title` `.chat-empty-meta` `.chat-empty-hints` `.msg` `.msg-user` `.msg-assistant` `.msg-system` `.msg-tool` `.tool-head` `.tool-name` `.tool-input-preview` `.tool-caret` `.tool-result-body` `.tool-status-icon` `.tool-duration` `.status-dot` `.running-tool` `.chat-composer` `.composer-input` `.composer-actions` `.status-line` `.status-pill` `.status-idle/thinking/running_tool/done/error` `.ctx-meter` `.session-id` `.btn` `.btn-primary` `.btn-ghost` `.btn-danger` `.btn-icon` `.markdown` `.json-block` `.error-text`

Stats：`.stats-view` `.stat-hero` `.stat-hero-num` `.stat-hero-label` `.stat-grid` `.stat-card` `.stat-card-title` `.stat-row` `.stat-label` `.stat-value` `.ctx-ring` `.bar-track` `.bar-fill`

Trace：`.trace-view` `.trace-toolbar` `.trace-filter` `.trace-count` `.trace-timeline` `.trace-item` `.trace-item-selected` `.trace-time` `.trace-type` `.trace-summary` `.trace-detail` `.trace-detail-head`

Evolve：`.evolve-view` `.evolve-toolbar` `.evolve-list` `.evolve-card` `.evolve-head` `.evolve-badge-good` `.evolve-badge-bad` `.evolve-suite` `.evolve-time` `.evolve-body` `.evolve-agents` `.evolve-desc` `.evolve-reco` `.evolve-details`

## Lucide 图标映射

- 导航：chat=`MessageSquare`，stats=`Activity`，trace=`ScanSearch`（或 `ListTree`），evolve=`Dna`
- 会话：New=`Plus`，关闭抽屉=`X`
- 工具调用：`Wrench`（或 `Hammer`），success=`CheckCircle2`，error=`XCircle`，denied=`ShieldOff`，timeout=`Timer`，limit=`AlertTriangle`，running=`Loader2`（动画 spin）
- 状态：thinking=`BrainCircuit`（动画 pulse），发送=`ArrowUp`，interrupt=`Square`
- 主题：dark 时显示 `Sun`（点击切 light），light 时显示 `Moon`
- logo 处：`Hexagon` 或 `Orbit`（琥珀色）
- 连接状态：`Wifi` / `WifiOff`

## 各视图要点

**ChatView**：空状态 = 巨型 evoa 字标 + 渐变（signal→volt）+ meta 行 + 命令 hint 胶囊。消息流：user 右对齐（signal-soft 底 + 1px signal 边，圆角 14px 14px 4px 14px，max-width 70%）；assistant 左对齐无卡片（纯文字+等宽小字时间戳）；system 居中细字小胶囊；tool 折叠卡片（等宽标题行 + caret 旋转动画）。输入栏：底部固定 glass 条，圆角 16px，聚焦时 1px signal 边 + glow；textarea 自动增高；发送按钮圆形 36px signal 底 ArrowUp。上方状态行等宽小字。busy 时禁用输入、按钮变 interrupt（Square，bad 色）。滚动条细（6px）。

**StatsView**：顶部 hero 区——巨型等宽数字（turns/events/tokens 三个，横向排布，每列 hero-num 大 + hero-label 小写字母间距）。下方 stat-grid（2 列，卡片 bg-elev + 1px border + 12px 圆角），卡片标题 = 等宽大写小字 + 琥珀左 2px。Context 用环形进度（conic-gradient 实现 ctx-ring，中心显示 %）。Tool 状态用四个色点条（success/error/denied/timeout）。全部数字 tabular-nums。

**TraceView**：时间线布局（左侧竖线 + 节点圆点，颜色按事件类型：run=琥珀、model=volt、context=紫、tool=绿、score=青、error=red）。行 hover 高亮，点击展开底部 detail 面板（JsonBlock）。顶部 toolbar：filter 输入（等宽、glass 底）+ count。

**EvolveView**：toolbar（路径输入 + Load 按钮）。卡片列表：head = Δscore badge（good/bad 色）+ suite + 时间；body = baseline/candidate 等宽 + 描述 + recommendation + details 折叠。徽章用色块底（signal-soft/good-soft）不是边框。

**Markdown**：保持组件逻辑不变，类名 `.markdown`（样式在 styles.css：代码块 code-bg、表格边框、行内 code、blockquote 左线）。JsonBlock 类 `.json-block` 等宽小字，max-height 420px 滚动。

**App.tsx**：管理主题（`useState(() => localStorage.getItem("evoa-theme") ?? "dark")`，useEffect 写 `document.documentElement.dataset.theme` + localStorage）。mousemove 更新 --mx/--my。渲染 rail + main-stage（view 切换时 `<div key={view} className="view-container">`）。Sessions 抽屉状态放 App（open/close），点击外部关闭。loading 态：全屏居中 Hexagon spin + "establishing uplink…"。

**Sidebar.tsx**：重写为 rail + sessions 抽屉两个部分（导出组件名仍叫 Sidebar，props 不变：view/onView/sessions/currentSessionId/connected/onNewSession/onResume + 新增可选 onToggleTheme/theme 由 App 传入——注意：App 是 Agent B 自己写的，props 自洽即可，但保留原 props 兼容）。NAV_ITEMS 用 Lucide 组件。

## 验收

- `cd web && npm run build` 零错误零警告
- 无 emoji 残留（grep emoji 范围字符）
- dark/light 切换后变量生效（html[data-theme]）
- 所有视图有内容时排版不破（消息/工具卡片/表格/徽章）
