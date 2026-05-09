# evolving-agent 阶段性记录（2026-05-07）

## 当前阶段目标

把 `evolving-agent` 从”Agent 规格 + Benchmark 骨架”推进到一个可以直接启动、可以对话、可以保存 session、可以评测、可以接入本地 OpenAI/Anthropic 兼容服务、具备 TUI 交互界面、支持上下文压缩和记忆管理的通用 Agent runtime。

参考方向：

- 借鉴 Claude Code 的 agent 定义、权限控制、验证思路。
- 借鉴 pi 的清晰 runtime/session/model 分层和 OpenAI/Anthropic provider 思路。
- 保持 `evolving-agent` 自身轻量、独立，优先成为可用的 Agent runtime，再用 benchmark 和 evolution 做验证与改进。

## 已完成内容

### 1. Runtime 基础

文件：

- `src/runtime/agent-runtime.ts` — `AgentRuntime` 主入口
- `src/runtime/loop.ts` — 多 turn loop，含 compaction/micro-compact/truncation 集成
- `src/runtime/session.ts` — `AgentSession` 生命周期、session entry 管理、compaction entry
- `src/runtime/events.ts` — RuntimeEventTrace：模型请求/响应、tool call/result
- `src/runtime/budget.ts` — 上下文预算解析、token 估算、compaction 触发判断
- `src/runtime/compaction.ts` — 上下文压缩（LLM 摘要合并）
- `src/runtime/micro-compact.ts` — 微压缩（清理旧 tool result 内容）
- `src/runtime/context-view.ts` — 上下文视图构建、硬裁剪/激进裁剪/关键裁剪/回退最小集合
- `src/runtime/timeout.ts` — 超时控制

当前能力：

- `AgentRuntime` 实现 `AgentRuntimeExecutor`。
- 支持创建 `AgentSession`，管理 session entry 生命周期。
- 支持将 `AgentSpec + TaskSpec` 转成模型请求。
- 支持记录 `model_request`、`model_response`、`tool_call`、`tool_result` trace。
- 支持多 turn loop，含 `maxTurns` 和 `timeoutMs` 控制。
- 支持上下文压缩：token 超阈值时自动触发 LLM 摘要压缩，保留近期 entries。
- 支持微压缩：对旧 tool result 内容做轻量清理，仅保留近期工具输出。
- 支持上下文裁剪：hard trim → aggressive trim → fallback minimal 三级裁剪策略。
- 支持工具输出截断：head-tail / head-only 策略，UTF-8 安全字节截断。
- 支持通过 `ModelClient` 抽象替换不同模型后端。

### 2. 工具系统与权限策略

文件：

- `src/tools/registry.ts` — 工具注册、执行、结果截断
- `src/tools/policy.ts` — 权限策略
- `src/tools/types.ts` — 工具类型定义
- `src/tools/workspace.ts` — workspace 路径校验
- `src/tools/read-only.ts` — 只读工具（read_file、list_dir、find_files、grep）
- `src/tools/mutating.ts` — 可变工具（write_file、edit_file）
- `src/tools/bash-executor.ts` — bash 执行器
- `src/tools/sandbox.ts` — 工具沙箱约束
- `src/tools/subagent.ts` — 子 agent 调用工具
- `src/tools/profiles.ts` — tool profile（read-only/coding/benchmark-sandbox/dangerous）
- `src/tools/truncation.ts` — 工具输出截断（UTF-8 安全字节截断）
- `src/tools/web-fetch.ts` — Web 获取工具

当前能力：

- `ToolRegistry` 注册和执行工具。
- `ToolDecision` 判断工具是否允许执行。
- 支持 `allow` / `deny` / `ask` 三级权限。
- `agent.tools.deniedTools` 优先级高于 allowed tools。
- `task.allowedTools` 可以进一步收窄 agent 的工具权限。
- 支持 `maxToolCalls` 限制。
- 支持 runtime hooks：`beforeToolCall` / `afterToolResult`。
- 工具输出自动截断（head-tail/head-only），防止超长输出撑爆上下文。
- Web fetch 工具支持超时、输出截断和元数据返回。

