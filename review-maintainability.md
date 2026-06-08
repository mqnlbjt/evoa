# Maintainability Review

Reviewed against the current git diff (30 files, +769/−242) and new files in `src/benchmark/graders/`.

---

## BLOCKERS

### B1 — Duplicate interface declarations in `src/benchmark/types.ts`

`TaskGraderOptions`, `AgentRuntimeExecutor`, and `TaskGrader` are each declared **twice** in the same file (lines 23, 102, 107 and again at 111, 115, 120 respectively). TypeScript interface merging will silently combine them, but the repeated declarations are misleading and fragile—if one copy is edited and the other is not, consumers will get unexpected behaviour.

**Fix:** Remove the second block (lines 110–122).

---

## IMPROVEMENTS

### I1 — Extract shared helpers into a utility module

These utility functions are duplicated across files:

| Function | Files where duplicated |
|---|---|
| `normalizeBaseURL` | `openai-chat-client.ts`, `generator.ts` |
| `extractJson` | `llm-judge.ts`, `generator.ts` |
| `asRecord` | `openai-client.ts`, `openai-chat-client.ts` |
| `toArray` | `openai-client.ts`, `openai-chat-client.ts` |
| `normalizeUsage` | `openai-client.ts`, `openai-chat-client.ts` |
| `maxScore(task)` | All 6 grader files: exact.ts, rubric.ts, composite.ts, llm-judge.ts, command.ts, artifact.ts |

**Recommendation:** Move into `src/utils/json-utils.ts` (for `asRecord`, `toArray`, `extractJson`, `normalizeUsage`) and `src/utils/score-utils.ts` (for `maxScore`, `formatPercent`). This is ~25 lines total across 8 files that could live in 2 shared modules.

### I2 — Avoid context spreading of partial chunks in grader output

`benchmark/runner.ts` lines ~102-110 mix `graderContext.artifacts` into the execution output:

```ts
const augmentedOutput = { ...output };
if (this.graderContext?.artifacts) {
    augmentedOutput.artifacts = { ...this.graderContext.artifacts, ...(output.artifacts ?? {}) };
}
score = await this.grader.grade(agent, task, augmentedOutput);
```

This is fragile—`output` starts as `{}` and gets mutated through a mix of runtime execution (which may set `artifacts`) and then overlaid with context artifacts. Better to pass `graderContext.artifacts` as a grader context field rather than patching the output object.

### I3 — `fixture.ts` teardown command has fragile quoting

The teardown command in `DefaultFixtureManager.teardown`:

```
find . -name ".teardown" -exec /bin/sh -c 'cd "$(dirname {}" \')' && /bin/sh .teardown' \\; 2>/dev/null || true
```

This has mismatched quotes and a `dirname {}` with a stray trailing quote. It's unclear whether this will work on any real filesystem.

**Recommendation:** Replace with a cleaner inline shell script:

```ts
const teardownCmd = [
  'find . -name ".teardown" | while IFS= read -r f; do',
  '  dir="$(dirname "$f")" && cd "$dir" && sh .teardown;',
  'done',
].join(" ");
```

Or better, collect the paths with a first `find` call, then iterate in Node.js.

### I4 — `buildGraderContext` in runner.ts is over-engineered

`benchmark/runner.ts` function `buildGraderContext` constructs a new context from optional base + optional workspaceDir, copying fields manually. The caller's pattern is:

```ts
const context = buildGraderContext(this.graderContext, workspaceDir);
```

But then the runner also checks `this.graderContext` directly for the `artifacts` field (see I2). Simplify by merging workspaceDir directly into the injected context object when it's set.

### I5 — `CompositeGrader` creates per-sub-task specs with type assertion

In `graders/composite.ts`:

```ts
const subTask: TaskSpec = { ...task, scoring: { method: sub.method as TaskSpec["scoring"]["method"], maxScore: 1, config: sub.config } };
```

The `as TaskSpec["scoring"]["method"]` cast is a type cheat. If `sub.method` isn't a valid scoring method, there's no runtime guard. `scoring.method` is typed as `"exact" | "rubric" | "command" | "custom" | "llm-judge" | "artifact"` — best to validate that `sub.method` is in this set before casting.

