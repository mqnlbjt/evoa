# 记忆分层设计：两轴模型

## 设计动机

传统的线性分层（Meta Rules → Index → Facts → Skills → Archive）把「内容类型」和「访问方式」混在同一维度，导致：

- Index 作为独立层，和其他层生命周期不一致，维护成本高
- 没有显式的知识成熟度概念，Fact/Skill 要么「已验证」要么「未验证」，缺少渐进演进路径
- Evolution 只能比较 agent，不能比较记忆质量
- 记忆的可评测性弱

两轴模型把问题拆成两个正交维度：**内容类型**（是什么）和 **成熟度阶梯**（有多可靠）。

---

## 轴一：内容类型（4 层）

| 层 | 回答的问题 | 存储内容 | 示例 |
|---|-----------|---------|------|
| **Rule** | 我能/不能做什么？ | 安全约束、工具策略、交互模式 | "永不做破坏性操作"、"使用中文回答" |
| **Fact** | 我知道什么？ | 环境事实、用户偏好、领域知识 | "项目用 TypeScript ESM"、"默认模型 gpt-5.4-mini" |
| **Skill** | 我会怎么做事？ | 工作流、SOP、调试恢复模式 | "安全审查流程：读 diff → OWASP 检查 → 输出报告" |
| **Episode** | 我经历过什么？ | 会话提炼摘要、决策记录 | "Session #123：修 auth bug，改 3 文件，测试通过" |

### Index 不是层，是机制

每层内容在写入时自动更新索引（topic → memory_id 映射），查询时索引作为路由提示注入上下文。不再需要独立维护 Index 的生命周期。

### 和旧设计的对照

| 旧（v1） | 新（v2） | 变化 |
|---------|---------|------|
| trace | — | 删除。trace 是原始事件，不是记忆 |
| episode | Episode | 从逐消息存储 → 会话级 LLM 摘要 |
| knowledge | Fact | 新增 maturity/verifiedBy 字段 |
| doctrine | Rule | 从 knowledge 的同级 → 明确的高约束层 |
| — | Skill | 新增。原 REQUIREMENTS.md P4 远期目标 |
| — | Index（机制） | 新增。替代独立 Index 层 |

---

## 轴二：成熟度阶梯（跨所有层）

```
Seed ──→ Growing ──→ Stable ──→ Core
```

| 状态 | 含义 | 进入条件 | 可自动修改 |
|------|------|---------|-----------|
| **Seed** | 刚提取，未经任何验证 | 单次对话中提取 | 是 |
| **Growing** | 部分验证，置信度上升 | ≥2 次独立会话交叉验证 | 是 |
| **Stable** | 高度可信，长期不变 | ≥5 次验证，无冲突，时间跨度 ≥7 天 | 否（需手动/进化审批） |
| **Core** | 不可自动修改的基础约束 | 仅手动设定或进化接受 | 否（仅手动） |

### 各层的成熟度约束

| 层 | 允许的状态 | 初始状态 | 最高可达 |
|---|-----------|---------|---------|
| Rule | Core only | Core | Core |
| Fact | Seed → Growing → Stable | Seed | Stable |
| Skill | Seed → Growing → Stable | Seed | Stable |
| Episode | Seed only | Seed | Seed |

- **Rule 永远是 Core**：不可被 LLM 自动提取或修改
- **Episode 永远是 Seed**：会话记录不需要成熟度演进，只是历史快照
- **Fact/Skill 在三阶段中演进**：这是 Evolution 的核心评测对象

---

## 访问策略

上下文注入由两个维度共同决定：

| | Seed | Growing | Stable | Core |
|---|------|---------|--------|------|
| **Rule** | — | — | — | 始终注入（system 级） |
| **Fact** | 按需搜索 | 按需搜索 | 稳定上下文注入 | — |
| **Skill** | 仅显式查询 | 触发词匹配 | 触发词 + 稳定注入 | — |
| **Episode** | 按需搜索 | — | — | — |

### 上下文注入预算分配

```
总预算：maxContextTokens（默认 8000）

分配：
  Core Rule:      最多 20%  （始终注入，不可裁剪）
  Stable Fact:    最多 30%  （按优先级注入）
  Stable Skill:   最多 20%  （按触发注入）
  Growing Fact:   最多 15%  （按搜索相关性注入）
  Seed/Search:    最多 15%  （按需搜索，不预加载）
```

---

## Evolution 集成

### 记忆级的 Evolution

当前 Evolution 只比较 baseline agent vs candidate agent。两轴模型下，还可以比较**记忆质量**：

- **Fact 精度**：Stable fact 在 benchmark 中的引用准确率
- **Skill 成功率**：Skill 执行的成功/失败比
- **Seed→Stable 转化率**：多少 Seed 成功晋升到 Stable
- **稳定期漂移率**：Stable 记忆在后续会话中的冲突率（应为零）

