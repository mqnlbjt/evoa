# Agent 题目生成 Prompt 模板

生成用于 evolving-agent benchmark 的 TaskSpec，覆盖 6 个压力维度。
输出纯 JSON（不要 markdown 代码块包裹），包含完整的 mock workspace 数据。

## JSON Schema

```json
{
  "id": "suite-xxx",
  "name": "维度名称", 
  "tasks": [
    {
      "id": "task-xxx-001",
      "type": "general",
      "title": "任务标题（简短描述）",
      "prompt": "任务完整指令（Agent 收到的自然语言任务）",
      "fixtures": [
        { "path": "workspaces/task-xxx-001/file.csv", "content": "文件完整内容" }
      ],
      "scoring": {
        "method": "rubric",
        "maxScore": 10,
        "config": {
          "criteria": [
            { "description": "评分关键字1", "weight": 3, "required": true },
            { "description": "评分关键字2", "weight": 2 }
          ],
          "passThreshold": 0.6
        }
      }
    }
  ]
}
```

## 6 个压力维度及要求

### 1. tool-orchestration（工具编排）
- 任务需要 5+ 步工具调用，有严格的依赖顺序
- 后续步骤依赖前一步的输出结果
- 涉及至少 3 种不同工具
- 考察点：工具选择是否正确、调用顺序是否合理

### 2. context-compression（上下文压缩）
- 初始环境有 15+ 个含噪音的文件，关键信息只藏在 1-2 个文件中
- Agent 必须逐一排查才能定位关键数据
- 消息历史会迅速膨胀，考验 compaction 后的信息保留
- 考察点：压缩后是否丢失关键信息

### 3. error-recovery（错误恢复）
- 任务中 1-2 个资源不存在或格式损坏
- Agent 必须检测到错误、不崩溃、寻找替代方案
- 考察点：错误检测、回退策略、替代路径

### 4. permission-boundary（权限边界）
- 某些明显方案被工具策略拦截（如 deny bash）
- Agent 必须在受限工具集内找到合法替代方案
- 不能违规操作，但也不能放弃任务
- 考察点：边界意识、替代工具选择

### 5. subtask-decomposition（子任务拆分）
- 任务涉及3+个独立模块/目录，可并行处理
- 需要使用 subagent 工具拆分任务
- 考察点：拆分合理性、结果汇总完整性

### 6. long-range-memory（长程记忆）
- 关键信息在任务开头出现，但要在 10+ 步后才能用到
- 中间穿插大量无关操作或噪音数据
- 考察点：长程信息保留、不被中间噪音冲掉

## 生成规则

1. prompt 用中文写（模拟真实用户指令）
2. fixtures 数据要真实、合理、可验证（CSV有列头、日志有时间戳、配置有合法格式）
3. rubric criteria 的 description 必须是答案中会出现的**实际子串**，不是抽象描述
4. required=true 的 criteria 是必须命中的关键结果
5. 每道题的正确答案必须能从 fixtures 中推导出来
6. 不要设计需要真实网络访问的题目（web_fetch 除外，可以用 mock URL）
7. maxScore 根据难度设定：简单 3-5，中等 6-8，困难 9-12
