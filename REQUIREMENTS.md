# evolving-agent 需求文档

## 1. 愿景

`evolving-agent` 的目标是成为一个自带 benchmark、自带验证、自带自进化能力的通用 Agent 框架。

它不是 Claude Code 的复刻，也不是 pi 的封装，而是吸收两者最有价值的工程经验后，形成一个更轻量、更独立、更适合实验、评测和持续演化的 agent runtime。

一句话目标：

> 用 benchmark 驱动能力验证，用 evolution 驱动持续改进，用轻量 runtime 承载通用 agent 能力。

## 2. 当前实现基线

当前项目已经不是纯规格或骨架，而是具备了最小可运行 agent 框架的基础能力。

### 2.1 已实现能力

#### Runtime

已实现：

- `src/runtime/agent-runtime.ts`
- `src/runtime/session.ts`
- `src/runtime/loop.ts`
- `src/runtime/events.ts`
- `src/models/types.ts`

当前能力：

- `AgentRuntime` 可执行 `AgentSpec + TaskSpec`。
- 支持创建 `AgentSession`。
- 支持多 turn loop。
- 支持通过 `ModelClient` 替换模型后端。
- 支持记录 `model_request`、`model_response`、`tool_call`、`tool_result` trace。

#### Tool System

已实现：

- `src/tools/registry.ts`
- `src/tools/policy.ts`
- `src/tools/types.ts`
- `src/tools/workspace.ts`
- `src/tools/read-only.ts`
- `src/tools/mutating.ts`
- `src/tools/profiles.ts`

当前能力：

- `ToolRegistry` 注册和执行工具。
- 支持 `allow` / `deny` / `ask`，其中 `ask` 在非交互 benchmark 模式下明确按 deny 处理。
- `agent.tools.deniedTools` 优先级高于 allowed tools。
- `task.allowedTools` 可以进一步收窄 agent 权限。
- 支持 `maxToolCalls`，超过限制会返回结构化 `limit_exceeded` tool result。
- 支持 runtime hooks：`beforeToolCall` / `afterToolResult`。
- hooks 可以 deny、mutate tool input、mutate tool result。
- `ToolResult` 支持 `success` / `error` / `denied` / `unknown` / `limit_exceeded` / `timeout` 状态。
- 支持 tool result 安全序列化和大小截断。
- 支持 tool-level timeout 和 abort signal。
- 支持 `parallel-safe` 工具并发执行，同时保持模型可见 tool result 顺序稳定。
- 已内置 read-only tools：`read_file`、`list_dir`、`find_files`、`grep`。
- 已内置 workspace-scoped mutating tools：`write_file`、`edit_file`、`bash`。
- 已支持工具 profile：`read-only`、`coding`、`benchmark-sandbox`、`dangerous`。
- CLI 默认仍是 `read-only`，mutating tools 需要通过 `--tool-profile` 显式启用。
- `benchmark-sandbox` 当前是 workspace/cwd 级约束，不是 OS/container 级安全沙箱。

#### Benchmark

已实现：

- `src/benchmark/runner.ts`
- `src/benchmark/leaderboard.ts`
- `src/benchmark/types.ts`

当前能力：

- `BenchmarkRunner` 可以运行 suite。
- 支持 task run trace、score、summary。
- 支持 leaderboard。
- 支持 run store 持久化。

#### Evolution

已实现：

- `src/evolution/engine.ts`
- `src/evolution/types.ts`

当前能力：

- `BenchmarkEvolutionEngine` 可以比较 baseline agent 与 candidate agent。
- 可以计算 `deltaScore`、`deltaPassRate`、regressions、improvements。
- 可以输出 recommendation：`accept` / `reject` / `needs-review`。

#### Verification

已实现：

- `src/verification/verifier.ts`

当前能力：

- deterministic verifier。
- 能检查 regression、error、timeout、denied tool-policy event。
- 输出 `VerificationReport`。

