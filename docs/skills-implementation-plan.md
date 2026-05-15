# Skills 实现计划

> 版本：v1.1 | 更新日期：2026-05-11

---

## 一、现状盘点

### 已完成

| 文件 | 能力 | 状态 |
|------|------|------|
| `src/skills/types.ts` | Skill / SkillVersion / SkillProvenance / SkillBank / SkillMatch / SkillSelector | 类型定义完整 |
| `src/skills/store.ts` | FileSkillBank（JSON 持久化）+ MemorySkillBank（内存） | 已实现，缺测试 |
| `src/skills/depositor.ts` | deposit / depositFromEvolution / depositFromSuccessfulRun | 已实现，缺测试 |
| `src/sop/*` | SOP 运行时：types / runner / validator / loader / verification | 39 tests 通过 |

### 缺失

| 缺失模块 | 优先级 | 说明 |
|----------|--------|------|
| SkillSelector 实现 | P0 | SkillBank.search() 已有关键词打分，Selector 只做阈值/排序/包装 |
| SkillExtractor | P0 | 核心难点：generateSopFromMessages() 的提取策略 |
| Store + Depositor 测试 | P0 | 代码已有，补覆盖 |
| SOP YAML → SkillBank 导入 | P0 | sop/ 目录下的 YAML 文件需要进入 SkillBank |
| CLI `skill` 子命令 | P1 | list / show / deposit / deprecate / import / export |
| Runtime 集成 (SkillTool) | P1 | Skill 注册为 EvolvingAgentTool，模型可调用 |
| Memory ↔ Skills 联动 | P2 | 独立的桥接层 |

---

## 二、总体架构

```
sop/*.yaml ──加载──▶ SkillBank (JSON) ──查询──▶ SkillSelector ──match──▶ Agent
                         ▲                                      │
                    SkillDepositor ◀── SkillExtractor ◀── successful trace
```

关键设计决策：

- **Skill 是 SOP + 元数据**：SkillVersion 包含 SOPSpec，执行委托给 SOP Runner
- **Selector 复用 bank.search()**：不重复实现打分逻辑，Selector 只做阈值过滤和 SkillMatch 封装
- **Skill ↔ SOP 解耦**：SOP 可以独立于 Skill 运行（CLI `sop run`），Skill 是 SOP 的"可检索包装"

---

## 三、分阶段实施

### Phase 0：补齐测试 + SOP 导入（P0—填坑）

**目标**：现有代码有测试覆盖，SOP YAML 能进入 SkillBank。

**内容**：

| 任务 | 说明 |
|------|------|
| `test/skills-store.test.ts` | FileSkillBank / MemorySkillBank 的 CRUD、search、filter、serialize |
| `test/skills-depositor.test.ts` | deposit / depositFromEvolution 阈值过滤 / depositFromSuccessfulRun / 版本递增 |
| `src/skills/importer.ts` | `importSopsFromDirectory(dir)` — 扫描 sop/ 目录 YAML → 验证 → 调用 depositor 入库 |
| `store.ts` 小修 | `bank.search()` 加入 useCount bonus（与 Selector 保持一致） |

