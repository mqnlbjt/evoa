# 测试与验证审查报告

> 审查日期：2026-06-04
> 基础提交：`ac2cb01`（补充调试复现资料）
> 审查范围：当前 Git diff 中的所有变更（30 个文件，+769/-242 行）

---

## 总览

| 维度 | 状态 |
|------|------|
| 新增测试文件 | ✅ 全部通过（3个文件，64 个测试） |
| 现有测试文件 | ⚠️ 10 个文件失败，共 52 个测试失败 |
| 类型检查 | ⚠️ 7 个错误（全部为已存在的） |
| 预存在失败 | 23 个测试在基础提交上已失败 |
| **本次变更引入的新失败** | **~29 个测试** |

---

## BLOCKERS

### B1. `isChatCompletionsBaseURL` 逻辑反转（~24 个测试失败的根本原因）

**文件：** `src/models/openai-client.ts:529-533`

```typescript
function isChatCompletionsBaseURL(baseURL: string | undefined): boolean {
    if (!baseURL) return false;
    const normalized = baseURL.replace(/\/+$/, "").toLowerCase();
    return !normalized.endsWith("api.openai.com/v1") && !normalized.endsWith("api.openai.com");
}
```

**问题：** 这个函数对非 OpenAI 官方 URL 返回 `true`。对于 `http://localhost:8317/v1`：
- `normalized.endsWith("api.openai.com/v1")` → `false`
- `normalized.endsWith("api.openai.com")` → `false`
- `!false && !false` → `true`

这意味着**所有**第三方/localhost 的 `openai-responses` provider 都被错误路由到 Chat Completions 路径。

**影响范围（本次变更引入的失败）：**

