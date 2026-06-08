# Correctness Review Report

Review date: 2026-06-04
Base: git diff (30 files changed, +769/-242)
Typecheck: 0 new errors (7 pre-existing, all in unchanged test files)
Scope: full diff inspection of all changed source files

---

## BLOCKERS — must be fixed before merging

### B1. Duplicate interface declarations in `src/benchmark/types.ts`

`AgentRuntimeExecutor`, `TaskGrader`, and `TaskGraderOptions` are each declared **twice** in the same file. This is the diff's fault: lines were added in two separate insertion blocks that created duplicates.

- `AgentRuntimeExecutor` — appears at line ~91 and again at line ~105
- `TaskGrader` — appears at line ~96 and again at line ~108
- `TaskGraderOptions` — appears at line ~101 and again at line ~110

While TypeScript declaration merging avoids a type error, the duplicates are dead code that will confuse maintainers. Remove the second set of declarations.

### B2. `benchmark/types.ts` `TaskGraderOptions` import — `ModelClient` may be imported

The two duplicate `TaskGraderOptions` blocks both reference `ModelClient` from `../../models/types.js`. The existing import at the top of the file already brings in `ModelClient`, so this is not a resolution error, but the duplicates themselves must be removed (see B1).

---

## BUGS — definite bugs worth fixing now

### F1. `reasoning_content` sent unconditionally in OpenAI Responses API path

**File:** `src/models/openai-client.ts`, function `assistantHistoryItem` (line ~318 in new code)

```typescript
items.push({ role: "assistant", content: message.content, reasoning_content: reasoning?.text ?? "" });
```

**Issue:** This function is shared between the OpenAI Responses API path (`useChatCompletions === false`) and the chat-compatible path. The old code only included `reasoning_content` when `includeReasoning && reasoning` was true. The new code **always** includes `reasoning_content: ""` when the assistant message has content, reasoning, or tool calls — regardless of `alwaysIncludeReasoning`.

For the legacy OpenAI Responses API, `reasoning_content` is **not a valid input field**. Sending it may:
- Cause a 400 error from the API
- Be silently dropped (less likely with Responses API strict schema)

**Fix:** Only include `reasoning_content` when `includeReasoning` (the parameter) is true AND reasoning exists, restoring the original conditional spread.

### F2. `openai-chat-client.ts` — duplicate `normalizeUsage` / drift risk

**File:** `src/models/openai-chat-client.ts`, lines ~205-250

The file defines its own `normalizeUsage`, `asRecord`, `toArray`, `stringField`, `numberField`, `numberAny`, `sumKnown`, and `normalizeBaseURL` helper functions — all of which are duplicates of the same functions in `openai-client.ts`.

**Issue:** This duplication will inevitably drift. If `normalizeUsage` in `openai-client.ts` is fixed or enhanced, `openai-chat-client.ts` won't benefit.

**Fix:** Extract shared utilities to a common module (e.g., `src/models/utils.ts`) and import from both files.

### F3. `artifact.ts` grader — `output` parameter declared but `_output` unused — missed artifact field

**File:** `src/benchmark/graders/artifact.ts`, line 11

```typescript
async grade(_agent: AgentSpec, task: TaskSpec, _output: { answer?: string }): Promise<ScoreResult> {
```

**Issue:** The `ArtifactGrader` completely ignores the `output` parameter. If artifacts are provided via `output.artifacts`, they would be missed. The grader only reads artifacts from the filesystem at `config.path` relative to `workspaceDir`. This means tasks that produce in-memory artifacts (passed through `TaskExecutionOutput.artifacts`) cannot be scored by `ArtifactGrader` unless they're also written to disk.

Additionally, the type `{ answer?: string }` doesn't include `artifacts?: Record<string, string>`, narrowing the interface from `TaskExecutionOutput`.

**Fix:** Either:
- Support reading from `output.artifacts` as a fallback before checking disk, or
- Document that `ArtifactGrader` only checks disk artifacts and the task runner must write them