#### Persistence

已实现：

- `src/sessions/run-store.ts`
- `src/sessions/jsonl-store.ts`

当前能力：

- `MemoryRunStore` 保存内存结果。
- `JsonlRunStore` 以 JSONL 保存 task run 和 suite run。

#### Agent Definition Loader

已实现：

- `src/agents/loader.ts`
- `src/agents/validation.ts`

当前能力：

- 支持从 JSON object/file 加载 `AgentSpec`。
- 支持 bundle 格式：`agents` + `subagents`。
- 支持 duplicate agent id 后者覆盖前者。
- 支持基础 schema/runtime/tool policy 校验。
- 已有 `SubagentSpec` 类型，但暂未自动调度 subagent。

#### Model Clients

已实现：

- `src/models/openai-client.ts`
- `src/models/anthropic-client.ts`

当前能力：

- `OpenAIModelClient` 实现 OpenAI Responses API 格式。
- `AnthropicModelClient` 实现 Anthropic Messages API 格式。
- 支持 `baseURL`、`apiKey`、custom headers、custom fetch。
- 已通过本地 OpenAI/Anthropic 兼容服务测试。

### 2.2 当前主要缺口

高优先级缺口：

1. ~~没有 `/v1/models` 模型发现。~~ 已完成。
2. ~~没有轻量 `ModelRegistry`。~~ 已完成。
3. ~~没有 CLI。~~ 已完成最小 CLI。
4. ~~没有 example agents / suites / local provider config。~~ 已完成基础 examples。
5. ~~没有 OpenAI / Anthropic tool call 解析。~~ 已完成。
6. ~~没有内置 coding tools。~~ 已完成 read-only 与 workspace-scoped mutating tools。
7. benchmark report 导出已完成；evolution report 导出待做。

中优先级缺口：

1. 没有 streaming model abstraction。
2. 没有 trace replay。
3. 没有 artifact directory。
4. 没有 evolution history store。
5. 没有 manual subagent execution。
6. 没有 candidate generator 示例。

低优先级缺口：

1. MCP。
2. skills。
3. hooks product layer。
4. worktree isolation。
5. background task。
6. TUI。
7. remote agent。

## 3. 产品定位

`evolving-agent` 面向 agent builder、benchmark 作者、模型实验者和 evolution 研究者。

它优先解决三个问题：

1. 如何定义并运行一个 agent。
2. 如何稳定评测一个 agent。
3. 如何基于评测结果自动改进 agent。

它不是优先做交互式 IDE coding assistant，而是先做可评测、可重放、可进化的 agent core。

## 4. 借鉴对象与吸收策略

## 4.1 从 Claude Code 吸收什么

Claude Code 的优势是产品级 agent 工程完整度高，尤其适合借鉴任务执行、权限、验证和多 agent 工作流。

需要吸收：

- agent spec / subagent spec。
- permission-first tool policy。
- allowed / denied tools。
- task-level permission narrowing。
- Explore / Plan / Execute / Verify agent 分工。
- trace / transcript / task output 管理。
- verification 作为工作流阶段，而不是单纯分数。
- background / resume / worktree / coordinator 的架构经验。

暂不照搬：

- 完整 Claude Code CLI/TUI。
- settings/plugin/policy 多层产品配置。
- tmux teammate / swarm 产品形态。
- 完整 MCP / hook / skill 生态。
- remote agent 产品能力。

### Claude Code 对本项目的要求转化

本项目应形成四类 benchmarkable agent mode：

1. `explore`：只读搜索和代码理解。
2. `plan`：产出计划，不修改文件。
3. `execute`：执行工具和完成任务。
4. `verify`：验证输出、trace、artifact 和 regression。

本项目应形成四类 policy profile：

1. `read-only`：只能读文件、搜索、列目录。
2. `coding`：允许读写编辑，但 bash 需要显式授权。
3. `benchmark-sandbox`：所有变更限制在 benchmark workspace 内。
4. `dangerous`：显式 opt-in，允许更宽的 bash/write 能力。