**依赖**：无（现有 sop/* + skills/* 代码已就绪）

---

### Phase 1：SkillSelector（P0—核心匹配）

**目标**：Agent 收到 prompt 时，自动从 SkillBank 匹配适用 Skill。

**核心理念**：复用 `bank.search()`，不做重复打分。

```typescript
class SkillKeywordSelector implements SkillSelector {
  constructor(
    private bank: SkillBank,
    private options: { threshold?: number; maxResults?: number } = {}
  ) {}

  async select(prompt: string, _context?: Record<string, unknown>): Promise<SkillMatch[]> {
    // 1. 用 bank.search 获取候选 skill（已按内部 score 排序）
    const candidates = this.bank.search(prompt, this.options.maxResults ?? 10);
    
    // 2. 计算标准化 confidence
    const threshold = this.options.threshold ?? 0.3;
    return candidates
      .map(skill => {
        // 重新基于 trigger 精确匹配计算 confidence（search 的内部 score 不稳定）
        const confidence = this.calculateConfidence(prompt, skill);
        return { skill, confidence, reason: `matched: ${skill.triggers?.join(", ") ?? "keyword"}` };
      })
      .filter(m => m.confidence >= threshold)
      .slice(0, this.options.maxResults ?? 5);
  }

  private calculateConfidence(prompt: string, skill: Skill): number {
    const lower = prompt.toLowerCase();
    let score = 0;
    // Trigger exact match (high weight)
    if (skill.triggers) {
      for (const t of skill.triggers) {
        if (lower.includes(t.toLowerCase())) score += 5;
      }
    }
    // Name keyword match
    if (lower.includes(skill.name.toLowerCase())) score += 2;
    // Use count bonus (capped)
    if (skill.useCount) score += Math.min(1, skill.useCount / 100);
    return Math.min(1, score / 8);
  }
}
```

**新增文件**：`src/skills/selector.ts`、`test/skills-selector.test.ts`

**测试覆盖**：trigger 精确匹配 | 阈值过滤 | 空 bank | deprecated 不参与 | maxResults | 排序

---

### Phase 2：SkillExtractor（P0—自动提炼）

**目标**：成功的 session / SOP run 自动提炼为可复用的 Skill。

**核心难点**：`generateSopFromMessages()` —— 从对话/工具调用序列生成结构化的 SOPSpec。

**v1 策略：规则提取**

```
trace 中的 tool_call events
  ↓ 去重 + 排序
提取每个 distinct tool 的 (name, input) 对
  ↓ 
按调用顺序映射为 SOPStep[]
  step.id = tool_name_index
  step.action = { type: "tool", tool, input }
  ↓
自动生成 SOPSpec
  id = hash of user prompt
  name = 从 user prompt 提取前 N 个词
  description = 从 final answer 提取摘要
  triggers = 从 user prompt 提取关键词
```

**v2 策略（之后迭代）**：LLM 提取 —— 把 session messages 发给 cheap model，让它生成 SOP YAML。

```typescript
interface SkillExtractor {
  extractFromSession(session: SessionRecord): SkillCandidate | null;
}
```

**新增文件**：`src/skills/extractor.ts`、`test/skills-extractor.test.ts`

**风险**：如果规则提取质量太低（生成的 SOP 下次匹配不上），自动沉淀链路就断了。Phase 2 必须先验证这个假设。

---

### Phase 3：CLI 集成（P1）

**新增文件**：`src/cli/skill.ts`

```bash
evolving-agent skill list [--status active] [--tags tag1,tag2]
evolving-agent skill show <id>
evolving-agent skill deposit --sop <path> --name "..." --description "..."
evolving-agent skill deprecate <id> --reason "..."
evolving-agent skill import --dir sop/       # 批量导入 SOP YAML
evolving-agent skill export [--output skills.json]
```

**修改文件**：`src/cli/args.ts`、`src/cli/commands.ts`、`src/cli/main.ts`

---

### Phase 4：Runtime 集成 — SkillTool（P1）

**目标**：Skill 注册为 `EvolvingAgentTool`，模型可以通过 tool call 调用。

**实现**：

```typescript
// src/skills/tool.ts
function createSkillTool(bank: SkillBank, selector: SkillSelector, sopRunner): EvolvingAgentTool {
  return {
    name: "skill",
    description: "Invoke a skill from the SkillBank",
    inputSchema: { skill: { type: "string" }, args: { type: "string" } },
    permission: { defaultDecision: "allow", riskLevel: "medium" },
    concurrency: "sequential",
    async execute(input) {
      const skill = bank.get(input.skill);
      if (!skill) return { error: `skill "${input.skill}" not found` };
      const version = skill.versions.find(v => v.version === skill.currentVersion);
      // 委托给 SOP Runner
      const result = await executeSop(version.sop, ...);
      // 更新 useCount
      bank.upsert({ ...skill, useCount: (skill.useCount ?? 0) + 1, lastUsedAt: Date.now() });
      return result;
    }
  };
}
```

**新增文件**：`src/skills/tool.ts`、`test/skills-tool.test.ts`

---

### Phase 5：Memory ↔ Skills 联动（P2）

| 方向 | 实现 |
|------|------|
| Memory → Skills | 成功 episode 触发 SkillExtractor |
| Skills → Memory | Skill 执行结果写入 memory episode |
| 联合检索 | Selector 查询时参考相关 memory episode |

**新增文件**：`src/skills/memory-bridge.ts`

---

## 四、实施顺序

```
Phase 0: 测试 + 导入  ← 先填坑
   │
   ├── Phase 1: Selector  ← 核心匹配
   │     │
   │     └── Phase 4: SkillTool + Runtime 集成
   │
   ├── Phase 2: Extractor  ← 先验证规则提取可行性
   │
   └── Phase 3: CLI
   
Phase 5: Memory Bridge ← 最后，不阻塞主链路
```

---

## 五、质量门禁

每个 Phase 完成后：

| 检查项 | 标准 |
|--------|------|
| TypeScript 编译 | `tsc --noEmit` 零错误 |
| 单元测试 | 全部通过 |
| 现有测试 | 不回归 |
| 全量测试 | `npm test` 通过 |

---

## 六、关键设计决策

1. **Selector 不重复打分** —— 复用 `bank.search()`，只标准化 confidence + 阈值过滤
2. **Extractor v1 用规则提取** —— 简单可靠，LLM 版本后续迭代
3. **Skill 执行委托给 SOP Runner** —— Skill 是元数据层，SOP 是执行层
4. **SOP YAML 需显式导入** —— `skill import --dir sop/` 或 `deposit --sop <file>`
5. **向后兼容** —— 所有新增不影响现有 SOP / Evolution / Memory 行为
