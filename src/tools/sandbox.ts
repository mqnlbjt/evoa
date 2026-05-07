import path from "node:path";
import type { AgentSession } from "../runtime/session.js";
import type { ToolCall } from "./registry.js";
import type { EvolvingAgentTool } from "./types.js";

export type SandboxMode = "off" | "workspace" | "docker";

export interface SandboxPolicy {
	mode: SandboxMode;
	workspaceRoot: string;
	allowNetwork: boolean;
	allowBash: boolean;
	dockerContainer?: string;
	deniedWritePaths?: string[];
	allowedNetworkDomains?: string[];
	deniedNetworkDomains?: string[];
}

export interface SandboxContext {
	session: AgentSession;
	tool: EvolvingAgentTool;
	call: ToolCall;
	policy: SandboxPolicy;
}

export interface SandboxDecision {
	decision: "allow" | "deny";
	reason: string;
	metadata?: Record<string, unknown>;
}

export function decideSandboxUse(context: SandboxContext): SandboxDecision {
	const metadata = { sandboxMode: context.policy.mode, tool: context.tool.name };
	if (context.policy.mode === "off") return { decision: "allow", reason: "sandbox is disabled", metadata };
	if (context.policy.mode === "docker" && context.tool.name === "bash" && !context.policy.dockerContainer) {
		return deny("docker sandbox requires a configured container", metadata);
	}
	if (context.tool.name === "web_fetch") return decideNetworkUse(context, metadata);
	if (context.tool.name === "bash") return decideBashUse(context, metadata);
	if (isWriteTool(context.tool.name)) return decideWriteUse(context, metadata);
	return { decision: "allow", reason: "tool is allowed by sandbox policy", metadata };
}

function decideNetworkUse(context: SandboxContext, metadata: Record<string, unknown>): SandboxDecision {
	if (!context.policy.allowNetwork) return deny("network access is disabled by sandbox policy", metadata);
	const url = inputString(context.call.input, "url");
	if (!url) return { decision: "allow", reason: "network tool input will be validated by tool", metadata };
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return { decision: "allow", reason: "network URL will be validated by tool", metadata };
	}
	if (domainMatches(hostname, context.policy.deniedNetworkDomains ?? [])) return deny(`network domain is denied by sandbox policy: ${hostname}`, { ...metadata, hostname });
	const allowed = context.policy.allowedNetworkDomains;
	if (allowed && allowed.length > 0 && !domainMatches(hostname, allowed)) return deny(`network domain is not allowed by sandbox policy: ${hostname}`, { ...metadata, hostname });
	return { decision: "allow", reason: "network access is allowed by sandbox policy", metadata: { ...metadata, hostname } };
}

function decideBashUse(context: SandboxContext, metadata: Record<string, unknown>): SandboxDecision {
	if (!context.policy.allowBash) return deny("bash is disabled by sandbox policy", metadata);
	const command = inputString(context.call.input, "command");
	if (!command) return { decision: "allow", reason: "bash command will be validated by tool", metadata };
	const issue = unsafeBashIssue(command);
	if (issue) return deny(issue, { ...metadata, command });
	return { decision: "allow", reason: "bash command is allowed by sandbox policy", metadata };
}

function decideWriteUse(context: SandboxContext, metadata: Record<string, unknown>): SandboxDecision {
	const userPath = inputString(context.call.input, "path");
	if (!userPath) return { decision: "allow", reason: "file path will be validated by tool", metadata };
	const normalized = normalizeWorkspacePath(context.policy.workspaceRoot, userPath);
	if (normalized && deniedWritePath(normalized, context.policy.deniedWritePaths ?? defaultDeniedWritePaths())) {
		return deny(`write path is denied by sandbox policy: ${normalized}`, { ...metadata, path: normalized });
	}
	return { decision: "allow", reason: "workspace write is allowed by sandbox policy", metadata: normalized ? { ...metadata, path: normalized } : metadata };
}

function unsafeBashIssue(command: string): string | undefined {
	const normalized = command.trim();
	if (!normalized) return undefined;
	if (/&\s*$/.test(normalized)) return "background bash commands are denied by sandbox policy";
	if (/(^|[;&|()\s])sudo(\s|$)/.test(normalized) || /(^|[;&|()\s])su(\s|$)/.test(normalized)) return "privilege escalation commands are denied by sandbox policy";
	if (/\brm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+(?:\/|~|\*)(?:\s|$)/.test(normalized) || /\brm\s+-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*\s+(?:\/|~|\*)(?:\s|$)/.test(normalized)) return "destructive rm command is denied by sandbox policy";
	if (/\bchmod\s+(?:-R\s+)?777\b/.test(normalized) || /\bchown\b/.test(normalized)) return "permission-changing commands are denied by sandbox policy";
	if (/\b(nohup|disown)\b/.test(normalized)) return "detached bash commands are denied by sandbox policy";
	if (/\b(curl|wget)\b/.test(normalized) || /\bgit\s+clone\b/.test(normalized)) return "network bash commands are denied by sandbox policy";
	if (/\b(npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install)\b/.test(normalized)) return "dependency installation commands are denied by sandbox policy";
	if (/(^|\s)(?:\d?>|\d?>>|&>|>&)\s*(?:\/|\.\.\/)/.test(normalized)) return "redirects outside the workspace are denied by sandbox policy";
	return undefined;
}

function isWriteTool(name: string): boolean {
	return name === "write_file" || name === "edit_file";
}

function inputString(input: unknown, key: string): string | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const value = (input as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function normalizeWorkspacePath(workspaceRoot: string, userPath: string): string | undefined {
	if (!userPath.trim()) return undefined;
	const resolved = path.resolve(workspaceRoot, userPath);
	return path.relative(path.resolve(workspaceRoot), resolved).split(path.sep).join("/") || ".";
}

function deniedWritePath(normalizedPath: string, deniedPaths: string[]): boolean {
	return deniedPaths.some((entry) => normalizedPath === entry || normalizedPath.startsWith(`${entry}/`));
}

function defaultDeniedWritePaths(): string[] {
	return [".evolving-agent/config.json", ".claude"];
}

function domainMatches(hostname: string, patterns: string[]): boolean {
	return patterns.some((pattern) => hostname === pattern.toLowerCase() || hostname.endsWith(`.${pattern.toLowerCase()}`));
}

function deny(reason: string, metadata: Record<string, unknown>): SandboxDecision {
	return { decision: "deny", reason, metadata };
}
