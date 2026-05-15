/**
 * SOP 类型定义 + 示例
 *
 * 这是 SOP 系统的设计草图，展示类型结构和具体 SOP 的样子。
 * 后续实现时这些类型会移入 src/sop/types.ts。
 */

// ============================================================
// 类型定义
// ============================================================

/** SOP 输入参数的 JSON Schema（跟随现有 EvolvingAgentTool.inputSchema 的模式） */
interface SOPSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/** 步骤前置条件 */
interface SOPCondition {
  type: "artifact_exists" | "tool_available" | "script" | "custom";
  config: Record<string, unknown>;
}

/** 步骤动作 */
type SOPAction =
  | { type: "tool"; tool: string; input: Record<string, unknown> }
  | { type: "prompt"; template: string }
  | { type: "sub_sop"; sopId: string; input: Record<string, unknown> };

/** 步骤级验证 */
interface SOPVerification {
  /** 验证方式 */
  method: "artifact_match" | "script" | "llm-judge" | "regex" | "custom";
  config: Record<string, unknown>;
}

/** SOP 执行步骤 */
interface SOPStep {
  id: string;
  name: string;
  description: string;
  /** 依赖的前置步骤 ID（DAG） */
  dependsOn?: string[];
  precondition?: SOPCondition;
  action: SOPAction;
  /** 步骤输出的 JSON Schema（用于验证和步骤间数据传递） */
  outputSchema?: unknown;
  verification?: SOPVerification;
}