### Evolution 决策维度

```
recommendation = f(
  score_delta,        // benchmark 分数变化
  regressions,        // 回归数量
  memory_quality,     // 新增：记忆质量指标
  maturity_decay      // 新增：成熟度退化（Stable → Growing）
)
```

---

## 类型系统设计

```typescript
// 内容类型
type MemoryLayer = "rule" | "fact" | "skill" | "episode";

// 成熟度
type Maturity = "seed" | "growing" | "stable" | "core";

// 成熟度状态机
const MATURITY_TRANSITIONS: Record<Maturity, Maturity[]> = {
  seed: ["growing"],
  growing: ["seed", "stable"],   // seed = 降级（冲突时）
  stable: ["growing", "core"],   // growing = 降级（漂移时）
  core: [],                       // 不可变
};

interface MemoryItem {
  id: string;
  agentId: string;
  layer: MemoryLayer;
  maturity: Maturity;
  content: string;
  sourceRefs: MemorySourceRef[];  // 溯源引用
  version: number;                // 每次修改 +1

  // 成熟度相关
  verifiedBy: string[];           // 验证过此记忆的 session ID
  verificationCount: number;
  lastVerifiedAt: number;
  conflicts: string[];            // 与之冲突的记忆 ID

  // 生命周期
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  staleAfterMs?: number;

  // 索引
  topics: string[];               // 自动提取的主题标签
  supersedes: string[];           // 取代的旧记忆 ID

  // 层特定元数据
  metadata: RuleMetadata | FactMetadata | SkillMetadata | EpisodeMetadata;
}
```

---

## 迁移路径

### Phase 1：类型兼容（不破坏现有 API）

1. 新增 `maturity` 字段，从旧 `status` + `confidence` 推导初始值
2. 旧 `doctrine` → `Rule` + `maturity: core`
3. 旧 `knowledge` → `Fact` + 推导 maturity（verified + high confidence → stable，其余 → seed）
4. 旧 `episode` → `Episode` + `maturity: seed`
5. 旧 `trace` → 移除

### Phase 2：成熟度状态机

1. 实现 `verifyMemoryCandidate` 的成熟度升级逻辑
2. 实现跨 session 交叉验证
3. 实现冲突检测和降级

### Phase 3：Skill 层

1. Skill 类型和 schema 定义
2. Skill 提取器（从成功 episode 中抽取模式）
3. Skill 执行引擎（preconditions → steps → verification）
4. Skill 成功率追踪

### Phase 4：Index 机制

1. 写入时自动 topic 提取和索引更新
2. 上下文注入的路由提示格式
3. 索引压缩（去重、合并相似 topic）

---

## 当前实现差距（2026-05-11 诊断）

### 项目文档未索引入记忆

`docs/`、`REQUIREMENTS.md` 等关键项目文档的内容不在记忆库中。用户提及「改造计划」等概念时，BM25 搜索只能匹配记忆条目，无法命中文档内容。agent 无法将用户的自然语言引用关联到具体文件。

### BM25 无法做语义匹配

当前 `manager.ts:searchTerms()` 使用 bigram 分词 + BM25 排序，是纯关键词匹配。「改造计划」和「memory-design」或「两轴模型」在字面上没有重叠，无法关联。

### 记忆提取的内容截断

- episode 候选截断到 320 字符（`extractor.ts`）
- LLM 提取的 knowledge/doctrine 截断到 240 字符（`llm-extractor.ts`）

表达复杂意图或跨多行引用文档时，截断可能导致关键信息丢失。

### 跨轮上下文稀释

多轮澄清对话（「记忆里没找到」→「文档在哪」→「就在目录下」→ 明确路径）滚动掉了最初的讨论话题。agent 最后只是机械列出文件，丢失了原始意图。

### LLM 中文语用误解

中文句末「的」是断言标记（「我是有文档的」），被 LLM 误判为消息截断。用户输入在 pipeline 中不会被截断——这是 LLM 层面的理解错误。

---

## 评测维度

### 可评测的记忆质量指标

| 指标 | 计算方式 | 目标 |
|------|---------|------|
| 提取精度 | 正确提取 / 总提取 | > 0.8 |
| Seed→Stable 转化率 | 晋升 stable 数 / seed 总数 | > 0.3 |
| Stable 漂移率 | 冲突降级数 / stable 总数 | = 0 |
| Skill 成功率 | 成功执行 / 总执行 | > 0.9 |
| 上下文命中率 | 注入后被引用的记忆 / 总注入 | > 0.5 |
| 索引路由精度 | 索引指向正确 / 总查询 | > 0.7 |

### Benchmark 场景覆盖

- 单事实提取和验证
- 跨会话事实一致性
- 冲突检测和降级
- Skill 执行和反馈
- 长期记忆保持（10+ 会话跨度）
- 嘈杂对话中的信号提取
