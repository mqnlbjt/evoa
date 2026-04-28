import { describe, expect, it } from "vitest";
import { parseCliDefaults } from "../src/cli/config.js";

describe("parseCliDefaults", () => {
	it("parses supported CLI defaults", () => {
		const result = parseCliDefaults({
			agentPath: "agent.json",
			provider: "local",
			model: "model",
			baseURL: "url",
			apiKey: "key",
			providerFormat: "anthropic-messages",
			toolProfile: "coding",
			sessionDir: "sessions",
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.defaults).toEqual({
			agentPath: "agent.json",
			provider: "local",
			model: "model",
			baseURL: "url",
			apiKey: "key",
			providerFormat: "anthropic-messages",
			toolProfile: "coding",
			sessionDir: "sessions",
		});
	});

	it("reports invalid config values", () => {
		const result = parseCliDefaults({ providerFormat: "wat", toolProfile: "wat" });

		expect(result.defaults).toEqual({});
		expect(result.diagnostics).toEqual([
			"config.providerFormat must be openai-responses or anthropic-messages",
			"config.toolProfile must be read-only, coding, benchmark-sandbox, or dangerous",
		]);
	});
});