### F4. `normalizeToolPairOrder` — orphan tool results are reordered, potentially breaking context chronology

**File:** `src/runtime/context-view.ts`, function `normalizeToolPairOrder`

When an assistant message with tool calls is found, matching tool results are collected, and **all non-matching entries** (including orphan tool results from a previous turn) go into `displaced`. After the loop, `displaced` is appended **after** the matching tool results:

```typescript
output.push(...toolResults);
output.push(...displaced);
```

**Issue:** If there are orphan tool results (tool results whose `callIds` don't match the current assistant's tool_calls), they will be moved **after** the current tool pair instead of staying in their original chronological position. This breaks the temporal ordering of the context.

**Reproduction scenario:**
1. Assistant A calls tool_1, tool_2
2. Tool result for tool_1 arrives (matching)
3. An orphan tool result from a previous compacted turn arrives (not matching any remaining call ID)
4. Tool result for tool_2 arrives (matching)

Current behavior: orphan tool result goes into `displaced`, appears AFTER tool_1 and tool_2 results in output.

**Fix:** Preserve chronological ordering: emit `toolResults` and `displaced` in their original order, or better, don't pull orphans forward at all.

### F5. `duplicate `import` — `AgentRuntimeExecutor` re-exported via two paths without dedup

**File:** `src/index.ts`

```typescript
export * from "./benchmark/grader.js";         // re-exports CompositeTaskGrader
export * from "./benchmark/graders/index.js";  // re-exports CompositeTaskGrader again
```

**Issue:** `benchmark/grader.ts` re-exports from `./graders/index.js`, and `index.ts` also directly exports from `./graders/index.js`. The `CompositeTaskGrader` class is re-exported twice. While JS allows this (ESM deduplicates), it's confusing and can cause issues with barrel-import-aware tools.

---

## CONCERNS — potential issues to discuss

### C1. `shouldReturnReasoning` semantic shift when `enabled === false`

**File:** `src/models/reasoning.ts`

| Scenario | Old | New |
|---|---|---|
| `enabled=false, returnContent="needed", toolCalls.length>0` | `false` | `true` |
| `enabled=false, returnContent="always"` | `false` | `true` |

The first scenario is the most impactful: when reasoning is disabled (`mode=off` or `level=off`), but there are tool calls in the response, the new code returns the reasoning anyway. The old code explicitly blocked this.

**Judgment:** The second case (`returnContent="always"`) is arguably intentional — if the config explicitly requests it, respect it. The first case should be reviewed: is it intentional that disabled-reasoning models still return reasoning content when tool calls exist? If yes, the `policy.enabled` check in the OR chain is redundant and should be removed for clarity. If no, the old `!policy.enabled` guard should be restored.

### C2. `shouldSendReasoningHistory` completely redesigned — needs test coverage

**File:** `src/models/reasoning.ts`

Old: `return toolCalls.length > 0 && (policy.providerStyle === "deepseek" || policy.providerStyle === "chat-compatible");`

New: `return policy.enabled;` (for the "needed" fallthrough case)

**Issue:** For Anthropic and OpenAI Responses styles in "needed" mode, old code returned `false` (never send reasoning history), new code returns `true` if reasoning is enabled. This means more reasoning data is sent in history, which may increase token usage significantly without functional benefit for some providers.

**Recommendation:** Verify with the team that this broader inclusion is intentional. Add unit tests for the matrix of `providerStyle × sendHistory × enabled`.

### C3. `isChatCompletionsBaseURL` heuristic is fragile

**File:** `src/models/openai-client.ts`

```typescript
function isChatCompletionsBaseURL(baseURL: string | undefined): boolean {
    if (!baseURL) return false;
    const normalized = baseURL.replace(/\/+$/, "").toLowerCase();
    return !normalized.endsWith("api.openai.com/v1") && !normalized.endsWith("api.openai.com");
}
```