| 测试文件 | 失败数量 | 具体原因 |
|----------|---------|---------|
| `test/openai-client.test.ts` | **2** | "uses direct fetch" 期望 `/responses` 但走了 `/chat/completions"；"prompt cache params" 因 auth 失败 |
| `test/model-registry.test.ts` | **1** | SDK client factory 被忽略，走了 `completeChat()` |
| `test/tui-interactive-mode.test.ts` | **9** | 全部因模型请求失败/超时（原基础提交全部通过 ✅） |
| `test/cli-main.test.ts` | **~10 新增** | 集成测试使用 localhost URL，被错误路由（原基础已失败 5 个，现共 15 个） |
| `test/chat-service-auto-continue.test.ts` | **3** | 模型响应格式变更导致条件不满足（原基础全部通过 ✅） |
| `test/tui-automation-tools.test.ts` | **1** | 超时（原基础通过 ✅） |
| `test/mcp-http-smoke.test.ts` | **1** | 推测同因（原基础通过 ✅） |

**建议修复：** `OpenAIModelClient` 不应使用 `isChatCompletionsBaseURL` 来决定路由。`useChatCompletions` 应始终为 `false`，Chat Completions 支持应完全通过 `OpenAIChatModelClient`（格式 `"openai-chat"`）来处理。`OpenAIModelClient` 应始终使用 Responses API。

### B2. Anthropic assistant 消息内容格式变更（2 个测试失败）

**文件：** `src/models/anthropic-client.ts:290-302`

新的 `toAnthropicMessage` 逻辑将所有的 assistant 消息包装为 block 数组格式：

```typescript
const content = [...thinkingBlocks, ...textBlock, ...toolUseBlocks];
```

当 `alwaysIncludeReasoning` 为 `true`（provider style 为 `"deepseek"` 或 `"anthropic"` 时），即使没有 reasoning 内容也会包含一个空的 `{ type: "thinking", thinking: "" }` 块，并将文本包装为 `[{ type: "text", text: "visible" }]` 而非纯字符串 `"visible"`。

**影响测试（原基础提交全部通过 ✅）：**
1. `"does not replay stored reasoning as Anthropic thinking history"` — 期望 `content: "visible"`，得到 `[{ type: "thinking", thinking: "" }, { type: "text", text: "visible" }]`
2. `"adds cache_control to messages with cache:true flag"` — 期望 `content: "working"`，得到 `[{ type: "text", text: "working" }]`

**建议修复：** 当 assistant 消息没有 reasoning、只有 text content 时，应回退到旧格式 `content: "working"`（纯字符串）。或者更新测试以接受新格式。建议采用前者以保持向后兼容性。

---

## FIXES

### F1. 新增测试质量良好，无需修改

三个新增/修改的测试文件全部通过：

- **`test/openai-chat-client.test.ts`**（16 个测试 ✅）— 覆盖全面：
  - 基础请求/响应映射
  - tool calls 解析
  - tool result 格式
  - reasoning_content 回放
  - reasoning_content 提取
  - returnContent: "never" 跳过
  - `extra_body.thinking`（DeepSeek 风格）
  - `reasoning_effort`（标准 chat-compatible）
  - array-format content
  - HTTP 错误
  - Streaming：text deltas, reasoning deltas, tool calls, HTTP 错误

- **`test/advanced-grader.test.ts`**（26 个测试 ✅）— 覆盖全面：
  - `CommandGrader`：8 个测试（exitCode, stdoutContains, stdoutExact, stderrContains, partial scoring, 错误路径）
  - `ArtifactGrader`：9 个测试（exists, contains, exactMatch, regex, maxLines, minHeightLines, partial scoring, 错误路径）
  - `CompositeGrader`：4 个测试（权重聚合, passThreshold, subscores 验证）
  - `GraderRegistry`：3 个测试（factory, unknown method, custom registration）

- **`test/minimal-grader.test.ts`**（22 个测试 ✅）— 新增 1 个 `command grader` 验证测试

### F2. 更新现有测试以适配消息格式变更

两个测试的断言需要更新以反映消息格式变更：

**`test/anthropic-client.test.ts:267`**
- 旧：`expect(body.messages[1]).toEqual({ role: "assistant", content: "visible" })`
- 新可能需要：`expect(body.messages[1].role).toBe("assistant")` 并验证 content 是包含 text 块的数组

**`test/anthropic-client.test.ts:316`**
- 旧：`expect(body.messages).toMatchObject([..., { role: "assistant", content: "working" }, ...])`
- 新需要：同步测试中的预期 content 格式

### F3. 类型检查错误

7 个类型错误，全部为已存在的（与本次变更无关）：

| 文件 | 数量 | 描述 |
|------|------|------|
| `test/market-converter.test.ts` | 3 | `template` 不在 `SOPAction` 上（`SOPAction` 类型变更） |
| `test/skill-tool.test.ts` | 1 | 找不到 `runtime/session.js` 模块 |
| `test/skills-integration.test.ts` | 3 | 隐式 `any` 类型 + `skills` 属性不存在 |

---

## CONCERNS

### C1. `OpenAIChatModelClient` 的测试未覆盖注册表集成

`openai-chat-client.test.ts` 直接测试 `OpenAIChatModelClient`，但没有测试通过 `ModelRegistry.createClient(providerId, modelId)` 使用 `format: "openai-chat"` 创建 client 的路径。`test/model-registry.test.ts` 中也没有对应测试。

**建议：** 至少添加一个集成测试验证 registry 能正确创建 `OpenAIChatModelClient`。

### C2. `OpenAIChatModelClient` 缺少单元测试 edge cases

当前 16 个测试覆盖了主要路径，但缺少：

- **空 tool_calls 参数：** 当 tool_calls 的 `function.arguments` 是无效 JSON 时的处理
- **SSE 格式异常：** 缺少 `data:` 前缀、多行 JSON、`[DONE]` 前出现其他非 data 行
- **并发请求：** 多个流请求同时进行时的状态隔离

这些属于边缘情况，不是阻塞问题。

### C3. Anthropic reasoning signature 支持缺少测试

Diff 中添加了 `reasoningSignature` 字段到 `AnthropicModelClient`（`parseThinkingSignature` + 返回对象中的 `reasoningSignature`），但没有任何测试覆盖：
- 解析带有 `signature` 的 `thinking` block
- 解析带有 `signature` 的 `redacted_thinking` block
- 在 `ModelResponse` 中正确传递 signature
- 没有 signature 时的回退行为

### C4. `context-view.ts` 的 `normalizeToolPairOrder` 无直接测试

新增的 `normalizeToolPairOrder` 和 `stripDanglingToolCalls` 函数没有单元测试（只在集成上下文中测试）。虽然不是阻塞问题，但这是容易出错的逻辑，值得有针对性测试。

---

## OK

### O1. 测试结构合理

- 所有新增测试使用 `vitest` 标准 API (`describe`/`it`/`expect`)
- 测试文件命名一致 (`test/*.test.ts`)
- Mock/假实现清晰（`fakeModelClient`, `jsonResponse`, `sseResponse`）
- 没有 flaky 的时间依赖（使用 `defer` 模式而非固定超时）

### O2. Grader 测试覆盖完整

`advanced-grader.test.ts` 在 grader 架构重构中做得很好：
- `CommandGrader`：测试了所有 4 种检查类型（exitCode, stdoutContains, stdoutExact, stderrContains）
- `ArtifactGrader`：测试了所有 6 种检查类型
- 都测试了 proportional scoring
- 都测试了无效配置的错误处理
- `CompositeGrader` 权重/阈值行为正确

### O3. `cli-config.test.ts` 的更新正确

provider format 错误消息的更新正确反映了新的 `openai-chat` 格式：

```
"config.providerFormat must be openai-responses, openai-chat, or anthropic-messages"
```

---

## 总结

| 类型 | 数量 | 详情 |
|------|------|------|
| **BLOCKERS** | 2 | `isChatCompletionsBaseURL` 逻辑反转（~24 个测试失败）、Anthropic 消息格式变更（2 个测试失败） |
| **FIXES** | 2 | 更新 anthropic 测试断言、考虑修复 `isChatCompletionsBaseURL` |
| **CONCERNS** | 4 | registry 集成测试、chat-client edge cases、reasoning signature 测试、context-view 测试 |
| **OK** | 3 | 新增测试结构良好、grader 覆盖完整、config 消息更新正确 |

**验证命令执行：**
```bash
node node_modules/vitest/vitest.mjs run 2>&1 | tail -5
# → 10 failed | 74 passed | 1 skipped (85 files) — 52 failed tests total
node node_modules/typescript/bin/tsc --noEmit --pretty 2>&1 | head -60
# → 7 errors in 3 files (all pre-existing)
```

**核心结论：** 新增的 64 个测试（3 个文件）全部通过，测试质量良好。但 `isChatCompletionsBaseURL` 函数的逻辑错误导致约 24 个现有测试新失败，这是一个**必须先修复**的回归。Anthropic 消息格式变更还导致 2 个额外测试失败。建议优先修复 B1，再处理 B2。
