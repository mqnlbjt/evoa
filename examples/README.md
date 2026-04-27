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

Generate deterministic evolution candidates from a baseline agent:

```js
import { loadAgentSpecFromFile, loadDeterministicCandidateGeneratorFromFile } from "./dist/index.js";

const agent = await loadAgentSpecFromFile("examples/agents/basic.json");
const generator = await loadDeterministicCandidateGeneratorFromFile("examples/generators/deterministic-smoke.json");
const candidates = await generator.generate(agent);

console.log(JSON.stringify(candidates, null, 2));
```

The deterministic generator does not call a model. It only materializes candidate agent specs that can be passed to the existing evolution engine or saved as candidate agent JSON.

Add `--json` to any command for machine-readable output.