**Issue:** A custom proxy at `https://myproxy.com/api.openai.com/v1/` would be misidentified as NOT chat-completions (because of the `.endsWith` match on the full normalized string). More importantly, this conflates "is this an OpenAI API" with "should I use chat completions format". A user may have a non-OpenAI provider that uses the Responses API format (e.g., a custom proxy), or an OpenAI deployment that only supports chat completions (e.g., Azure).

**Recommendation:** This decision should be driven by the `ProviderFormat` or an explicit config flag, not by URL heuristics.

### C4. `alwaysIncludeReasoning` condition in `openai-client.ts` `buildInput`

```typescript
const alwaysIncludeReasoning = policy.providerStyle === "deepseek" || policy.providerStyle === "chat-compatible";
```

**Issue:** This is used to decide whether to include assistant messages that only have reasoning (no tool calls, no text). But `providerStyle` "chat-compatible" is broad — it could match third-party providers that don't support `reasoning_content` at all. The assumption that "chat-compatible → always include reasoning" needs a safety net.

### C5. `context-view.ts` — `stripDanglingToolCalls` duplicates entries after `normalizeToolPairOrder`

**File:** `src/runtime/context-view.ts`

The pipeline is: `normalizeToolPairOrder(entries)` → `stripDanglingToolCalls(normalized.map(e => e.message))`.

`normalizeToolPairOrder` already pairs tool calls with their results. Then `stripDanglingToolCalls` runs on the **messages** (stripped of entry metadata), checking if any tool_call IDs lack a corresponding tool_result across the entire message list. Since `normalizeToolPairOrder` already pairs things up, `stripDanglingToolCalls` should be a no-op in most cases. But they operate on different data structures (entries vs messages), and `stripDanglingToolCalls` may also strip valid tool_calls if a corresponding tool_result message was omitted by the compaction/trim logic.

**The danger:** If `normalizeToolPairOrder` reorders entries to pair tool calls with results, but then context trimming removes some entries before messages are extracted, `stripDanglingToolCalls` could strip tool calls whose results lived in now-removed entries. This would silently corrupt the conversation.

**Recommendation:** Add a test case where:
1. An assistant message has tool calls
2. Some tool results exist but are beyond the trim cutoff
3. Verify the remaining tool calls are NOT stripped

### C6. `openai-chat-client.ts` — `reasoning_content: ""` sent on ALL assistant messages

**File:** `src/models/openai-chat-client.ts`, line ~80

```typescript
messages.push({
    role: "assistant",
    content: message.content || null,
    reasoning_content: reasoning?.text ?? "",
    ...
});
```

**Issue:** Every assistant message in the history now includes `reasoning_content`, even those with empty reasoning. Some providers (e.g., non-DeepSeek chat-compatible endpoints) may reject `reasoning_content` as an unrecognized field, or misinterpret an empty string. The design comment says "it is safely ignored otherwise" but this is not guaranteed by all providers.

**Recommendation:** Only set `reasoning_content` when the reasoning block actually has text content (`reasoning?.text?.length > 0`), or gate it behind a provider-specific flag.

### C7. CLI: `--auto` without `--generate` gives confusing error message

**File:** `src/cli/args.ts`

```typescript
if (autoIterations !== undefined) {
    const baselineAgentPath = requireFlag(flags, "--baseline-agent", diagnostics);
    const suitePath = requireFlag(flags, "--suite", diagnostics);
    if (!baselineAgentPath || !suitePath || !generatePath) {
        if (!generatePath) diagnostics.push("--auto requires --generate <file>");
        return undefined;
    }
    ...
}
```

**Issue:** If `--auto 5` is passed but no `--generate` is given, the diagnostic says `"--auto requires --generate <file>"`. But if `--baseline-agent` or `--suite` is also missing, those diagnostics are not emitted because the function returns early. The user has to iteratively discover missing arguments.

**Suggestion:** Collect all missing-flag diagnostics before returning.

### C8. `ExactScoringConfig` declares `normalizeWhitespace` but `ExactGrader` doesn't implement it

**File:** `src/benchmark/graders/types.ts` (ExactScoringConfig) vs `exact.ts` (ExactGrader)

