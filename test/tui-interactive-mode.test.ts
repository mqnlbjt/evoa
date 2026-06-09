import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../src/tui/interactive-mode.js";
import { FakeTerminal } from "../src/tui/fake-terminal.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { fakeOpenAIClient, fakeQueuedOpenAIClient, fakeToolOpenAIClient, nextId } from "./helpers/cli.js";

function frameText(terminal: FakeTerminal): string {
	return terminal.lastFrame().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const agentPath = "/home/wyq/data/pi/evolving-agent/examples/agents/basic.json";
const noMemoryAgentPath = "/home/wyq/data/pi/evolving-agent/test/fixtures/tui-basic-no-memory.json";

describe("InteractiveMode", () => {
	it("renders, submits a chat turn, handles slash commands, and exits", async () => {
		const terminal = new FakeTerminal();
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		terminal.emitInput("hello");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("┃ LLM  hi") && frameText(terminal).includes("status: done"));
		expect(frameText(terminal)).toContain("┃ You  hello");
		terminal.emitInput("/help");
		terminal.emitInput("\n");
		await waitFor(() => terminal.outputText().includes("/status"));
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
		expect(terminal.isDisposed()).toBe(true);
	});

	it("renders configured MCP server count in the header", async () => {
		const terminal = new FakeTerminal({ width: 120, height: 8 });
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", mcpServers: { docs: { type: "stdio", command: "node" } }, providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeOpenAIClient("hi"), toolRegistry: new ToolRegistry(), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => frameText(terminal).includes("profile: dangerous | mcp: 1"));
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
	});

	it("keeps the terminal cursor on the input line", async () => {
		const terminal = new FakeTerminal({ width: 80, height: 12 });
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		terminal.emitInput("你好");
		await waitFor(() => frameText(terminal).includes("> 你好"));
		const inputRow = frameText(terminal).split("\n").length;
		expect(terminal.cursorPosition()).toEqual({ row: inputRow, column: 7 });
		terminal.emitInput("\u0003");
		terminal.emitInput("\u0003");
		await expect(exit).resolves.toBe(0);
	});

	it("scrolls log history with PageUp and PageDown", async () => {
		const terminal = new FakeTerminal({ width: 80, height: 10 });
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath: noMemoryAgentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeQueuedOpenAIClient(["old response", "middle response", "latest response"]), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		for (const [input, answer] of [["first", "old response"], ["second", "middle response"], ["third", "latest response"]] as const) {
			terminal.emitInput(input);
			terminal.emitInput("\n");
			await waitFor(() => frameText(terminal).includes(`┃ LLM  ${answer}`) && frameText(terminal).includes("status: done"));
		}
		expect(frameText(terminal)).toContain("┃ LLM  latest response");
		terminal.emitInput("\x1b[5~");
		await waitFor(() => frameText(terminal).includes("┃ You  second"));
		expect(frameText(terminal)).toContain("┃ LLM  middle response");
		expect(frameText(terminal)).not.toContain("┃ LLM  latest response");
		terminal.emitInput("\x1b[5~");
		await waitFor(() => frameText(terminal).includes("┃ You  first"));
		expect(frameText(terminal)).toContain("┃ LLM  old response");
		expect(frameText(terminal)).not.toContain("┃ LLM  middle response");
		terminal.emitInput("\x1b[6~");
		await waitFor(() => frameText(terminal).includes("┃ LLM  middle response"));
		terminal.emitInput("\x1b[6~");
		await waitFor(() => frameText(terminal).includes("┃ LLM  latest response"));
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
	});

	it("disposes the terminal when startup fails", async () => {
		const terminal = new FakeTerminal();
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath: "/missing/agent.json", provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() },
			now: () => 1,
		});

		await expect(mode.start()).rejects.toThrow();
		expect(terminal.isDisposed()).toBe(true);
		expect(terminal.isRawMode()).toBe(false);
	});

	it("shows runtime errors and continues accepting slash commands", async () => {
		const terminal = new FakeTerminal();
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath: noMemoryAgentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => ({ responses: { async create() { throw new Error("model exploded"); } } }), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		terminal.emitInput("boom");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("error: model exploded"));
		expect((frameText(terminal).match(/model exploded/g) ?? []).length).toBe(2);
		terminal.emitInput("/status");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("· Info session:"));
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
	});

	it("rejects a second submitted turn while a model request is running", async () => {
		const terminal = new FakeTerminal();
		let releaseFirstRequest!: () => void;
		let calls = 0;
		const firstRequestStarted = defer<void>();
		const firstRequestReleased = new Promise<void>((resolve) => { releaseFirstRequest = resolve; });
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath: noMemoryAgentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => ({ responses: { async create() { calls += 1; if (calls === 1) { firstRequestStarted.resolve(); await firstRequestReleased; } return { output_text: "done" }; } } }), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		terminal.emitInput("first");
		terminal.emitInput("\n");
		await firstRequestStarted.promise;
		terminal.emitInput("second");
		terminal.emitInput("\n");
		terminal.emitInput("third");
		terminal.emitInput("\n");
		await waitFor(() => terminal.outputText().includes("A turn is already running") && frameText(terminal).includes("status: busy"));
		expect((frameText(terminal).match(/A turn is already running/g) ?? []).length).toBe(1);
		releaseFirstRequest();
		await waitFor(() => frameText(terminal).includes("┃ LLM  done") && frameText(terminal).includes("status: done"));
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
	});

	it("interrupts a running turn with Ctrl-C without exiting", async () => {
		const terminal = new FakeTerminal();
		const requestStarted = defer<void>();
		let capturedSignal: AbortSignal | undefined;
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath: noMemoryAgentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: {
				openAIClientFactory: () => ({ responses: { async create(_params: unknown, options?: { signal?: AbortSignal }) { capturedSignal = options?.signal; requestStarted.resolve(); return await new Promise((_, reject) => capturedSignal?.addEventListener("abort", () => reject(capturedSignal?.reason), { once: true })); } } }),
				now: () => 1,
				createId: nextId(),
			},
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		terminal.emitInput("long");
		terminal.emitInput("\n");
		await requestStarted.promise;

		terminal.emitInput("\u0003");

		await waitFor(() => frameText(terminal).includes("Turn interrupted") && frameText(terminal).includes("status: done"));
		expect(capturedSignal?.aborted).toBe(true);
		expect(frameText(terminal)).not.toContain("error:");
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
	});

	it("reports unknown slash commands and clamps the cursor in narrow terminals", async () => {
		const narrowTerminal = new FakeTerminal({ width: 6, height: 8 });
		const narrowMode = new InteractiveMode({
			terminal: narrowTerminal,
			command: { kind: "tui", format: "human", agentPath: noMemoryAgentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const narrowExit = narrowMode.start();
		await waitFor(() => narrowTerminal.outputText().includes("evoa"));
		narrowTerminal.emitInput("你好世界");
		await waitFor(() => frameText(narrowTerminal).includes("> 你好"));
		expect(narrowTerminal.cursorPosition().column).toBe(6);
		narrowTerminal.emitInput("\u0003");
		narrowTerminal.emitInput("\u0003");
		await expect(narrowExit).resolves.toBe(0);

		const terminal = new FakeTerminal();
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath: noMemoryAgentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		terminal.emitInput("/wat");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("Unknown command: /wat"));
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
	});

	it("does not full clear on ordinary rerenders after the first frame", async () => {
		const terminal = new FakeTerminal();
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath: noMemoryAgentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		expect(terminal.clearCount()).toBe(1);
		terminal.emitInput("hello");
		await waitFor(() => frameText(terminal).includes("> hello"));
		terminal.emitInput("\u0003");
		await waitFor(() => frameText(terminal).includes("Input cancelled"));
		expect(terminal.clearCount()).toBe(1);
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
	});

	it("rerenders on resize and keeps cursor aligned with the resized input", async () => {
		const terminal = new FakeTerminal({ width: 80, height: 12 });
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath: noMemoryAgentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		terminal.emitInput("hello world");
		await waitFor(() => frameText(terminal).includes("> hello world"));
		expect(terminal.cursorPosition().column).toBe(14);
		terminal.resize({ width: 8, height: 8 });
		await waitFor(() => terminal.cursorPosition().column === 8);
		expect(terminal.clearCount()).toBe(2);
		expect(frameText(terminal)).toContain("> hello");
		terminal.emitInput("\u0003");
		terminal.emitInput("\u0003");
		await expect(exit).resolves.toBe(0);
	});

	it("does not repeat visible log lines across page-sized history scrolls", async () => {
		const terminal = new FakeTerminal({ width: 80, height: 10 });
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath: noMemoryAgentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeQueuedOpenAIClient(["one", "two", "three"]), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		for (const [input, answer] of [["alpha", "one"], ["beta", "two"], ["gamma", "three"]] as const) {
			terminal.emitInput(input);
			terminal.emitInput("\n");
			await waitFor(() => frameText(terminal).includes(`┃ LLM  ${answer}`) && frameText(terminal).includes("status: done"));
		}
		const latestLines = logLines(frameText(terminal));
		terminal.emitInput("\x1b[5~");
		await waitFor(() => frameText(terminal).includes("┃ You  beta"));
		const previousLines = logLines(frameText(terminal));
		expect(previousLines.some((line) => latestLines.includes(line))).toBe(false);
		terminal.emitInput("\x1b[5~");
		await waitFor(() => frameText(terminal).includes("┃ You  alpha"));
		const oldestLines = logLines(frameText(terminal));
		expect(oldestLines.some((line) => previousLines.includes(line))).toBe(false);
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
	});

	it("supports input history navigation and clear command", async () => {
		const terminal = new FakeTerminal();
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath: noMemoryAgentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeQueuedOpenAIClient(["one", "two"]), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		terminal.emitInput("alpha");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("┃ LLM  one"));
		terminal.emitInput("beta");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("┃ LLM  two"));
		terminal.emitInput("\x1b[A");
		await waitFor(() => frameText(terminal).includes("> beta"));
		terminal.emitInput("\x1b[A");
		await waitFor(() => frameText(terminal).includes("> alpha"));
		terminal.emitInput("\x1b[B");
		await waitFor(() => frameText(terminal).includes("> beta"));
		terminal.emitInput("\u0003");
		terminal.emitInput("/clear");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("· Info Cleared"));
		expect(frameText(terminal)).not.toContain("┃ LLM  two");
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
	});

	it("starts a new session with /new", async () => {
		const terminal = new FakeTerminal();
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath: noMemoryAgentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeQueuedOpenAIClient(["one", "two"]), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		terminal.emitInput("alpha");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("┃ LLM  one"));
		terminal.emitInput("/new");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("Started new session: id-"));
		expect(frameText(terminal)).not.toContain("alpha");
		expect(frameText(terminal)).not.toContain("one");
		terminal.emitInput("beta");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("┃ LLM  two"));
		expect(frameText(terminal)).toContain("┃ You  beta");
		expect(frameText(terminal)).not.toContain("alpha");
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
	});

	it("renders tools, memory, stats, and trace pages", async () => {
		const terminal = new FakeTerminal({ width: 120, height: 40 });
		const mode = new InteractiveMode({
			terminal,
			command: { kind: "tui", format: "human", agentPath, provider: "local", model: "gpt-5.5", baseURL: "http://localhost:8317/v1", providerFormat: "openai-responses", toolProfile: "dangerous", providedFlags: { agentPath: true, provider: true, model: true, baseURL: true } },
			deps: { openAIClientFactory: () => fakeOpenAIClient("hi"), now: () => 1, createId: nextId() },
			now: () => 1,
		});
		const exit = mode.start();
		await waitFor(() => terminal.outputText().includes("evolving-agent"));
		terminal.emitInput("hello");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("┃ LLM  hi"));
		terminal.emitInput("/tools");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("read_file") && frameText(terminal).includes("memory_context"));
		terminal.emitInput("/memory");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("memory: enabled"));
		terminal.emitInput("/stats");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("STATS OVERVIEW") && frameText(terminal).includes("MODEL LATENCY"));
		expect(frameText(terminal)).toContain("view: stats");
		terminal.emitInput("/trace-page");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("TRACE EVENTS") && frameText(terminal).includes("model_response"));
		expect(frameText(terminal)).toContain("view: trace");
		terminal.emitInput("/chat");
		terminal.emitInput("\n");
		await waitFor(() => frameText(terminal).includes("┃ LLM  hi") && frameText(terminal).includes("view: chat"));
		terminal.emitInput("/exit");
		terminal.emitInput("\n");
		await expect(exit).resolves.toBe(0);
	});
});

function logLines(frame: string): string[] {
	return frame.split("\n").filter((line) => line.startsWith("┃") || line.startsWith("┆") || line.startsWith("·") || line.startsWith("!"));
}

function defer<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not met");
}
