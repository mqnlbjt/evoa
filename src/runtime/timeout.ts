export class RuntimeTimeoutError extends Error {
	readonly code = "RUNTIME_TIMEOUT";

	constructor(timeoutMs: number) {
		super(`runtime timed out after ${timeoutMs}ms`);
		this.name = "RuntimeTimeoutError";
	}
}

export function isRuntimeTimeoutError(error: unknown): error is RuntimeTimeoutError {
	return error instanceof RuntimeTimeoutError;
}

export type InterruptReason = "cancelled" | "user_interrupt" | "parent_abort";

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (isRuntimeTimeoutError(error)) return false;
	if (signal?.aborted) return true;
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || error.message === "Operation aborted" || error.message === "User interrupted";
}

export function abortReason(signal?: AbortSignal): InterruptReason {
	const reason = signal?.reason;
	const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
	if (/user|ctrl-c|interrupt/i.test(message)) return "user_interrupt";
	if (/cancel/i.test(message)) return "cancelled";
	return "parent_abort";
}

export function abortMessage(error: unknown, signal?: AbortSignal): string {
	const reason = signal?.reason;
	if (reason instanceof Error && reason.message) return reason.message;
	if (typeof reason === "string" && reason) return reason;
	if (error instanceof Error && error.message) return error.message;
	return "Operation aborted";
}

export function throwIfRuntimeAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof Error) throw reason;
	const error = new Error(abortMessage(undefined, signal));
	error.name = "AbortError";
	throw error;
}

export async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number | undefined, parentSignal?: AbortSignal): Promise<T> {
	if (timeoutMs === undefined) return run(parentSignal ?? new AbortController().signal);
	const controller = new AbortController();
	const onAbort = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) controller.abort(parentSignal.reason);
	parentSignal?.addEventListener("abort", onAbort, { once: true });
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			run(controller.signal),
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort(new RuntimeTimeoutError(timeoutMs));
					reject(new RuntimeTimeoutError(timeoutMs));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		parentSignal?.removeEventListener("abort", onAbort);
	}
}

export function minDefined(...values: Array<number | undefined>): number | undefined {
	const defined = values.filter((value): value is number => value !== undefined);
	return defined.length === 0 ? undefined : Math.min(...defined);
}