`types.ts` declares `normalizeWhitespace?: boolean` in `ExactScoringConfig`, but `exact.ts` never reads or uses it. This is a case of config/implementation drift.

---

## OK — things that look correct

### O1. `reasoning.ts` — `resolveReasoningPolicy`
Correctly resolves the full policy matrix from model options. The `providerStyle` mapping and `requestField` inference based on style are correct. No bugs found.

### O2. `AnthropicModelClient` — streaming signature_delta handling
The new `signature_delta` handling in the streaming SSE parser correctly accumulates signatures from both `content_block_delta` (thinking content) and `content_block_start` (thinking block-level signature). The `parseThinkingSignature` function correctly reads signatures from both `thinking` and `redacted_thinking` blocks. No bugs found.

### O3. `AnthropicModelClient` — `toAnthropicMessage` reasoning reconstruction for history
The new implementation reconstructs `thinking` blocks from stored `reasoning` content blocks, including signature preservation. The `alwaysIncludeReasoning` flag correctly adds a filler `thinking: ""` block when needed. No bugs found.

### O4. `AnthropicModelClient` — buildBody `alwaysIncludeReasoning` (non-streaming)
The `alwaysIncludeReasoning` flag correctly flows from `buildBody` → `toAnthropicMessages` → `toAnthropicMessage`. For non-streaming, the reasoning is already in the returned content, so this only affects the filler logic. No bugs found.

### O5. `OpenAIChatModelClient` — streaming implementation
The streaming implementation correctly handles SSE line-by-line parsing, `[DONE]` termination, and tool call accumulation via `chatToolCalls` Map. The `joinUnique` dedup logic for reasoning parts matches the existing pattern in `openai-client.ts`. No bugs found.

### O6. `GraderRegistry` and factory pattern
The registry-based grader dispatch correctly separates concerns. `createDefaultRegistry` registers all 6 methods (exact, rubric, llm-judge, command, artifact, custom). The `CompositeTaskGrader` in `graders/index.ts` correctly delegates to the registry. No bugs found.

### O7. `src/tasks/validation.ts` — new scoring method validation
The `artifact` and `command` scoring config validations are correct:
- `command`: requires non-empty `config.command`, validates `exitCode` (integer) and `timeoutMs` (positive number)
- `artifact`: requires non-empty `config.path`
- Error messages are clear and consistent

No bugs found.

### O8. CLI args — `buildEvolveCommon` vs direct `buildEvolve` for standard mode
The refactored CLI correctly routes to `buildEvolveCommon` for auto/generate modes, while standard mode builds the command inline. The two paths produce structurally equivalent `EvolveCommand` objects. No bugs found.

### O9. TUI — evolution view and `/evolve-history` command
The new `renderEvolveView`, `/evolve` view switch, and `/evolve-history <path>` command are correctly wired through `state.ts`, `renderer.ts`, `slash-commands.ts`, and `turn-controller.ts`. The `EvolutionHistoryRecord` type is consistently used. No bugs found.

### O10. `context-view.ts` — `groupedEntries` and `adjustKeepStartToToolBoundary`
These functions correctly handle tool-pair grouping during context trimming. No regressions from the new `normalizeToolPairOrder` function since these operate on the raw `SessionEntry[]` before normalization. No bugs found.

---

## Summary

| Severity | Count | Key issues |
|---|---|---|
| **BLOCKER** | 1 | B1: Duplicate interfaces in `types.ts` |
| **BUG** | 5 | F1-F5: Unconditional `reasoning_content` in Responses API, duplicate helpers, artifact grader ignores output, orphan reordering, double re-export |
| **CONCERN** | 8 | C1-C8: Semantic shifts, fragile URL heuristic, test gaps, potential token waste |
| **OK** | 10 | O1-O10: Correct implementations |

Total files inspected: 30 changed + 10 new (graders/, openai-chat-client.ts)
Total new typecheck errors: 0 (7 pre-existing)
