# evoa

> A lightweight, evaluable, verifiable, and self-evolving general-purpose Agent runtime.

`evoa` (from **evo**lving **a**gent) is a TypeScript framework for building and running AI agents with a focus on **measurable improvement**. It provides a full runtime, model client layer, tool system with permission policies, interactive TUI, memory management, benchmark evaluation, and an evolution engine for comparing agent versions.

## Architecture

```
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

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Start a chat session (requires a model endpoint)
npx evoa chat "Hello, what can you do?"

# Start interactive chat
npx evoa chat

# Run a benchmark
npx evoa benchmark --suite <suite.json> --agent <agent.json>

# Compare two agent versions
npx evoa evolve --baseline-agent <baseline.json> --candidate-agent <candidate.json> --suite <suite.json>

# Launch TUI
npx evoa tui

# Run tests
npm test
```

## Features

### Agent Runtime
- Multi-turn conversation loop with configurable `maxTurns` and timeout
- Context compression (LLM-summarized compaction)
- Micro-compaction (clean old tool results, keep recent ones)
- Context trimming (hard/aggressive/fallback-minimal strategies)
- Token budget management and compaction trigger

### Model Layer
- **OpenAI Responses API** — `OpenAIModelClient`
- **OpenAI Chat Completions API** — `OpenAIChatModelClient`
- **Anthropic Messages API** — `AnthropicModelClient`
- Local OpenAI/Anthropic compatible endpoints
- Purpose-based model routing (main, compaction, summary, memory, extraction)
- Provider-neutral tool call history for multi-turn conversations
- Reasoning support (thinking blocks, DeepSeek style, Anthropic thinking)
- Model auto-discovery via OpenAI-compatible `/v1/models`

### Tool System
- File operations: `read_file`, `list_dir`, `find_files`, `grep`
- Write operations: `write_file`, `edit_file`
- Bash execution with workspace/cwd sandbox
- Web fetch tool with timeout and output truncation
- Subagent invocation
- MCP integration (STDIO and HTTP transports)
- Permission policies: `allow` / `deny` / `ask` at agent and task level
- Tool profiles: `read-only`, `coding`, `benchmark-sandbox`, `dangerous`
- Output truncation (head-tail, head-only, UTF-8 safe)

### CLI
| Command | Description |
|---------|-------------|
| `chat` | Single or interactive conversation |
| `run` | Execute a single task from JSON |
| `benchmark` | Run a benchmark suite |
| `evolve` | Compare baseline vs candidate agent |
| `models discover` | Auto-discover models from an endpoint |
| `tui` | Launch the terminal UI |

Options: `--session`, `--resume`, `--tool-profile`, `--json`, `--report`

### TUI
- Markdown rendering, bash output display
- Interactive input editor with slash commands
- Multi-line input, turn history
- Viewport scrolling and render scheduling
- Evolution history viewer

### Benchmark & Evolution
- Suite/task runner with pass/fail, score, timeout, trace
- Multiple grader methods: exact, rubric, LLM-as-judge, command, artifact, composite
- Leaderboard with score summary
- Agent version comparison with delta score, delta pass rate
- Regression/improvement detection
- `accept` / `reject` / `needs-review` recommendation
- History store for tracking evolution decisions

### Verification
- Deterministic verifier checks: regression, error, timeout, denied tool-policy events
- Policy violations block auto-accept in evolution

### Memory
- Session-level and long-term memory
- LLM-driven memory extraction and merging
- Memory CRUD tools (save, recall, forget)
- Memory diff, replay, verification, and conflict resolution

### SOP (Standard Operating Procedure) Workflow
- DAG-based step execution with dependency ordering
- Precondition and verification hooks per step
- Built-in SOPs planned: code review, security review, test generation

### Session & Persistence
- Session save/resume with JSONL and JSON stores
- Trace replay and run diff
- Event-driven runtime observability

## Test Status

```bash
npm test              # 520 tests, ~7 known failures (pre-existing type issues)
```

Some integration tests require:
- A running OpenAI-compatible or Anthropic-compatible endpoint
- MCP servers for MCP-related tests
- `better-sqlite3` native module for SQLite memory tests

## Comparison

**vs Claude Code:** `evoa` is a lightweight runtime/framework rather than a full product. It provides the building blocks (runtime, model clients, tools, benchmark, evolution) but not the complete agent-as-a-product experience. The project intentionally omits OS-level sandboxing, background tasks, worktree isolation, and multi-agent coordination in favor of a simpler, more modular design.

**vs pi:** `evoa` shares the runtime/session/model layering philosophy but is standalone and more focused on self-evaluation and evolution. It does not copy pi's extension system, streaming abstractions, or OAuth infrastructure.

## Project Structure

```
src/
├── agents/       # Agent spec loading and validation
├── benchmark/    # Benchmark runner, grader, report, leaderboard
├── cli/          # CLI arg parsing, commands, config, chat service
├── evolution/    # Evolution engine, report, history store
├── mcp/          # MCP client, registry, adapter
├── memory/       # Memory manager, tools, extractor, stores
├── models/       # Model clients, registry, router, reasoning
├── replay/       # Trace replay, run diff
├── runtime/      # Agent runtime, session, loop, events
├── sessions/     # Run store, JSONL store, session store
├── sop/          # SOP workflow runner and validator
├── tasks/        # Task loader, validation
├── tools/        # Tool registry, policy, profiles, executors
├── tui/          # TUI state, renderer, interactive mode
└── index.ts      # Public API exports
```

## License

MIT — see [LICENSE](LICENSE).
