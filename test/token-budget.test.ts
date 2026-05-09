import { describe, expect, it } from "vitest";
import { BudgetTracker, parseTokenBudgetSyntax, shouldAutoContinue } from "../src/runtime/token-budget.js";

describe("parseTokenBudgetSyntax", () => {
	it("parses +500k", () => {
		expect(parseTokenBudgetSyntax("+500k")).toBe(500_000);
	});

	it("parses +1M", () => {
		expect(parseTokenBudgetSyntax("+1M")).toBe(1_000_000);
	});

	it("parses +2m (lowercase)", () => {
		expect(parseTokenBudgetSyntax("+2m")).toBe(2_000_000);
	});

	it("parses raw number +100000", () => {
		expect(parseTokenBudgetSyntax("+100000")).toBe(100_000);
	});

	it("returns undefined for no + prefix", () => {
		expect(parseTokenBudgetSyntax("500k")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(parseTokenBudgetSyntax("")).toBeUndefined();
	});

	it("returns undefined for zero", () => {
		expect(parseTokenBudgetSyntax("+0")).toBeUndefined();
	});

	it("returns undefined for negative", () => {
		expect(parseTokenBudgetSyntax("+-500")).toBeUndefined();
	});

	it("handles decimal +1.5k", () => {
		expect(parseTokenBudgetSyntax("+1.5k")).toBe(1500);
	});
});

describe("BudgetTracker", () => {
	it("starts with zero consumption", () => {
		const tracker = new BudgetTracker({ totalBudget: 100_000 });
		expect(tracker.consumed()).toBe(0);
		expect(tracker.remaining()).toBe(100_000);
		expect(tracker.depleted()).toBe(false);
	});

	it("tracks consumption", () => {
		const tracker = new BudgetTracker({ totalBudget: 100_000 });
		tracker.consume({ inputTokens: 5000, outputTokens: 2000 }, 1);
		expect(tracker.consumed()).toBe(7000);
		expect(tracker.remaining()).toBe(93000);
	});

	it("detects depletion", () => {
		const tracker = new BudgetTracker({ totalBudget: 10_000 });
		tracker.consume({ inputTokens: 6000, outputTokens: 4000 }, 1);
		expect(tracker.depleted()).toBe(true);
		expect(tracker.remaining()).toBe(0);
	});

	it("tracks no-tool-call streak", () => {
		const tracker = new BudgetTracker({ totalBudget: 100_000 });
		tracker.consume({ inputTokens: 1000, outputTokens: 500 }, 0);
		tracker.consume({ inputTokens: 1000, outputTokens: 500 }, 0);
		tracker.consume({ inputTokens: 1000, outputTokens: 500 }, 0);
		expect(tracker.diminishingReturns(3)).toBe(true);
	});

	it("resets streak when tool calls happen", () => {
		const tracker = new BudgetTracker({ totalBudget: 100_000 });
		tracker.consume({ inputTokens: 1000, outputTokens: 500 }, 0);
		tracker.consume({ inputTokens: 1000, outputTokens: 500 }, 1);
		tracker.consume({ inputTokens: 1000, outputTokens: 500 }, 0);
		expect(tracker.diminishingReturns(2)).toBe(false);
	});

	it("snapshot reflects current state", () => {
		const tracker = new BudgetTracker({ totalBudget: 50_000 });
		tracker.consume({ inputTokens: 3000, outputTokens: 1000 }, 2);
		const snap = tracker.snapshot();
		expect(snap.consumedInputTokens).toBe(3000);
		expect(snap.consumedOutputTokens).toBe(1000);
		expect(snap.lastTurnToolCallCount).toBe(2);
	});
});

describe("shouldAutoContinue", () => {
	it("returns continue when under budget and under max turns", () => {
		const tracker = new BudgetTracker({ totalBudget: 100_000 });
		tracker.consume({ inputTokens: 1000, outputTokens: 500 }, 1);
		expect(shouldAutoContinue(tracker, 1, undefined, 3)).toEqual({ continue: true });
	});

	it("stops on budget depleted", () => {
		const tracker = new BudgetTracker({ totalBudget: 5000 });
		tracker.consume({ inputTokens: 3000, outputTokens: 2000 }, 1);
		expect(shouldAutoContinue(tracker, 1, undefined, 3)).toEqual({ continue: false, reason: "budget_depleted" });
	});

	it("stops on diminishing returns", () => {
		const tracker = new BudgetTracker({ totalBudget: 100_000 });
		tracker.consume({ inputTokens: 500, outputTokens: 200 }, 0);
		tracker.consume({ inputTokens: 500, outputTokens: 200 }, 0);
		tracker.consume({ inputTokens: 500, outputTokens: 200 }, 0);
		expect(shouldAutoContinue(tracker, 3, undefined, 3)).toEqual({ continue: false, reason: "diminishing_returns" });
	});

	it("stops on max turns", () => {
		const tracker = new BudgetTracker({ totalBudget: 100_000 });
		tracker.consume({ inputTokens: 500, outputTokens: 200 }, 1);
		expect(shouldAutoContinue(tracker, 3, 3, 3)).toEqual({ continue: false, reason: "max_turns" });
	});
});
