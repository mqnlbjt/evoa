# evolving-agent TUI 需求整理（pi 风格轻量方案）

## 目标

为 `evolving-agent` 增加一个轻量 TUI，让本地 Agent 的运行过程可见、可交互、可调试。

核心目标不是复制 Claude Code 的重型自研终端 UI，而是参考 pi：

- 轻量 component tree
- 事件驱动 UI 更新
- 工具执行过程可视化
- bash / 文件操作 / trace 清晰展示
- 后续能承载 subagent、MCP、skill、权限审批

## 非目标

第一版不做：

- 不做 Claude Code 那种完整 React reconciler / Ink replacement
- 不做复杂鼠标交互
- 不做 alt-screen 全屏复杂布局
- 不做完整 terminal protocol 支持
- 不做高级 Vim mode
- 不做复杂主题系统
- 不做完整 permission DSL

## 总体架构

推荐架构：

```text
AgentRuntime emits events
        ↓
InteractiveMode subscribes events
        ↓
TUI state updates
        ↓
Component tree render
        ↓
Terminal diff refresh
```

TUI 不直接控制 Agent 执行逻辑，只订阅 runtime/session/tool events。

## 核心模块

### 1. Terminal 抽象

需要一个小型终端接口：

```text
Terminal
- write(text)
- clear()
- setRawMode(enabled)
- onInput(callback)
- onResize(callback)
- width
- height
```

实现：

- `ProcessTerminal`：真实 stdin/stdout
- `FakeTerminal`：测试用

目的：隔离 Node terminal 细节，方便测试输入、输出、resize，后续支持更复杂 renderer。

### 2. TUI Root 布局

第一版布局：

```text
┌ Header ───────────────────────────────┐
│ agent / model / profile / cwd          │
├ Chat Log ─────────────────────────────┤
│ user message                           │
│ assistant message                      │
│ tool call/result                       │
├ Pending / Running Area ───────────────┤
│ running bash / tool spinner            │
├ Status / Footer ──────────────────────┤
│ turns / tool calls / tokens / mode      │
├ Input Editor ─────────────────────────┤
│ > user input                           │
└───────────────────────────────────────┘
```

第一版可以不是严格全屏，也可以是“持续刷新的 terminal app”。

### 3. Header

显示当前 session 基本信息：

- agent name / id
- model provider / model
- tool profile
- sandbox mode
- workspace root 或 cwd
- session id

示例：

```text
evolving-agent | demo12 | model: local/fake | profile: benchmark-sandbox | cwd: evolving-agent
```

### 4. Chat Log

展示消息历史：

- user message
- assistant message
- tool call
- tool result
- errors / denied / timeout

要求：

- assistant text 支持基础 Markdown
- tool result 默认折叠
- error / denied 明显标识
- 最新内容始终可见
- 历史内容可截断或滚动

第一版 Markdown 能力：paragraph、bullet list、code block、inline code、简化 heading。

### 5. Input Editor

第一版需求：

- 单行输入
- Enter 提交
- Ctrl+C 取消当前输入或退出
- Up/Down 历史记录
- 支持粘贴普通文本
- 支持 `/` slash command 的基础识别

后续增强：

- 多行输入
- Ctrl+Enter 提交
- autocomplete
- command suggestions
- Vim mode
- bracketed paste

### 6. Status / Footer

Footer 由状态 provider 提供数据，不直接耦合 UI。

显示：

- current turn
- tool call count
- max tool calls
- current status: idle / thinking / running tool / done / error
- sandbox mode
- running tool name
- elapsed time

后续显示：token usage、cost、context usage、git branch、memory status、subagent count。

## Event-driven UI

TUI 监听 runtime events，而不是解析 stdout。

需要覆盖现有 trace/event：

- `run_start`
- `model_request`
- `model_response`
- `tool_call`
- `tool_result`
- `score`
- `run_end`
- error / timeout / denied

UI 状态映射：

```text
model_request  -> thinking
model_response -> assistant message
tool_call      -> create pending tool component
tool_result    -> resolve tool component
run_end        -> idle/done
```

## Tool Renderer

每个工具有统一 renderer contract：

```text
ToolRenderer
- renderCall(call)
- renderResult(result)
- renderRunning(call)
- renderError(result)
```