### 3. Benchmark 与 Evolution 基础

已有并扩展：

- `src/benchmark/runner.ts`
- `src/benchmark/leaderboard.ts`
- `src/evolution/engine.ts`
- `src/evolution/types.ts`

当前能力：

- `BenchmarkRunner` 可以运行 suite。
- 支持 task run trace、score、summary。
- 支持 leaderboard。
- 新增 `BenchmarkEvolutionEngine`。
- 可以比较 baseline agent 与 candidate agent。
- 可以计算：
  - `deltaScore`
  - `deltaPassRate`
  - regressions
  - improvements
  - recommendation: `accept` / `reject` / `needs-review`

### 4. Verification Pattern

新增：

- `src/verification/verifier.ts`

当前能力：

- deterministic verifier。
- 能检查：
  - regression
  - error
  - timeout
  - denied tool-policy event
- 输出 `VerificationReport`。

这部分参考 Claude Code 的 verification agent 思路，但目前不是独立 subagent，而是轻量验证模块。

### 5. 持久化

新增：

- `src/sessions/jsonl-store.ts`
- `src/sessions/run-store.ts`

当前能力：

- `MemoryRunStore` 保存内存结果。
- `JsonlRunStore` 以 JSONL 方式保存 task run 和 suite run。
- 适合后续重放、分析、生成报告。

### 6. Agent Definition Loader

新增：

- `src/agents/loader.ts`
- `src/agents/validation.ts`

当前能力：

- 支持从 JSON object/file 加载 `AgentSpec`。
- 支持 bundle 格式：`agents` + `subagents`。
- 支持 duplicate agent id 后者覆盖前者。
- 支持基础 schema/runtime/tool policy 校验。
- 新增 `SubagentSpec` 类型，但还没有自动调度 subagent。

### 7. OpenAI Responses 格式接入

新增：

- `src/models/openai-client.ts`
- `test/openai-client.test.ts`

当前能力：

- `OpenAIModelClient` 实现 `ModelClient`。
- 使用 OpenAI Responses API。
- 支持：
  - `apiKey`
  - `baseURL`
  - `defaultHeaders`
  - `temperature`
  - `maxOutputTokens`
  - `store`
  - `reasoningLevel`
- 已用本地服务测试通过：

```txt
baseURL: http://localhost:8317/v1
apiKey: 12345678
model: gpt-5.4-mini
response: ok
```

### 8. Anthropic Messages 格式接入

新增：

- `src/models/anthropic-client.ts`
- `test/anthropic-client.test.ts`

当前能力：

- `AnthropicModelClient` 实现 `ModelClient`。
- 使用 Anthropic Messages API 格式。
- 支持：
  - `apiKey`
  - `baseURL`
  - `anthropicVersion`
  - `maxTokens`
  - custom headers
  - custom fetch
- 已用同一个本地服务测试通过：

```txt
baseURL: http://localhost:8317/v1
apiKey: 12345678
model: gpt-5.4-mini
response: ok
```

### 9. Provider-neutral Tool Call 历史

新增/扩展：

- `src/models/types.ts`
- `src/runtime/loop.ts`
- `src/models/openai-client.ts`
- `src/models/anthropic-client.ts`
- `test/agent-runtime.test.ts`
- `test/openai-client.test.ts`
- `test/anthropic-client.test.ts`

当前能力：

- `ModelMessage` 新增 `contentBlocks`，支持 provider-neutral：
  - `text`
  - `tool_call`
  - `tool_result`
