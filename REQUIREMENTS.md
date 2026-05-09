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

## 6. 下一阶段路线图（按优先级排列）

核心依赖链：**Evolution 质量 = Benchmark 覆盖度 × Grader 质量 × Verification 门禁**

基于此依赖链，优先级如下：

### P0：更强的 Grader（评分器）

当前 `MinimalTaskGrader` 仅支持 exact/rubric 字符串匹配，`llm-judge`、`command`、`custom` 方法已在 schema 中定义但未实现。没有好评分就没有有意义的 benchmark 和 evolution。

目标：

- 实现 LLM-as-judge 评分，支持 rubric 权重和 partial credit。
- 实现 command-based 评分（沙箱执行校验脚本）。
- 实现 artifact/file-based 评分（比对预期产出文件）。
- 支持 grader 从配置加载，CLI 可指定 grader。
- grader 输出结构化评分详情（含 reasoning、criteria breakdown）。
- 评分器自身可被 benchmark 校准（评判一致性）。

### P1：覆盖实际场景的 Benchmark Suite

当前只有 1 个 smoke task。需要覆盖真实 agent 使用场景的 benchmark 套件。

目标：

- coding 场景：读代码、修改代码、跨文件重构。
- tool-use 场景：bash 执行、文件操作、web fetch、subagent 调度。
- memory 场景：信息提取、长对话记忆保持、偏好学习。
- long-context 场景：大文件分析、多文件搜索、上下文压缩后准确性。
- error-recovery 场景：工具失败重试、超时处理、权限拒绝处理。
- 支持 fixture 准备和清理，每个 task 有明确的 scoring config。
- 支持多次运行统计（均值、方差、flaky 检测）。

### P2：自动进化闭环

当前 evolution engine 可对比 baseline/candidate 并给出 accept/reject/needs-review 建议，但缺少自动迭代能力。

目标：

- LLM 驱动的 candidate generator：基于 benchmark 失败分析自动产生改进 candidate。
- 自动迭代循环：generate → benchmark → compare → accept/reject → 下一轮。
- 接受后自动 promotion（更新 baseline agent spec）。
- 拒绝后自动记录并指导下一轮生成（失败反馈回生成器）。
- evolution history 完整追踪每次变更、决策依据、评分 delta。
- CLI 一键进化命令：`evolving-agent evolve --auto --suite <file> --agent <file>`。

### P3：Subagent 优化

当前 subagent 是较成熟模块，可增量增强。

目标：

- 并行 subagent 执行（当前为 sequential）。
- trigger-based 自动 subagent 路由（SubagentSpec.trigger 已定义但未使用）。
- planner/critic/verifier 角色编排语义。
- TUI subagent 树展示。
- subagent 预算分配（token/turn/timeout per subagent）。

### P4：SOP / 可复用工作流

当前没有一等 SOP 系统，可复用行为散落在 agent prompt、CLI 命令、TUI slash 命令、generator JSON 和 examples 中。

目标：

- 一等 SOP schema：定义 workflow 步骤、依赖、参数、验证条件。
- SOP 注册和执行引擎。
- 常用 SOP 内置：代码审查、安全审查、测试生成、文档生成、重构。
- SOP 可被 agent 工具调用，也可被 CLI 直接执行。
- SOP 执行可产生 trace，进入 benchmark 评测。

### P5：TUI Markdown 增强

当前 TUI markdown 仅支持 heading、无序列表、代码块、行内代码的基本渲染。

目标：

- 加粗/斜体、链接、表格、引用块、有序列表。
- 代码块语法高亮（语法感知着色）。
- Markdown 换行和自动折行。
- 增量渲染优化（大块 markdown 性能）。

## 7. 非目标

当前阶段不做：

- 完整 Claude Code clone。
- 完整 pi package 复用。
- Slack bot。
- 完整 MCP（已有基础集成，不做完整 MCP server/host 框架）。
- 完整 skill system（SOP 是更轻量的替代）。
- 产品级 hooks。
- worktree isolation。
- remote agent。
- tmux teammate。
- 完整 OAuth/AuthStorage。
- OS/container 级工具沙箱（当前 benchmark-sandbox 为 workspace/cwd 级约束）。
- 多 agent coordinator 编排。

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