## 4.2 从 pi 吸收什么

pi 的优势是 runtime/session/model 分层清晰，模型 provider 和 coding tools 工程化程度高。

需要吸收：

- runtime / loop / session / event 分层。
- provider abstraction。
- model registry。
- local OpenAI-compatible discovery。
- streaming event loop。
- JSONL session/run store。
- cwd-scoped coding tools。
- read-only tools 与 mutating tools 分层。
- extension lifecycle 的轻量化思想。

暂不照搬：

- pi monorepo 结构。
- 完整 OAuth/AuthStorage。
- 完整 extension system。
- Slack bot / web-ui / mom 产品层。
- 复杂 provider 元数据体系。

### pi 对本项目的要求转化

本项目应把模型系统拆成两层：

1. `ModelClient`：负责具体 provider 请求和响应解析。
2. `ModelRegistry`：负责 provider config、模型发现、手写模型、client factory。

本项目应把工具系统拆成两类：

1. read-only tools：`read_file`、`grep`、`find_files`、`list_dir`。
2. mutating tools：`write_file`、`edit_file`、`bash`。

本项目应逐步引入事件流：

- `agent_start`
- `turn_start`
- `message_start`
- `message_delta`
- `message_end`
- `tool_call`
- `tool_result`
- `turn_end`
- `agent_end`
- `error`

## 5. 核心设计原则

1. Benchmark-first：任何 agent 能力都应能被 benchmark 评测。
2. Trace-first：任何运行结果都应能被 trace 解释。
3. Evolution-first：任何 agent 改动都应能与 baseline 比较。
4. Policy-first：任何工具调用都必须经过权限判断。
5. Local-first：优先支持本地 OpenAI/Anthropic 兼容服务。
6. Lightweight：不引入 Claude Code/pi 的完整产品复杂度。
7. Composable：runtime、model、tool、benchmark、evolution 可以独立演进。
8. Practice-informed planning：每一次进入 plan 阶段时，都必须主动探索并参考 pi 与 Claude Code 的优秀实践，再把相关取舍写入计划。

### 5.1 Plan 阶段要求

每次规划新功能或较大改动时，plan 必须包含以下步骤：

1. 探索当前 `evolving-agent` 代码和需求上下文，确认已有能力与缺口。
2. 探索 pi 中相关模块的优秀实践，尤其关注 runtime/session/model/provider/tool/CLI/benchmark 的工程实现。
3. 探索 Claude Code 的相关优秀实践，尤其关注 agent workflow、权限、安全边界、配置、CLI UX、verification 和可自动化运行方式。
4. 在计划中明确写出：
   - 借鉴了 pi 的哪些实践。
   - 借鉴了 Claude Code 的哪些实践。
   - 哪些实践本阶段不照搬，以及不照搬的原因。
   - 本阶段的最小实现范围与明确延期内容。
5. 如果 pi 或 Claude Code 的实践与本项目 lightweight / benchmark-first 目标冲突，必须优先保持 `evolving-agent` 轻量、独立、可评测。

## 6. 目标架构

```txt
AgentSpec / TaskSpec / BenchmarkSuite
        |
        v
AgentRuntime ---- AgentSession ---- RuntimeEvent Trace
        |
        +---- ModelClient <---- ModelRegistry <---- ProviderConfig / Discovery
        |
        +---- ToolRegistry <---- ToolPolicy <---- PolicyProfile
        |
        +---- RunStore / JsonlRunStore
        |
        +---- BenchmarkRunner ---- VerificationReport
        |
        +---- EvolutionEngine ---- EvolutionHistory
```

## 7. 功能需求

### 7.1 Agent Runtime

必须支持：

- 执行 `AgentSpec + TaskSpec`。
- 多 turn loop。
- 模型请求构造。
- 模型响应解析。
- tool call 执行。
- tool result 回传。
- runtime hooks。
- event trace。