- runtime 在模型返回 tool call 时，会先把 assistant tool-call turn 写入 session history，再执行工具。
- tool result 同时保留原有 string content 和结构化 `tool_result` block。
- OpenAI Responses client 可以把 assistant `tool_call` block 回放为 `function_call` input item。
- OpenAI Responses client 继续把 tool result 回放为 `function_call_output`。
- Anthropic Messages client 可以把 assistant `tool_call` block 回放为 assistant `tool_use` content block。
- Anthropic Messages client 继续把 tool result 回放为 user `tool_result` content block。
- 新增测试覆盖：
  - tool-only assistant turn 不丢失。
  - mixed text + tool call assistant turn 不丢失。
  - OpenAI/Anthropic 第二轮 tool-call payload 可从 neutral history 重建。

这一步吸收了 pi 的结构化 assistant/toolResult message 思路，也为后续 Claude Code 风格 subagent sidechain transcript、fork context 和 verifier replay 打基础。

### 10. 模型发现、ModelRegistry 与模型路由

文件：

- `src/models/provider-types.ts` — provider 类型定义
- `src/models/discovery.ts` — OpenAI 兼容模型发现
- `src/models/registry.ts` — `ModelRegistry` 注册/发现/创建 client
- `src/models/router.ts` — 基于 purpose 的模型路由
- `src/models/cache.ts` — 模型缓存
- `src/models/types.ts` — provider-neutral 类型
- `src/models/openai-client.ts` — OpenAI Responses API
- `src/models/anthropic-client.ts` — Anthropic Messages API

当前能力：

- `discoverOpenAICompatibleModels` 支持 OpenAI 兼容 `/v1/models` 发现。
- 支持 URL 规范化，避免重复 `/v1` 或 `/models`。
- `ModelRegistry` 支持 provider 注册、模型发现、手动注册、client 创建。
- `ModelRegistry.createClient` 创建 `openai-responses` / `anthropic-messages` client。
- **模型路由**: 支持 `aliases` 别名、`routes` 按 purpose 路由（main/compaction/summary/memory/extraction 等）、`purposeRules`（codingTasks/toolHeavy）智能路由。
- Anthropic provider 支持手动注册和 client 创建，暂不支持自动模型发现。

### 11. CLI、Chat 与 TUI 交互

文件：

- `src/cli.ts` — CLI 入口
- `src/cli/args.ts` — CLI 参数解析
- `src/cli/main.ts` — CLI 主流程
- `src/cli/commands.ts` — 子命令（chat/run/benchmark/evolve/models/tui）
- `src/cli/format.ts` — 输出格式化
- `src/cli/config.ts` — CLI 默认配置
- `src/cli/chat-service.ts` — Chat 服务（session/memory/tools 编排）
- `src/cli/model-routing.ts` — 模型路由 CLI 集成
- `src/cli/tui-command.ts` — TUI 命令入口
- `src/tui/` — 完整 TUI 系统（19 个文件）

当前能力：

- `evolving-agent chat "你好"` — 单次对话。
- `evolving-agent chat` — 交互式连续对话。
- `evolving-agent run` — 加载 agent/task JSON 运行单个 task。
- `evolving-agent benchmark` — 加载 suite/agent JSON 运行 benchmark。
- `evolving-agent evolve` — baseline/candidate 对比。
- `evolving-agent models discover` — 模型发现。
- `evolving-agent tui` — 启动轻量 TUI 交互模式。
- `--session <id>` 保存 session，`--resume <id>` 恢复 session。
- `--tool-profile` 指定工具配置，默认 dangerous。
- `--json` 输出稳定机器可读 JSON。
- `--report` 输出 benchmark/evolution JSON 或 Markdown report。
- 默认 CLI 配置减少启动 agent 时必须传的参数数量。

### 12. TUI 交互系统

文件（19 个）：

