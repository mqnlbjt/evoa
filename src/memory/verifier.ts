import type { MemoryCandidate, MemoryVerification } from "./types.js";

export function verifyMemoryCandidate(candidate: MemoryCandidate): MemoryVerification {
	const issues: string[] = [];
	if (candidate.sourceRefs.length === 0) issues.push("memory candidate has no sourceRefs");
	if (candidate.content.trim().length === 0) issues.push("memory candidate is empty");
	if (/tool_result|error|stack trace/i.test(candidate.content) && /偏好|我是|默认|必须/u.test(candidate.content)) {
		issues.push("tool output must not be treated as user preference");
	}
	if (candidate.metadata?.suitability === "quarantine" || candidate.metadata?.safety === "unsafe_or_sensitive") {
		issues.push(candidate.metadata.reason ?? "semantic extractor marked memory as quarantine");
	}
	let confidence = baseConfidence(candidate);
	if (candidate.sourceRefs.length > 0) confidence += 0.2;
	if (/记住|以后|默认|不要|必须/u.test(candidate.content)) confidence += 0.25;
	if (candidate.layer === "doctrine") confidence -= 0.1;
	confidence = clamp(confidence - issues.length * 0.35);
	const threshold = candidate.layer === "doctrine" ? 0.75 : 0.55;
	return { confidence, status: issues.length === 0 && confidence >= threshold ? "verified" : "quarantined", issues };
}

function baseConfidence(candidate: MemoryCandidate): number {
	if (candidate.layer === "episode") return 0.5;
	if (candidate.layer === "knowledge") return 0.55;
	return 0.6;
}

function clamp(value: number): number {
	return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}