下一步增强：

- 增加标准 lifecycle events。
- 增加 streaming response 支持。
- 增加 run interruption / cancellation 基础能力。
- 增加运行上下文统计：turn count、token usage、tool count、duration。

验收标准：

- 一个 agent 能完成普通文本任务。
- 一个 agent 能完成工具调用任务。
- 每个 turn 都有 trace。
- runtime 不绑定具体模型厂商。

### 7.2 ModelClient

必须支持：

- OpenAI Responses API。
- Anthropic Messages API。
- OpenAI-compatible local endpoint。
- Anthropic-compatible local endpoint。
- 自定义 `baseURL`。
- 自定义 `apiKey`。
- 自定义 headers。
- 自定义 fetch。
- temperature。
- max tokens。
- reasoning 参数。

下一步增强：

- tool call 解析。
- tool result formatting。
- malformed response event。
- optional streaming API。

验收标准：

- OpenAI client 支持普通文本响应和 tool call 响应。
- Anthropic client 支持普通文本响应和 `tool_use` 响应。
- provider-specific 格式不会泄漏到 runtime 主流程。

### 7.3 ModelRegistry

状态：已完成基础实现。

必须新增轻量 `ModelRegistry`。

核心 API：

```ts
type ProviderFormat = "openai-responses" | "anthropic-messages";

interface ProviderConfig {
  id: string;
  baseURL: string;
  apiKey?: string;
  format: ProviderFormat;
  headers?: Record<string, string>;
}

interface ModelConfig {
  id: string;
  providerId: string;
  format: ProviderFormat;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputTypes?: string[];
  metadata?: Record<string, unknown>;
}
```

必须支持：

- `registerProvider(providerConfig)`
- `discover(providerId)`
- `registerModel(providerId, modelConfig)`
- `listProviders()`
- `listModels(providerId?)`
- `getModel(providerId, modelId)`
- `createClient(providerId, modelId)`

模型发现函数：

```ts
const models = await discoverOpenAICompatibleModels({
  baseURL: "http://localhost:8317/v1",
  apiKey: "12345678",
});
```

返回示例：

```ts
[
  {
    id: "gpt-5.4-mini",
    providerId: "local",
    format: "openai-responses",
    baseURL: "http://localhost:8317/v1"
  }
]
```

验收标准：

- 能请求 OpenAI-compatible `/v1/models`。
- `baseURL` 已包含 `/v1` 时不能重复拼接。
- 能把 discovered models 注册到 registry。
- 能通过 registry 创建 OpenAI/Anthropic client。
- 支持 manual model 覆盖 discovered model。

### 7.4 Tool System

状态：已完成基础 tool registry、policy、read-only tools 和工具执行链增强；mutating tools 与 policy profile 仍待实现。

当前已有基础 tool registry 和 policy，下一步要补齐 mutating tools 与更完整 policy profile。

必须支持：

- tool schema。
- tool execution。
- tool result。
- tool error。
- `allow` / `deny` / `ask`。
- agent-level allowed tools。
- agent-level denied tools。
- task-level allowed tools。
- `maxToolCalls`。
- hooks。
- policy profile。

内置 read-only tools：

- `read_file`
- `grep`
- `find_files`
- `list_dir`

内置 mutating tools：

- `write_file`
- `edit_file`
- `bash`

安全要求：

- 所有文件工具必须 cwd-scoped。
- mutating tools 默认只能写入 task workspace。
- bash 必须有 timeout。
- bash 必须有 max output bytes。
- bash 调用必须记录完整 policy decision。
- denied tool 必须进入 trace。

验收标准：

- read-only profile 只能调用读工具。
- coding profile 可以调用编辑工具，但 bash 需要显式授权。
- benchmark-sandbox profile 不允许修改 workspace 外路径。
- 超过 `maxToolCalls` 会停止并记录原因。

