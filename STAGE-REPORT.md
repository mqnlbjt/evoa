# evolving-agent 阶段性记录

## 当前阶段目标

本阶段目标是把 `evolving-agent` 从“Agent 规格 + Benchmark 骨架”推进到一个可以直接启动、可以对话、可以保存 session、可以评测、可以接入本地 OpenAI/Anthropic 兼容服务的最小 agent runtime。

参考方向：

- 借鉴 Claude Code 的 agent 定义、权限控制、验证思路。
- 借鉴 pi 的清晰 runtime/session/model 分层和 OpenAI/Anthropic provider 思路。
- 保持 `evolving-agent` 自身轻量、独立，优先成为可用的 Agent runtime，再用 benchmark 和 evolution 做验证与改进。

## 已完成内容

### 1. Runtime 基础

新增/实现：

- `src/runtime/agent-runtime.ts`
- `src/runtime/session.ts`
- `src/runtime/loop.ts`
- `src/runtime/events.ts`
- `src/models/types.ts`

当前能力：

- `AgentRuntime` 实现 `AgentRuntimeExecutor`。
- 支持创建 `AgentSession`。
- 支持将 `AgentSpec + TaskSpec` 转成模型请求。
- 支持记录 `model_request`、`model_response`、`tool_call`、`tool_result` trace。
- 支持多 turn loop。
- 支持通过 `ModelClient` 抽象替换不同模型后端。

### 2. 工具系统与权限策略

新增/实现：

- `src/tools/registry.ts`
- `src/tools/policy.ts`
- `src/tools/types.ts`

当前能力：

- `ToolRegistry` 注册和执行工具。
- `ToolDecision` 判断工具是否允许执行。
- 支持 `allow` / `deny` / `ask`。
- `agent.tools.deniedTools` 优先级高于 allowed tools。
- `task.allowedTools` 可以进一步收窄 agent 的工具权限。
- 支持 `maxToolCalls` 限制。
- 支持 runtime hooks：`beforeToolCall` / `afterToolResult`。

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

### 10. 模型发现与轻量 ModelRegistry

新增：

- `src/models/provider-types.ts`
- `src/models/discovery.ts`
- `src/models/registry.ts`
- `test/model-discovery.test.ts`
- `test/model-registry.test.ts`

当前能力：

- `discoverOpenAICompatibleModels` 支持 OpenAI 兼容 `/v1/models` 发现。
- 支持 `http://localhost:8317/v1`、`http://localhost:8317`、`http://localhost:8317/v1/models` 的 URL 规范化，避免重复 `/v1` 或 `/models`。
- 支持 API key、custom headers、custom fetch 和响应校验。
- `ModelRegistry` 支持 provider 注册、模型发现、手动模型注册/覆盖、provider/model 列表、模型查询。
- `ModelRegistry.createClient` 可创建 `openai-responses` 和 `anthropic-messages` 对应的现有 `ModelClient`。
- Anthropic provider 当前支持手动注册和 client 创建，暂不支持自动模型发现。

### 11. 最小 CLI 与示例文件

新增：

- `src/cli.ts`
- `src/cli/args.ts`
- `src/cli/main.ts`
- `src/cli/commands.ts`
- `src/cli/format.ts`
- `src/tasks/loader.ts`
- `src/tasks/validation.ts`
- `src/benchmark/loader.ts`
- `src/benchmark/validation.ts`
- `src/benchmark/grader.ts`
- `examples/agents/basic.json`
- `examples/tasks/smoke.json`
- `examples/suites/smoke.json`
- `examples/providers/local-openai.json`
- `examples/README.md`
- `test/cli-args.test.ts`
- `test/cli-main.test.ts`
- `test/task-loader.test.ts`
- `test/benchmark-loader.test.ts`
- `test/minimal-grader.test.ts`
- `test/examples.test.ts`

当前能力：

