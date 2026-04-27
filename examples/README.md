# evolving-agent examples

Build the project first:

```bash
npm run build
```

Discover models from a local OpenAI-compatible endpoint:

```bash
node dist/cli.js models discover \
  --provider local \
  --base-url http://localhost:8317/v1 \
  --api-key 12345678
```

Run one task:

```bash
node dist/cli.js run \
  --agent examples/agents/basic.json \
  --task examples/tasks/smoke.json \
  --provider local \
  --model gpt-5.4-mini \
  --base-url http://localhost:8317/v1 \
  --api-key 12345678
```

Run a benchmark suite:

```bash
node dist/cli.js benchmark \
  --suite examples/suites/smoke.json \
  --agent examples/agents/basic.json \
  --provider local \
  --model gpt-5.4-mini \
  --base-url http://localhost:8317/v1 \
  --api-key 12345678
```

Add `--json` to any command for machine-readable output.
