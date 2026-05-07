import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { buildDockerExecArgs, createDockerBashExecutor, type SpawnedProcess, type SpawnLike } from "../src/tools/bash-executor.js";

describe("bash executor", () => {
	it("builds docker exec arguments", () => {
		expect(buildDockerExecArgs("container", "/workspace/sub", "echo hi")).toEqual(["exec", "-w", "/workspace/sub", "container", "/bin/sh", "-lc", "echo hi"]);
	});

	it("runs docker executor through injectable spawn", async () => {
		let executable = "";
		let capturedArgs: string[] | undefined;
		let capturedOptions: { cwd?: string; shell?: boolean } | undefined;
		const spawnFn: SpawnLike = (command, args, options) => {
			executable = command;
			capturedArgs = args;
			capturedOptions = options;
			return fakeProcess({ stdout: "ok\n", stderr: "warn\n", exitCode: 0 });
		};
		const executor = createDockerBashExecutor({ container: "box", spawnFn });

		const result = await executor.execute({ command: "echo hi", cwd: "/workspace/sub", workspaceRoot: "/workspace", timeoutMs: 1000, maxOutputBytes: 1024 });

		expect(executable).toBe("docker");
		expect(capturedArgs).toEqual(buildDockerExecArgs("box", "/workspace/sub", "echo hi"));
		expect(capturedOptions).toEqual({ shell: false });
		expect(result).toMatchObject({ command: "echo hi", cwd: "sub", exitCode: 0, stdout: "ok\n", stderr: "warn\n", truncated: false, timedOut: false });
	});
});

function fakeProcess(output: { stdout?: string; stderr?: string; exitCode: number | null }): SpawnedProcess {
	const child = new EventEmitter() as SpawnedProcess;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = () => true;
	queueMicrotask(() => {
		if (output.stdout) child.stdout.emit("data", Buffer.from(output.stdout));
		if (output.stderr) child.stderr.emit("data", Buffer.from(output.stderr));
		child.emit("close", output.exitCode, null);
	});
	return child;
}
