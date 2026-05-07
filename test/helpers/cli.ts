import type { OpenAIResponsesClient } from "../../src/models/openai-client.js";

export interface TestIO {
	stdout: { write: (chunk: string) => boolean };
	stderr: { write: (chunk: string) => boolean };
	stdoutText: () => string;
	stderrText: () => string;
}

export function createIO(): TestIO {
	let stdout = "";
	let stderr = "";
	return {
		stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
		stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
		stdoutText: () => stdout,
		stderrText: () => stderr,
	};
}

export async function* lines(values: string[]): AsyncIterable<string> {
	for (const value of values) yield value;
}

export function fakeOpenAIClient(answer: string): OpenAIResponsesClient {
	return { responses: { async create() { return { output_text: answer }; } } };
}

export function fakeQueuedOpenAIClient(answers: string[]): OpenAIResponsesClient {
	let index = 0;
	return {
		responses: {
			async create() {
				const answer = answers[Math.min(index, answers.length - 1)] ?? "";
				index += 1;
				return { output_text: answer };
			},
		},
	};
}

export function fakeToolOpenAIClient(toolName: string, input: unknown = { path: "note.txt" }, answer = "saw tool"): OpenAIResponsesClient {
	let calls = 0;
	return {
		responses: {
			async create() {
				calls += 1;
				if (calls === 1) {
					return { output_text: "", output: [{ type: "function_call", call_id: "call_1", name: toolName, arguments: JSON.stringify(input) }] };
				}
				return { output_text: answer };
			},
		},
	};
}

export function nextId(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}