### 7.5 Tool Call Protocol

状态：已完成 OpenAI Responses / Anthropic Messages tool call 解析、provider-neutral history 和 tool result roundtrip。

这是 coding tools 之前的关键前置能力。

必须支持：

- OpenAI Responses tool call 解析。
- Anthropic Messages `tool_use` 解析。
- provider-specific tool result formatting。
- 多 tool call。
- tool call error。
- malformed tool call trace event。

验收标准：

- OpenAI-compatible 本地服务可触发工具调用。
- Anthropic-compatible 本地服务可触发工具调用。
- runtime 不需要知道 provider 原始响应结构。
- benchmark 可以断言 tool call 是否发生、参数是否正确、结果是否正确。

### 7.6 Benchmark

当前 benchmark runner 已可运行 suite。下一步要让 benchmark 成为项目核心入口。

必须支持：

- benchmark suite。
- benchmark task。
- runner。
- scoring。
- pass / fail。
- timeout。
- trace。
- leaderboard。
- report export。

Benchmark task 示例：

```ts
{
  id: string;
  input: string;
  expected?: unknown;
  scoring: ScoringConfig;
  allowedTools?: string[];
  timeoutMs?: number;
  workspace?: string;
}
```

下一步增强：

- JSON report。
- Markdown report。
- artifact directory。
- trace file references。
- benchmark fixtures。

验收标准：

- 可以运行一个 suite。
- 可以输出总分、pass rate、error count、timeout count。
- 可以导出 JSON report。
- report 中包含 trace 路径和 verification 结果。

### 7.7 Verification

当前已有 deterministic verifier。下一步要把 verification 升级为 benchmark/evolution gate。

必须支持：

- regression check。
- error check。
- timeout check。
- denied tool-policy event check。
- verification report。

下一步增强：

- artifact verifier。
- trace-policy verifier。
- snapshot verifier。
- optional LLM-as-judge verifier。
- coding task verifier。

验收标准：

- candidate 出现 regression 时 evolution 不应直接 accept。
- policy violation 必须阻止 accept。
- timeout/error 必须进入 report。
- verification report 可被 CLI 输出。

### 7.8 Evolution Engine

当前 evolution comparison 已存在。下一步要补齐可持续演化闭环。

必须支持：

- baseline agent。
- candidate agent。
- benchmark suite。
- 对比运行。
- delta score。
- delta pass rate。
- regressions。
- improvements。
- recommendation。

下一步增强：

- evolution history store。
- candidate generator 示例。
- prompt mutation。
- tool policy mutation。
- model option mutation。
- accepted candidates registry。
- rollback metadata。

初期 candidate generator 不需要 LLM 自动生成，先支持确定性 mutation：

- system prompt append。
- system prompt replace。
- allowed tools 增减。
- model config 替换。
- temperature / reasoning 参数变化。

验收标准：

- 每次 evolution 都保存 baseline spec、candidate spec、suite id、run ids、score delta、recommendation、timestamp。
- candidate 分数提升且无 regression 时可 accept。
- candidate 有严重 regression 或 policy violation 时 reject。
- 边界情况输出 needs-review。

### 7.9 Agent Definition Loader

当前 JSON loader 已存在。下一步要让示例和 CLI 直接使用 loader。

必须支持：

- JSON object。
- JSON file。
- bundle：`agents` + `subagents`。
- validation。
- duplicate id override。

下一步增强：

- YAML。
- directory loading。
- agent inheritance。
- candidate patch。
- role presets：`explore` / `plan` / `execute` / `verify`。

验收标准：

- CLI 可以直接加载 agent file。
- CLI 可以加载 agent bundle。
- 非法 spec 报错明确。
- subagent spec 可被保留并用于后续 manual subagent。

### 7.10 CLI

状态：已完成最小 CLI：`models discover`、`run`、`benchmark`；`evolve` 与 report 能力待扩展。

CLI 是当前框架走向可用的关键入口。