默认 fallback：

```text
Tool: <name>
Status: success/error/denied/timeout
Input: compact JSON
Output: compact JSON
```

## 内置工具渲染需求

### read_file

显示 path、size、success/error；内容默认不全量展开。

### write_file

显示 path、created/updated、bytesWritten。

### edit_file

显示 path、editsApplied、bytesWritten。

### bash

显示 command、cwd、running spinner、exitCode、duration、stdout/stderr preview、truncated marker、timedOut marker。

默认折叠：

```text
$ npm test
✓ exit 0 · 2.3s · stdout 20 lines
```

展开后显示 stdout/stderr。

### web_fetch

显示 url、finalUrl、status、title、bytesRead、truncated。

### subagent（后续）

显示 subagent id、role、status、answer summary、nested trace summary。

## Tool 状态

工具组件状态：queued、running、success、error、denied、timeout、cancelled。

UI 要求：

- running 有 spinner
- denied 使用明显但不夸张的标识
- error 显示 errorMessage
- timeout 显示 timeoutMs
- success 显示摘要

## Bash 输出策略

第一版：

- bash 结果完成后展示
- stdout/stderr 默认 preview
- 大输出截断
- 保留完整 output 在 trace/result 中

后续：streaming stdout/stderr、expand/collapse、save full output file、cancel running command。

## Approval / Permission UI

第一版可以先不实现交互审批，但 UI 结构要预留：

```text
PermissionRequest
- tool name
- risk
- reason
- input summary
- allow once
- deny
```

后续用于 dangerous command、write outside normal area、MCP tool、network access、dependency install。

## Slash Commands

第一版支持基础命令：

- `/help`
- `/clear`
- `/exit`
- `/status`
- `/tools`
- `/memory`
- `/trace`

后续：`/plan`、`/agents`、`/sandbox`、`/export`、`/resume`。

设计要求：slash command parser 与 UI 分离；命令可以返回 UI message；命令可以触发 runtime action。

## Trace 可视化

TUI 应能显示简化 trace：

```text
run_start
model_request
model_response
tool_call bash
tool_result success
run_end
```

第一版：`/trace` 输出最近 N 个事件；tool call/result 可跳转或展开。

## Subagent 预留

TUI 要为 subagent 做结构预留：

```text
Main Agent
  └─ Subagent: researcher
      ├─ model_response
      ├─ tool_call grep
      └─ result
```

第一版可以只显示 summary：

```text
Subagent researcher completed · 8 events · answer: ...
```

## 测试需求

需要可测试：

- fake terminal 输出
- input editor key handling
- event -> UI state 映射
- tool renderer output
- bash result rendering
- denied/error/timeout rendering
- slash command parsing

测试不依赖真实 TTY。

## 推荐第一版里程碑

MVP 范围：

1. Terminal abstraction
2. Simple renderer
3. Chat log
4. Input prompt
5. Runtime event subscription
6. Tool call/result rendering
7. Bash renderer
8. Footer/status
9. `/help` `/clear` `/exit` `/trace`

暂不做：streaming bash、approval prompt、subagent tree、complex markdown、mouse/scrollback、advanced autocomplete。

## 设计原则

- UI 只消费事件，不嵌入 runtime 逻辑
- terminal I/O 必须可 mock
- tool renderer 独立于 tool execution
- 默认折叠复杂输出
- 错误和 denied 必须清楚
- 第一版优先稳定和可测试
- 保持 pi 风格轻量，不走 Claude Code 重型路线

## 实施状态

- [x] MVP TUI 已实现。
- [x] Terminal abstraction、ProcessTerminal、FakeTerminal 已实现。
- [x] Runtime event subscription 已实现，TUI 可消费 `model_request`、`model_response`、`tool_call`、`tool_result` 等 trace event。
- [x] Chat log、input prompt、footer/status 已实现。
- [x] Tool call/result renderer 与 bash renderer 已实现。
- [x] Slash commands 已实现：`/help`、`/clear`、`/exit`、`/quit`、`/status`、`/tools`、`/memory`、`/trace`。
- [x] CLI 入口已实现：`evolving-agent tui`。
- [x] 验证通过：`npm run typecheck`、`npm test`、`npm run build`。