- `evolving-agent models discover` 可通过 CLI 发现 OpenAI-compatible provider 的模型。
- `evolving-agent run` 可加载 agent/task JSON，创建模型客户端并运行单个 task。
- `evolving-agent benchmark` 可加载 suite/agent JSON 并运行 benchmark。
- 当前还缺少面向用户的简单 `chat` 入口；用户开始对话仍需要 task JSON，这是下一阶段最高优先级。
- CLI 支持 human/json 输出，`--json` 输出稳定机器可读 JSON。
- CLI 支持 `--output` 和 `--trace` 显式写文件，默认不写。
- 新增 task/suite loader 与 validator。
- 新增 `MinimalTaskGrader`，支持 deterministic `exact` 与 `rubric.contains`。
- 示例文件覆盖 local provider、basic agent、smoke task 和 smoke suite。

### 12. Workspace-scoped coding tools 与 tool profiles

新增：

- `src/tools/workspace.ts`
- `src/tools/read-only.ts`
- `src/tools/mutating.ts`
- `src/tools/profiles.ts`
- `test/read-only-tools.test.ts`
- `test/mutating-tools.test.ts`

当前能力：

- read-only profile 内置 `read_file`、`list_dir`、`find_files`、`grep`。
- coding profile 额外启用 `write_file`、`edit_file`。
- benchmark-sandbox / dangerous profile 额外启用 `bash`。
- CLI 新增 `--tool-profile <read-only|coding|benchmark-sandbox|dangerous>`，默认是 `dangerous`，让默认 agent 具备全部内置工具能力。
- 文件工具限制在 workspace root 内，拒绝路径逃逸和 symlink 写入。
- `edit_file` 使用 exact replacement，支持 all-or-nothing 多编辑与 `replaceAll`。
- `bash` 支持 workspace cwd 校验、超时、输出上限和非零退出码结构化返回。
- `benchmark-sandbox` 当前是 workspace/cwd 级约束，不是 OS/container 级沙箱。

### 13. Benchmark report export

新增：

- `src/benchmark/report.ts`
- `test/benchmark-report.test.ts`

当前能力：

- `createBenchmarkReport()` 可以从 `SuiteRunResult` 生成稳定 JSON DTO。
- `formatBenchmarkReportMarkdown()` 可以生成适合人工阅读/PR 评论的 Markdown report。
- CLI `benchmark` 新增 `--report <file>` 和 `--report-format <json|markdown>`。
- `.md` / `.markdown` report path 会默认推断为 Markdown，其余默认 JSON。
- `--output` 仍保持 compact JSON 输出语义，`--trace` 仍保持完整 run result 语义。

## 当前测试状态

已通过：

```bash
npm test
npm run typecheck
npm run build
```

当前测试数量：

```txt
25 test files
127 tests passed
```

## 与 Claude Code 的区别

### Claude Code 是完整产品级 agent 系统

Claude Code 具备：

- CLI/TUI 交互。
- 文件编辑、bash、MCP、hooks、skills。
- 内置 subagents：Explore、Plan、general-purpose、verification 等。
- 自定义 agent 加载：`.claude/agents/*.md`、settings、plugin、policy。
- 权限系统。
- 后台任务。
- worktree isolation。
- remote/fork/coordinator/team agent 能力。
- transcript、resume、task output 管理。

### evolving-agent 当前不是 Claude Code 替代品

当前 `evolving-agent` 只有核心框架能力，还不是顺手可用的对话型 Agent 产品：

- runtime loop。
- model client。
- model registry。
- 最小 CLI。
- tool registry。
- workspace-scoped read/write/edit/bash tools。
- tool profiles。
- benchmark。
- benchmark JSON/Markdown report export。
- evolution comparison。
- evolution JSON/Markdown report export。
- evolution history store。
- trace replay summary / warnings。
- run diff。
- verifier。
- chat CLI / REPL。
- session memory 保存/恢复。
- session startup context resume。
- 默认 CLI 配置。

还没有：

- TUI。
- OS/container 级工具沙箱。
- MCP。
- hooks。
- skills。
- background task。
- worktree isolation。
- multi-agent coordinator。

### 我们借鉴了 Claude Code 的部分

已吸收：

- agent spec 思路。
- allowed/denied tools 权限模型。
- verifier 思路。
- subagent 类型预留。
- trace/metadata 便于后续 task resume 和分析。

