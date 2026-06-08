import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import type { TaskSpec } from "../specs.js";
import { createHostBashExecutor, type BashExecutor } from "../tools/bash-executor.js";

export interface FixtureManager {
	setup(task: TaskSpec, baseDir: string): Promise<string>;
	teardown(workspaceDir: string): Promise<void>;
	cleanup(workspaceDir: string): Promise<void>;
}

export class DefaultFixtureManager implements FixtureManager {
	private readonly bashExecutor: BashExecutor;

	constructor(bashExecutor?: BashExecutor) {
		this.bashExecutor = bashExecutor ?? createHostBashExecutor();
	}

	async setup(task: TaskSpec, baseDir: string): Promise<string> {
		const workspaceDir = path.join(baseDir, task.id);
		mkdirSync(workspaceDir, { recursive: true });

		const fixtures = task.fixtures ?? [];
		for (const fixture of fixtures) {
			const filePath = path.join(workspaceDir, fixture.path);
			const dir = path.dirname(filePath);
			mkdirSync(dir, { recursive: true });
			writeFileSync(filePath, fixture.content, "utf-8");
		}

		const setupFixtures = fixtures.filter(f => typeof f.setup === "string" && f.setup.trim().length > 0);
		for (const fixture of setupFixtures) {
			await this.bashExecutor.execute({
				command: fixture.setup!,
				cwd: workspaceDir,
				workspaceRoot: workspaceDir,
				timeoutMs: 30_000,
				maxOutputBytes: 256 * 1024,
			});
		}

		return workspaceDir;
	}

	async teardown(workspaceDir: string): Promise<void> {
		if (!existsSync(workspaceDir)) return;
		const teardownCmd = `find . -name ".teardown" -exec /bin/sh -c 'cd "$(dirname {}" \\)' && /bin/sh .teardown' \\; 2>/dev/null || true`;
		try {
			await this.bashExecutor.execute({
				command: teardownCmd,
				cwd: workspaceDir,
				workspaceRoot: workspaceDir,
				timeoutMs: 30_000,
				maxOutputBytes: 256 * 1024,
			});
		} catch {
			// teardown is best-effort
		}
	}

	async cleanup(workspaceDir: string): Promise<void> {
		if (existsSync(workspaceDir)) {
			rmSync(workspaceDir, { recursive: true, force: true });
		}
	}
}
