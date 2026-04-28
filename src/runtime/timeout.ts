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
