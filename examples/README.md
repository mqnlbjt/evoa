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

Create `.evolving-agent/config.json` to avoid repeating defaults:

```json
{
  "agentPath": "examples/agents/basic.json",
  "provider": "local",
  "model": "gpt-5.4-mini",
  "baseURL": "http://localhost:8317/v1",
  "apiKey": "12345678"
}
```

Start a chat:

```bash
node dist/cli.js chat "hello"
```

Save and resume a chat session:

```bash
node dist/cli.js chat "remember this" --session demo
node dist/cli.js chat "continue" --resume demo
```

Session files store the agent/provider/model/base URL/tool profile startup context, but do not store API keys.

Run one task:

```bash
node dist/cli.js run \
  --task examples/tasks/smoke.json
```

Run a benchmark suite:

```bash
node dist/cli.js benchmark \
  --suite examples/suites/smoke.json
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