/** SOP 顶层定义 */
interface SOPSpec {
  id: string;
  version: string;
  name: string;
  description: string;
  /** 输入参数 schema */
  params: SOPSchema;
  steps: SOPStep[];
  /** 最终验证 */
  verification?: SOPVerification;
  /** 超时（ms） */
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

/** SOP 单步执行结果（进入 trace） */
interface SOPStepResult {
  stepId: string;
  status: "passed" | "failed" | "skipped";
  output: unknown;
  verification?: { passed: boolean; detail?: string };
  durationMs: number;
  error?: string;
}

/** SOP 整体执行结果 */
interface SOPResult {
  sopId: string;
  status: "passed" | "failed" | "partial";
  stepResults: SOPStepResult[];
  finalVerification?: { passed: boolean; detail?: string };
  totalDurationMs: number;
  trace: unknown; // 可序列化进 benchmark run
}

// ============================================================
// 示例：安全审查 SOP
// ============================================================

const securityReviewSOP: SOPSpec = {
  id: "security-review",
  version: "1.0.0",
  name: "安全审查",
  description: "对当前分支的变更进行安全审查，检查常见漏洞和敏感信息泄露",
  timeoutMs: 120_000,

  params: {
    type: "object",
    properties: {
      targetBranch: {
        type: "string",
        description: "对比的目标分支，默认 main",
      },
      focusDirs: {
        type: "array",
        items: { type: "string" },
        description: "限定审查目录，不传则审查全部变更",
      },
      severity: {
        type: "string",
        enum: ["low", "medium", "high", "critical"],
        description: "最低报告严重级别，默认 medium",
      },
    },
  },

  steps: [
    {
      id: "get_diff",
      name: "获取变更",
      description: "收集当前分支相对于目标分支的所有文件变更",
      action: {
        type: "tool",
        tool: "bash",
        input: {
          command: "git diff --name-status {{params.targetBranch}}...HEAD {{#if params.focusDirs}}-- {{params.focusDirs}}{{/if}}",
          description: "Get changed files list",
        },
      },
      outputSchema: {
        type: "string",
        description: "制表符分隔的文件变更列表：status\tpath",
      },
      verification: {
        method: "regex",
        config: { pattern: "^[MADRT][0-9]*\\t", multiline: true },
      },
    },

    {
      id: "scan_secrets",
      name: "敏感信息扫描",
      description: "检查变更文件中是否包含密钥、token、密码等敏感信息",
      dependsOn: ["get_diff"],
      action: {
        type: "tool",
        tool: "grep",
        input: {
          pattern: "(password|secret|token|api[_\\s]?key|private[_\\s]?key|BEGIN\\s(?:RSA|DSA|EC|OPENSSH)\\sPRIVATE\\sKEY)\\s*[:=]\\s*[^\\s]",
          glob: "*.{ts,js,py,go,yaml,yml,json,sh,toml,env}",
          output_mode: "content",
          "-n": true,
        },
      },
      outputSchema: {
        type: "array",
        items: { type: "string" },
        description: "匹配到的敏感信息行",
      },
    },

    {
      id: "scan_command_injection",
      name: "命令注入检查",
      description: "检查是否存在未转义的用户输入拼接到 shell/exec 命令中",
      dependsOn: ["get_diff"],
      action: {
        type: "tool",
        tool: "grep",
        input: {
          pattern: "(exec|spawn|execSync|execFile|system|popen)\\s*\\(\\s*[^)]*\\+",
          glob: "*.{ts,js,py,go}",
          output_mode: "content",
          "-n": true,
        },
      },
      outputSchema: {
        type: "array",
        items: { type: "string" },
        description: "潜在命令注入点",
      },
    },

    {
      id: "scan_sql_injection",
      name: "SQL 注入检查",
      description: "检查是否存在字符串拼接构造 SQL 语句",
      dependsOn: ["get_diff"],
      action: {
        type: "tool",
        tool: "grep",
        input: {
          pattern: "(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\\s.*['\"]\\s*\\+",
          glob: "*.{ts,js,py,go,java}",
          output_mode: "content",
          "-n": true,
        },
      },
      outputSchema: {
        type: "array",
        items: { type: "string" },
        description: "潜在 SQL 注入点",
      },
    },

    {
      id: "scan_xss",
      name: "XSS 检查",
      description: "检查是否存在未经转义的用户输入嵌入 HTML/JSX",
      dependsOn: ["get_diff"],
      precondition: {
        type: "script",
        config: {
          command: "git diff --name-only main...HEAD | grep -qE '\\.(tsx|jsx|html)$'",
        },
      },
      action: {
        type: "tool",
        tool: "grep",
        input: {
          pattern: "dangerouslySetInnerHTML|innerHTML\\s*=|document\\.write\\(",
          glob: "*.{tsx,jsx,html,ts,js}",
          output_mode: "content",
          "-n": true,
        },
      },
      outputSchema: {
        type: "array",
        items: { type: "string" },
      },
    },

    {
      id: "llm_review",
      name: "LLM 综合审查",
      description: "将上述扫描结果汇总，由 LLM 进行综合安全判断",
      dependsOn: ["scan_secrets", "scan_command_injection", "scan_sql_injection", "scan_xss"],
      action: {
        type: "prompt",
        template: `
你是一位安全审计专家。请审查以下代码变更的安全问题。

变更文件:
{{steps.get_diff.output}}

敏感信息扫描结果:
{{steps.scan_secrets.output}}

命令注入检查结果:
{{steps.scan_command_injection.output}}

SQL 注入检查结果:
{{steps.scan_sql_injection.output}}

XSS 检查结果:
{{steps.scan_xss.output}}

请输出 JSON 格式：
{
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "type": "secret_leak|command_injection|sql_injection|xss|other",
      "file": "文件路径",
      "line": 行号,
      "description": "问题描述",
      "recommendation": "修复建议"
    }
  ],
  "summary": "一句话总结",
  "safe_to_merge": true/false
}
        `.trim(),
      },
      outputSchema: {
        type: "object",
        properties: {
          findings: { type: "array" },
          summary: { type: "string" },
          safe_to_merge: { type: "boolean" },
        },
      },
      verification: {
        method: "llm-judge",
        config: {
          criteria: "审查结果是否格式正确且覆盖了所有扫描发现的问题",
        },
      },
    },
  ],

  // 最终验证：SOP 整体是否通过
  verification: {
    method: "script",
    config: {
      command: `
        severity_order() {
          case "$1" in critical) echo 4;; high) echo 3;; medium) echo 2;; low) echo 1;; esac
        }
        THRESHOLD=$(severity_order "{{params.severity}}")
        # 从 llm_review 输出中提取最高严重级别
        # 如果有 finding 的 severity >= THRESHOLD 则失败
      `.trim(),
    },
  },

  metadata: {
    category: "安全",
    builtin: true,
    requiresNetwork: true, // llm_review 步骤需要模型调用
  },
};