必须支持：

```bash
evolving-agent models discover
evolving-agent run
evolving-agent benchmark
evolving-agent evolve
```

核心参数：

- `--agent`
- `--suite`
- `--task`
- `--provider`
- `--model`
- `--base-url`
- `--api-key`
- `--format`
- `--output`
- `--trace`
- `--json`

验收标准：

- 用户不写代码也能运行 agent。
- 用户不写代码也能运行 benchmark。
- 用户可以指定本地模型 endpoint。
- 用户可以导出 JSON report。
- CLI examples 能在 README 或 examples 中直接复现。

### 7.11 Examples

必须新增 examples，让框架能力可见。

建议结构：

```txt
examples/
  agents/
    basic.json
    tool-user.json
    coding-readonly.json
  suites/
    smoke.json
    tool-use.json
    coding-readonly.json
  providers/
    local-openai.json
  outputs/
    .gitkeep
```

验收标准：

- `basic.json` 能完成无工具任务。
- `tool-user.json` 能触发工具调用。
- `smoke.json` 可用于 CI 快速测试。
- local provider 示例适配 `http://localhost:8317/v1`。

### 7.12 Persistence / Trace / Replay

当前已有 JSONL run store。下一步要稳定 trace 和 replay。

必须支持：

- task run JSONL。
- suite run JSONL。
- trace events。
- report references。

下一步增强：

- trace replay。
- run diff。
- artifact directory。
- evolution history JSONL。

验收标准：

- benchmark run 可落盘。
- evolution run 可落盘。
- report 可以引用 trace 文件。
- replay 可以重建关键运行过程。

### 7.13 Subagent

当前只需要轻量 manual subagent，不做复杂 coordinator。

必须支持：

- `SubagentSpec`。
- bundle 中定义 subagent。
- 主 agent 通过工具显式调用 subagent。
- subagent 有独立 trace。
- subagent result 返回主 agent。

后续扩展：

- Explore agent。
- Plan agent。
- Verify agent。
- parallel subagent。
- coordinator。

验收标准：

- 一个 agent 可以调用一个 subagent 完成子任务。
- subagent 权限可独立配置。
- subagent trace 可在 report 中查看。

## 8. 非目标

当前阶段不做：

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

这些能力可以作为长期扩展，但不能阻塞核心闭环：runtime → benchmark → verification → evolution。

## 9. 阶段路线图

### 阶段 1：最小 Agent Runtime

状态：已完成基线。

包含：

- runtime。
- session。
- loop。
- model client abstraction。
- tool registry。
- tool policy。
- trace。
- benchmark runner。
- evolution comparison。
- verifier。
- JSONL store。
- agent loader。
- OpenAI / Anthropic text client。

完成标准：

- `npm test` 通过。
- `npm run typecheck` 通过。
- `npm run build` 通过。

### 阶段 2：模型发现 + 轻量 ModelRegistry

状态：已完成。

包含：

- `discoverOpenAICompatibleModels`。
- `ModelRegistry`。
- provider config。
- discovered models。
- manual models。
- `createClient(providerId, modelId)`。

完成标准：

- 能发现 `http://localhost:8317/v1` 的模型。
- 能通过 registry 创建 OpenAI/Anthropic client。
- 测试覆盖本地 OpenAI-compatible endpoint。

### 阶段 3：CLI + Examples

状态：已完成最小 CLI 与基础 examples；`evolve` 命令和 report 能力待后续扩展。

包含：

- CLI skeleton。
- `models discover`。
- `run`。
- `benchmark`。
- `evolve`。
- example agents。
- example suites。
- local provider config。

完成标准：

- 用户可以通过 CLI 跑 smoke benchmark。
- 用户可以指定本地模型。
- CLI 可以输出 JSON。

### 阶段 4：Tool Call Protocol

状态：已完成 provider-neutral tool-call history、OpenAI Responses tool call 解析、Anthropic `tool_use` 解析和 roundtrip 测试。

