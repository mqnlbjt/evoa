import type { ModelUsage } from "../models/types.js";

export interface TokenBudgetConfig {
	totalBudget: number;
	diminishingReturnsMinTurns?: number;
	diminishingReturnsNoToolTurns?: number;
}

export interface BudgetTrackerState {
	consumedInputTokens: number;
	consumedOutputTokens: number;
	totalBudget: number;
	noToolCallStreak: number;
	lastTurnToolCallCount: number;
}

export class BudgetTracker {
	private state: BudgetTrackerState;

	constructor(config: TokenBudgetConfig) {
		this.state = {
			consumedInputTokens: 0,
			consumedOutputTokens: 0,
			totalBudget: config.totalBudget,
			noToolCallStreak: 0,
			lastTurnToolCallCount: 0,
		};
	}

	consume(usage: ModelUsage, toolCallCount: number): void {
		this.state.consumedInputTokens += usage.inputTokens ?? 0;
		this.state.consumedOutputTokens += usage.outputTokens ?? 0;
		this.state.lastTurnToolCallCount = toolCallCount;
		if (toolCallCount === 0) {
			this.state.noToolCallStreak += 1;
		} else {
			this.state.noToolCallStreak = 0;
		}
	}

	depleted(): boolean {
		return this.consumed() >= this.state.totalBudget;
	}

	remaining(): number {
		return Math.max(0, this.state.totalBudget - this.consumed());
	}

	consumed(): number {
		return this.state.consumedInputTokens + this.state.consumedOutputTokens;
	}

	diminishingReturns(minNoToolTurns: number): boolean {
		return this.state.noToolCallStreak >= minNoToolTurns;
	}

	snapshot(): BudgetTrackerState {
		return { ...this.state };
	}
}

export function parseTokenBudgetSyntax(input: string): number | undefined {
	const trimmed = input.trim();
	if (!trimmed.startsWith("+")) return undefined;
	const value = trimmed.slice(1);
	const multiplier = parseMultiplier(value);
	if (multiplier !== undefined) {
		const num = parseFloat(value.slice(0, -1));
		if (Number.isNaN(num) || num <= 0) return undefined;
		return Math.round(num * multiplier);
	}
	const num = parseInt(value, 10);
	if (Number.isNaN(num) || num <= 0) return undefined;
	return num;
}

function parseMultiplier(value: string): number | undefined {
	const last = value.charAt(value.length - 1).toLowerCase();
	if (last === "k") return 1_000;
	if (last === "m") return 1_000_000;
	return undefined;
}

export function shouldAutoContinue(tracker: BudgetTracker, turnCount: number, maxTurns: number | undefined, minNoToolTurns: number): { continue: boolean; reason?: "budget_depleted" | "diminishing_returns" | "max_turns" } {
	if (maxTurns !== undefined && turnCount >= maxTurns) {
		return { continue: false, reason: "max_turns" };
	}
	if (tracker.depleted()) {
		return { continue: false, reason: "budget_depleted" };
	}
	if (tracker.diminishingReturns(minNoToolTurns)) {
		return { continue: false, reason: "diminishing_returns" };
	}
	return { continue: true };
}
