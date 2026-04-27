# evolving-agent 阶段性记录

## 当前阶段目标

本阶段目标是把 `evolving-agent` 从“Agent 规格 + Benchmark 骨架”推进到一个可以运行、可以评测、可以接入本地 OpenAI/Anthropic 兼容服务的最小 agent 框架。

参考方向：

- 借鉴 Claude Code 的 agent 定义、权限控制、验证思路。
- 借鉴 pi 的清晰 runtime/session/model 分层和 OpenAI/Anthropic provider 思路。
- 保持 `evolving-agent` 自身轻量、独立、适合做 benchmark 和 agent evolution。

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

### 9. 模型发现与轻量 ModelRegistry

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

## 当前测试状态

已通过：

```bash
npm test
npm run typecheck
npm run build
```

当前测试数量：

```txt
11 test files
32 tests passed
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

当前 `evolving-agent` 只有核心框架能力：

- runtime loop。
- model client。
- tool registry。
- benchmark。
- evolution comparison。
- verifier。

还没有：

- CLI/TUI。
- 真正的代码编辑工具集。
- MCP。
- hooks。
- skills。
- background task。
- worktree isolation。
- agent resume。
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

1. CLI：运行 benchmark、指定 agent/suite/model/baseURL/key。
2. 示例文件：agents、suites、local endpoint config。
3. 基础 coding tools：read、write、bash、edit。
4. tool call 协议：让 OpenAI/Anthropic client 可以解析模型返回的工具调用。

优先级中等：

1. JSONL trace replay。
2. benchmark report 导出。
3. verification artifact。
4. subagent 手动调用。
5. candidate generator 示例。

优先级较低：

1. MCP。
2. hooks。
3. skills。
4. worktree isolation。
5. background task。
6. TUI。
7. Slack bot。

## 建议下一阶段

建议下一阶段实现最小 CLI 与示例文件。

目标：

```bash
evolving-agent models discover --provider local --base-url http://localhost:8317/v1 --api-key 12345678
evolving-agent run --agent examples/agents/basic.json --task examples/tasks/smoke.json --provider local --model gpt-5.4-mini
evolving-agent benchmark --suite examples/suites/smoke.json --agent examples/agents/basic.json --provider local --model gpt-5.4-mini
```

建议先实现：

- `models discover`：调用 `ModelRegistry` / `discoverOpenAICompatibleModels` 输出可用模型。
- `run`：加载 agent/task JSON，创建模型客户端，运行单个 task。
- `benchmark`：加载 suite/agent，运行 benchmark。
- 示例文件：local provider、basic agent、smoke task/suite。

这样可以把当前 runtime、model client、ModelRegistry、benchmark 串成可从命令行使用的最小闭环。
