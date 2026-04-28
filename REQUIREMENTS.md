# evolving-agent 需求文档

## 1. 定位

`evolving-agent` 是一个轻量、独立、可评测、可验证、可持续演化的通用 Agent runtime。

它不是 Claude Code 的复刻，也不是 pi 的封装；它只吸收两者适合本项目的工程经验，用最小复杂度先完成可用 Agent，再用 benchmark / verification / evolution 持续验证和改进 Agent。

```txt
agent runtime → chat/session usage → benchmark verification → evolution
```

当前实现进展见 `STAGE-REPORT.md`；项目边界、目录职责和工作方式见根目录 `CLAUDE.md`。

## 2. 核心目标

1. 能用最简单的 CLI 启动 agent 并完成一次对话。
2. 能支持连续对话 session，并保存/恢复 session messages。
3. 能定义 agent、加载 agent、运行 agent，而不是要求用户先写 benchmark。
4. 能记录、重放和解释 agent 行为。
5. 能用 benchmark 评测 agent 能力，但 benchmark 不是主要使用入口。
6. 能验证 regression、error、timeout、denied tool-policy event。
7. 能比较 baseline agent 与 candidate agent，并输出 `accept`、`reject` 或 `needs-review`。
8. 能逐步形成可复现的 self-evolution 流程。

## 3. 设计原则

- **Agent-first**：优先让用户能直接启动、对话、恢复和使用 agent。
- **Benchmark-backed**：新增能力应能被 benchmark 评测，但 benchmark 是验证手段，不是主要使用入口。
- **Session-first**：对话历史、tool result 和 trace 必须围绕可恢复 session 组织。
- **Trace-first**：运行过程必须能被 trace 解释。
- **Verification-first**：错误、回归和权限违规必须能阻止错误 candidate 被接受。
- **Policy-first**：所有工具调用必须经过权限策略。
- **Local-first**：优先支持本地 OpenAI/Anthropic 兼容服务。
- **Lightweight**：不引入 Claude Code/pi 的完整产品复杂度。
- **Composable**：runtime、model、tool、benchmark、verification、evolution 可独立演进。

## 4. 目标架构

```txt
AgentSpec / TaskSpec / BenchmarkSuite
        |
        v
AgentRuntime ---- AgentSession ---- RuntimeEvent Trace
        |
        +---- ModelClient / ModelRegistry
        +---- ToolRegistry / ToolPolicy / ToolProfile
        +---- RunStore / JsonlRunStore
        +---- BenchmarkRunner / BenchmarkReport
        +---- Verifier / VerificationReport
        +---- EvolutionEngine / EvolutionHistory
```

## 5. 必须长期保持的能力

### Agent CLI / Session

- 支持 `chat` 命令，用一句话启动 agent：`evolving-agent chat "你好"`。
- 支持交互式连续对话：`evolving-agent chat`。
- 支持 `--session <id>` 保存 session。
- 支持 `--resume <id>` 恢复 session messages。
- 用户不应为了开始对话而手写 task JSON。

### Runtime

- 执行 `AgentSpec + TaskSpec`，并逐步支持更直接的 `AgentSpec + user message`。
- 支持多 turn loop。
- 支持模型请求、模型响应、tool call、tool result 的统一 trace。
- runtime 主流程不绑定具体模型厂商。

### Model

- 支持 OpenAI Responses API 格式。
- 支持 Anthropic Messages API 格式。
- 支持本地 OpenAI/Anthropic 兼容 endpoint。
- provider-specific 格式不得泄漏到 runtime 主流程。

### Tool

- 支持 `allow` / `deny` / `ask`。
- 支持 agent-level allowed/denied tools。
- 支持 task-level tool narrowing。
- 支持 tool profile。
- 文件与 bash 工具必须受 workspace/cwd、timeout、输出上限和 trace 约束。

### Benchmark

- 支持 suite/task 运行。
- 支持 score、pass/fail、timeout、trace、report。
- benchmark 输出必须可用于 evolution 和 verification。

### Verification

- 必须检查 regression、error、timeout、denied tool-policy event。
- policy violation 不允许自动 accept。
- verification 结果必须能进入 report。

### Evolution

- 支持 baseline/candidate 对比。
- 支持 score/pass-rate delta、regressions、improvements。
- 支持 `accept` / `reject` / `needs-review`。
- evolution history 必须能追踪每次候选变更和决策依据。

## 6. 当前近期方向

下一阶段优先完成 Agent 可用性闭环：

1. `chat` CLI：支持 `evolving-agent chat "你好"` 直接开始一次对话。
2. 交互式 chat：支持不带 prompt 启动连续对话。
3. session store：保存/恢复 `AgentSession.messages`，让 agent 有真正的 session memory。
4. 默认 agent/provider 配置：减少每次都要传 `--agent --provider --model --base-url` 的负担。
5. 再用 benchmark 验证 chat/session/tool 行为，避免 regression。

已具备或次优先推进：

- candidate generator 示例：产生可复现 candidate。
- manual subagent tool：允许主 agent 显式调用子 agent。
- subagent trace：让 benchmark、replay、report 能分析 subagent 行为。
- verification artifact：结构化保存失败原因、policy event、tool result 截断信息。

## 7. 非目标

短期不做：

- 完整 Claude Code clone。
- 完整 pi package 复用。
- 完整 TUI。
- Slack bot。
- 完整 MCP。
- 完整 skill system。
- 产品级 hooks。
- worktree isolation。
- remote agent。
- tmux teammate。
- 完整 OAuth/AuthStorage。

这些能力只能作为长期扩展，不能阻塞核心闭环。

## 8. 成功标准

项目合格标准不是“像 Claude Code 一样完整写项目”，而是：

1. 用户能用一条简单命令启动 agent 对话。
2. agent 能保持并恢复 session memory。
3. agent 能稳定调用受权限约束的工具。
4. 能稳定评测 agent，但 benchmark 不替代 chat/session 使用入口。
5. 能记录、解释和重放 agent 行为。
6. 能验证失败、回归和权限违规。
7. 能比较 agent 版本。
8. 能基于 benchmark 结果推动 agent 进化。