- `src/tui/index.ts` — TUI 总入口
- `src/tui/state.ts` — TUI 状态管理
- `src/tui/renderer.ts` — 主渲染器
- `src/tui/screen-renderer.ts` — 屏幕渲染
- `src/tui/markdown.ts` — Markdown 渲染
- `src/tui/bash-renderer.ts` — Bash 输出渲染
- `src/tui/tool-renderers.ts` — 工具调用渲染
- `src/tui/terminal.ts` — 终端接口抽象
- `src/tui/process-terminal.ts` — 真实终端
- `src/tui/fake-terminal.ts` — 测试用假终端
- `src/tui/input-editor.ts` — 输入编辑器
- `src/tui/interactive-mode.ts` — 交互模式
- `src/tui/turn-controller.ts` — Turn 控制器
- `src/tui/slash-commands.ts` — 斜杠命令
- `src/tui/viewport-controller.ts` — 视口滚动控制
- `src/tui/render-scheduler.ts` — 渲染调度
- `src/tui/stats.ts` — 统计信息显示
- `src/tui/tui-session.ts` — TUI 会话管理
- `src/tui/types.ts` — TUI 类型定义

### 13. MCP 工具集成

文件（7 个）：

- `src/mcp/types.ts` — MCP 类型定义
- `src/mcp/client.ts` — MCP 客户端
- `src/mcp/registry.ts` — MCP 工具注册
- `src/mcp/adapter.ts` — MCP 适配器
- `src/mcp/names.ts` — MCP 工具命名
- `src/mcp/result.ts` — MCP 结果处理
- `src/mcp/diagnostics.ts` — MCP 诊断

当前能力：

- 支持 MCP STDIO 和 HTTP 传输。
- MCP 工具可注册到 `ToolRegistry`，受权限策略约束。
- 支持 MCP 工具命名空间隔离。

### 14. 记忆管理

文件（10 个）：

- `src/memory/types.ts` — 记忆类型定义
- `src/memory/manager.ts` — 记忆管理器
- `src/memory/tools.ts` — 记忆工具（save/recall/forget）
- `src/memory/extractor.ts` — 记忆提取器
- `src/memory/llm-extractor.ts` — LLM 驱动的记忆提取
- `src/memory/json-memory-store.ts` — JSON 文件记忆存储
- `src/memory/diff.ts` — 记忆差异比较
- `src/memory/replay.ts` — 记忆重放
- `src/memory/verifier.ts` — 记忆验证
- `src/memory/resolution.ts` — 记忆冲突解决

当前能力：

- 支持 session 级和 long-term 记忆。
- LLM 自动提取和合并记忆。
- 记忆保存/召回/遗忘工具。
- 记忆差异比较、重放和验证。

## 当前测试状态

已通过：

```bash
npm test            # 68 test files, 421 tests passed, 1 skipped
npm run typecheck   # 通过
npm run build       # 通过
```

## 与 Claude Code 的区别

### Claude Code 是完整产品级 agent 系统

Claude Code 具备：CLI/TUI 交互、文件编辑、bash、MCP、hooks、skills、内置 subagents、自定义 agent 加载、权限系统、后台任务、worktree isolation、remote/fork/coordinator/team agent 能力、transcript、resume、task output 管理。

### evolving-agent 已具备的能力

- runtime loop（含多 turn、超时、上下文压缩、微压缩、上下文裁剪、工具输出截断）。
- model client（OpenAI Responses / Anthropic Messages）。
- model registry + model routing（purpose-based 路由）。
- 完整 CLI（chat / run / benchmark / evolve / models / tui 子命令）。
- TUI 交互界面（19 个文件，含 Markdown 渲染、bash 渲染、交互模式、斜杠命令等）。
- tool registry（workspace/readonly/mutating/bash/subagent/web-fetch/MCP）。
- tool profiles（read-only / coding / benchmark-sandbox / dangerous）。
- tool output truncation（head-tail / head-only，UTF-8 安全）。
- benchmark + JSON/Markdown report export。
- evolution comparison + report export + history store。
- trace replay + run diff。
- verifier。
- session memory 保存/恢复 + JSON session store。
- chat 服务 + session 生命周期管理。
- agent/subagent 定义加载与验证。
- 记忆管理（LLM 提取、保存/召回/遗忘、差异、重放、验证）。
- MCP 集成（STDIO/HTTP，工具命名空间隔离）。
- 默认 CLI 配置。