---

## CONCERNS (style/naming to discuss)

### C1 — `chat-compatible` vs `openai-chat` naming confusion

- `ProviderFormat` uses `"openai-chat"` 
- `resolveReasoningPolicy` takes a second arg like `"chat-compatible"`
- Both refer to the same concept (Chat Completions API)

This makes code harder to grep and reason about. Standardise on one term.

### C2 — `assistantHistoryItem` always sends `reasoning_content: ""`

In `openai-client.ts`:

```ts
items.push({ role: "assistant", content: message.content, reasoning_content: reasoning?.text ?? "" });
```

Sending an empty string `reasoning_content` on every assistant message bloats the context for providers that don't use it. The comment says "DeepSeek requires it", but the empty string for non-DeepSeek messages is unnecessary. Consider only including `reasoning_content` when it's non-empty.

### C3 — `MinimalTaskGrader` is a pointless re-export alias

```ts
export const MinimalTaskGrader = CompositeTaskGrader;
```

No code uses `MinimalTaskGrader`. If it's for backward compat, document it. If not, remove it.

### C4 — `benchmark/grader.ts` now exists only as a re-export

The entire file is now:

```ts
export { CompositeTaskGrader, MinimalTaskGrader } from "./graders/index.js";
```

Consider removing the file entirely and updating imports. If kept for backward compat, add a `@deprecated` JSDoc.

### C5 — `reasoning.ts` logic has subtle semantics

`shouldReturnReasoning` and `shouldSendReasoningHistory` both check `policy.enabled`, but in different order and with slightly different logic:

```ts
// shouldReturnReasoning (new):
if (policy.returnContent === "never") return false;
// ... later:
return policy.enabled || toolCalls.length > 0 || ...;
```

```ts
// shouldSendReasoningHistory (new):
if (policy.providerStyle === "deepseek" || ...) return true;
if (policy.sendHistory === "never") return false;
// ...
return policy.enabled;
```

The guard clauses are inconsistent: one checks `providerStyle` first, the other checks `returnContent` first. This works but is fragile — a reader could easily mistake the intent. Adding a comment block explaining the precedence would help.

### C6 — `generator.ts` has hardcoded Chinese prompts and dimension names

The dimension names are Chinese (`工具编排`, `上下文压缩`, etc.) hardcoded in the source. The file imports a template from `tasks/generation-prompt.md` which probably has Chinese content too. If this project ever needs i18n, these strings will need extraction. Consider a `DIMENSION_LABELS` map and a prompt builder function.

---

## OK — code that looks clean

### OK1 — Grader registry pattern

The `GraderRegistry` / `createDefaultRegistry` pattern in `graders/registry.ts` is clean, extensible, and follows good separation of concerns. Each grader is a single-purpose class registered by method name.

### OK2 — `openai-chat-client.ts` structure

Despite the code duplication with `openai-client.ts`, the standalone `OpenAIChatModelClient` class is well-structured. The streaming implementation is self-contained, error handling is consistent, and the flow is easy to follow.

### OK3 — `runner.ts` error handling

The `runTaskWithoutClosing` method correctly catches errors, distinguishes timeout vs abort vs error via `runErrorStatus`, and populates trace events consistently. Good separation of concerns between runtime execution, grading, and trace recording.

### OK4 — Evolution CLI commands

The `handleEvolveGenerate` and `handleEvolveAuto` commands in `commands.ts` have a clear iterative structure. The sorting `compareEvolutionResults` for auto mode is sensible.

### OK5 — `context-view.ts` tool pair normalization

The `normalizeToolPairOrder` and `stripDanglingToolCalls` functions are well-documented and handle a genuine problem (reordered tool call/result entries). The logic is careful about only filtering tool_calls whose results exist.

---

## Summary

| Category | Count | Severity |
|---|---|---|
| **Blockers** | 1 | Must fix before merge |
| **Improvements** | 5 | Should fix |
| **Concerns** | 6 | Discuss |
| **OK** | 5 | No action needed |

The biggest actionable items are: deduplicate the interfaces in `benchmark/types.ts` (blocker), extract shared helpers to reduce the 8-way code duplication (I1), and fix the fixture teardown quoting (I3).