没有直接照搬：

- Claude Code 的完整 task lifecycle。
- tmux/in-process teammate。
- settings/plugin/policy 层级。
- MCP/hook/skill 复杂机制。

## 与 pi 的区别

### pi 是可运行 coding agent 框架

pi 具备：

- `pi-agent-core`：Agent loop、state、event、tool execution。
- `pi-coding-agent`：CLI/session/tools/extensions/compaction。
- `pi-mom`：Slack bot 外壳。
- `pi-ai`：统一模型抽象和 provider registry。
- `ModelRegistry`：内置模型、models.json、自定义 provider、auth、headers、OAuth。
- OpenAI/Anthropic/Google/local provider streaming。
- JSONL session tree。

### evolving-agent 当前更轻量

我们当前没有复用 pi 包，也没有引入 pi 的完整模型系统。

我们的模型层是：

```txt
ModelRegistry
  ├── ProviderConfig
  ├── discovered/manual ModelConfig
  └── ModelClient
      ├── OpenAIModelClient
      └── AnthropicModelClient
```

pi 的模型层更像：

```txt
ModelRegistry
  ├── built-in models
  ├── models.json
  ├── provider config
  ├── auth storage
  ├── OAuth
  └── streamSimple provider abstraction
```

### 我们借鉴了 pi 的部分

已吸收：

- runtime / loop / session 分层。
- model client 抽象。
- provider adapter 思路。
- OpenAI Responses API 接法。
- Anthropic Messages API 接法。
- 轻量 provider/model registry 思路。
- JSONL store 思路。
- event/trace 驱动。

没有直接照搬：

- pi 的完整 `ModelRegistry`。
- pi 的 `streamSimple`。
- pi 的完整 `Model` 元数据：cost、contextWindow、maxTokens、input types。
- pi 的 OAuth/AuthStorage。
- pi 的 extension system。
- pi 的 session tree 和 compaction。

## 当前我们比 pi/Claude Code 少的关键能力

优先级较高：

1. ~~基础 coding tools：read、write、bash、edit。~~ 已完成 workspace-scoped 实现。
2. ~~tool call 协议：让 OpenAI/Anthropic client 可以解析模型返回的工具调用。~~ 已完成。

优先级中等：

1. ~~JSONL trace replay。~~ 已完成事件级 replay summary / warnings。
2. ~~benchmark report 导出。~~ 已完成。
3. ~~run diff。~~ 已完成 task/suite diff。
4. verification artifact。
5. subagent 手动调用。
6. candidate generator 示例。

优先级较低：

1. MCP。
2. hooks。
3. skills。
4. worktree isolation。
5. background task。
6. TUI。
7. Slack bot。

## 建议下一阶段

建议下一阶段先实现 Agent 可用性闭环，再继续扩展 benchmark/evolution 能力。

已完成：

- evolution comparison 可以导出稳定 JSON/Markdown report。
- evolution comparison 可以保存历史记录并导出决策依据。
- trace replay 可以基于已有 trace 生成事件级 summary / warnings。
- run diff 可以比较 task/suite run 的状态、分数、耗时和事件差异。
- deterministic candidate generator 可以产生可复现 candidate。
- manual subagent tool 可以显式调用子 agent。
- `chat` CLI 可以直接启动一次对话。
- 交互式 chat 支持连续输入。
- session memory 可以保存/恢复 `AgentSession.messages`，支持 `--session` / `--resume`。
- session startup context 可以保存并恢复 agent/provider/model/baseURL/toolProfile，减少 resume 参数。
- 默认 CLI 配置可以减少启动 agent 时必须传的参数数量。
- benchmark 已覆盖 runtime error、timeout、abort、tool profile、task-level narrowing、CLI 失败退出码、trace/report 输出和 subagent trace 链路，避免 chat/session/tool 关键路径回归。

下一目标：

- 扩展 verification artifact，结构化保存失败原因、policy event、tool result 截断信息。

这样可以把当前“可分析、可重放、可持续演化的 benchmark 闭环”调整为“可用 Agent → 可验证 Agent → 可演化 Agent”的主线。