### 还没有

- OS/container 级工具沙箱。
- hooks、skills。
- background task。
- worktree isolation。
- multi-agent coordinator。
- Slack bot。
- 完整 OAuth/AuthStorage。

### 借鉴了 Claude Code 的部分

- agent spec 思路。
- allowed/denied tools 权限模型。
- verifier 思路。
- subagent 类型预留。
- trace/metadata 便于后续 task resume 和分析。
- purpose-based 模型路由。

## 与 pi 的区别

### pi 是可运行 coding agent 框架

pi 具备：Agent loop、CLI/session/tools/extensions/compaction、Slack bot、统一模型抽象和 provider registry、OpenAI/Anthropic/Google/local provider streaming、JSONL session tree、OAuth/AuthStorage。

### evolving-agent 当前更轻量，但覆盖面更广

我们的模型层是：

```txt
ModelRegistry
  ├── ProviderConfig
  ├── discovered/manual ModelConfig
  ├── ModelRouter (purpose-based)
  └── ModelClient
      ├── OpenAIModelClient
      └── AnthropicModelClient
```

### 借鉴了 pi 的部分

- runtime / loop / session 分层。
- model client 抽象。
- provider adapter 思路。
- OpenAI Responses API 接法。
- Anthropic Messages API 接法。
- 轻量 provider/model registry 思路。
- JSONL store 思路。
- event/trace 驱动。

### 没有照搬的

- pi 的完整 `ModelRegistry` 元数据：cost、contextWindow、maxTokens。
- pi 的 `streamSimple` streaming 抽象。
- pi 的 OAuth/AuthStorage。
- pi 的 extension system。

## 当前缺失的关键能力

详见 `REQUIREMENTS.md` 第 6 节完整的优先级路线图。核心依赖链：

```
Evolution 质量 = Benchmark 覆盖度 × Grader 质量 × Verification 门禁
```

按优先级排序：

1. **更强的 Grader（P0）**：当前仅 exact/rubric string match，缺 LLM judge、command、artifact 评分。
2. **覆盖实际场景的 Benchmark Suite（P1）**：当前仅 1 个 smoke task，缺 coding/tool-use/memory/long-context/error-recovery 场景。
3. **自动进化闭环（P2）**：engine 可对比但缺自动迭代、LLM candidate generation、promotion/rollback。
4. **Subagent 优化（P3）**：并行执行、trigger 路由、角色编排、TUI 树展示。
5. **SOP / 可复用工作流（P4）**：一等 SOP schema、注册引擎、常用 SOP 内置。
6. **TUI Markdown 增强（P5）**：加粗/斜体、链接、表格、代码高亮。

## 建议下一阶段

当前阶段已完成的 MVP 能力：

- Agent runtime（loop/session/events/compaction/budget/timeout）。
- 完整工具系统（workspace/bash/subagent/web-fetch/MCP + 权限策略 + 工具输出截断）。
- Model client（OpenAI Responses / Anthropic Messages）+ model registry + purpose-based 路由。
- 完整 CLI（chat/run/benchmark/evolve/models/tui）。
- TUI 交互系统（19 文件，基础 markdown 渲染）。
- Benchmark + Evolution comparison + Verification + History store。
- 记忆管理（LLM 提取、CRUD、差异、重放、验证、冲突解决）。
- 持久化（JSONL run store、session store）。
- Trace replay + run diff。
- 公共 API 导出（index.ts 完整）。

下一阶段的核心方向：**从「可运行 Agent」到「可自我改进的 Agent」**。

首要目标（P0）是实现更强的 Grader，因为它是所有自动化评估和进化决策的基础：没有可靠的评分，benchmark 和 evolution 都缺乏意义。

然后依次推进真实场景 benchmark → 自动进化闭环 → subagent 增强 → SOP 工作流 → TUI 体验优化。