包含：

- OpenAI Responses tool call parsing。
- Anthropic `tool_use` parsing。
- tool result formatting。
- malformed tool call events。

完成标准：

- 本地 OpenAI-compatible 模型可以调用工具。
- Anthropic-compatible 模型可以调用工具。
- runtime 主流程不依赖 provider 原始结构。

### 阶段 5：Coding Tools

状态：read-only tools 已完成；mutating tools 待实现。

包含：

- `read_file`
- `grep`
- `find_files`
- `list_dir`
- `write_file`
- `edit_file`
- `bash`
- cwd/sandbox enforcement。

完成标准：

- read-only coding benchmark 可运行。
- mutating coding benchmark 可在 sandbox 中运行。
- bash 有 timeout 和 output limit。

### 阶段 6：Report + Evolution History

包含：

- JSON report。
- Markdown report。
- evolution history store。
- accepted candidates registry。
- deterministic candidate generator。

完成标准：

- 每次 benchmark 有 report。
- 每次 evolution 有 history。
- candidate 可被 accept/reject/needs-review。

### 阶段 7：Trace Replay + Manual Subagent

包含：

- trace replay。
- run diff。
- manual subagent tool。
- subagent trace。

完成标准：

- 可以重放关键 trace。
- agent 可以调用 subagent。
- subagent 行为可被 benchmark 评测。

## 10. 成功标准

项目达到以下状态时，可认为成为合格的通用自进化 agent 框架：

1. 用户可以定义 agent。
2. 用户可以定义 benchmark。
3. 用户可以通过 CLI 运行 agent。
4. 用户可以通过 CLI 运行 benchmark。
5. agent 可以调用工具。
6. agent 可以接入本地 OpenAI/Anthropic 兼容模型服务。
7. 每次运行都有 trace。
8. 每次 benchmark 都有 report。
9. verifier 可以阻止错误 candidate 被接受。
10. evolution engine 可以比较 baseline 和 candidate。
11. evolution history 可以追踪每次 agent 改动。
12. 至少有一个 read-only coding agent 示例。
13. 至少有一个 tool-use benchmark 示例。
14. 至少有一个 deterministic self-evolution 示例。

## 11. 当前最高优先级

推荐严格按以下顺序推进：

```txt
Model Discovery
  → ModelRegistry
  → CLI Skeleton
  → Examples
  → Tool Call Protocol
  → Read-only Coding Tools
  → Mutating Coding Tools
  → Report Export
  → Evolution History
  → Candidate Generator
  → Trace Replay
  → Manual Subagent
```

当前第一批任务：

1. ~~实现 `discoverOpenAICompatibleModels`。~~ 已完成。
2. ~~实现 `ModelRegistry`。~~ 已完成。
3. ~~支持 `registry.createClient(providerId, modelId)`。~~ 已完成。
4. ~~增加 `evolving-agent models discover` CLI。~~ 已完成。
5. ~~增加 `examples/providers/local-openai.json`。~~ 已完成。
6. ~~增加 smoke benchmark 示例。~~ 已完成。

当前下一批任务：

1. ~~实现 mutating tools：`write_file`、`edit_file`、`bash`。~~ 已完成。
2. ~~增加 benchmark report 导出。~~ 已完成 JSON / Markdown 当前 run 导出。
3. 增加 evolution report 导出。
4. 增加 trace replay。
5. 增加 evolution history store。
6. 增加 candidate generator 示例。

## 12. 判断边界

短期内，`evolving-agent` 的合格标准不是“像 Claude Code 一样能完整写项目”，而是：

- 能稳定运行 agent。
- 能稳定评测 agent。
- 能记录和解释 agent 行为。
- 能比较 agent 版本。
- 能基于 benchmark 结果推动 agent 进化。

只有这个闭环稳定后，才继续扩展 coding tools、subagent、resume、worktree、MCP 等更复杂能力。
