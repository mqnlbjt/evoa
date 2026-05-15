/**
 * Skill Depositor
 *
 * Connects the evolution engine's accept/reject flow to skill deposition.
 * When a candidate passes benchmark + verification, it can be deposited as a new skill.
 */

import type { EvolutionCandidate, EvolutionComparison } from "../evolution/types.js";
import type { SOPSpec } from "../sop/types.js";
import type { Skill, SkillBank, SkillProvenance, SkillVersion } from "./types.js";

export interface DepositorOptions {
  /** Minimum deltaScore to allow deposition */
  minScoreDelta?: number;
  /** Minimum passRate to allow deposition */
  minPassRate?: number;
  /** Auto-deposit on accept. Default: true */
  autoDeposit?: boolean;
  /** Tags to add to auto-deposited skills */
  defaultTags?: string[];
}

export interface DepositRequest {
  /** The SOP that this skill wraps */
  sop: SOPSpec;
  /** Human-readable name */
  name: string;
  /** Description */
  description: string;
  /** Tags for categorization */
  tags?: string[];
  /** Trigger keywords */
  triggers?: string[] | undefined;
  /** Provenance info */
  provenance: SkillProvenance;
  /** Optional benchmark results */
  benchmarkScore?: number | undefined;
  benchmarkPassRate?: number | undefined;
  /** Verification result */
  verified?: boolean | undefined;
  verificationDetail?: string | undefined;
}

export interface DepositResult {
  skill: Skill;
  version: string;
  isNew: boolean;
}

export class SkillDepositor {
  constructor(
    private readonly bank: SkillBank,
    private readonly options: DepositorOptions = {},
  ) {}

  /**
   * Manually deposit a new skill or new version of an existing skill.
   */
  deposit(request: DepositRequest): DepositResult {
    const existing = this.bank.get(request.sop.id);
    const version = existing
      ? incrementVersion(existing.currentVersion)
      : "1.0.0";

    const skillVersion: SkillVersion = {
      version,
      sop: request.sop,
      provenance: request.provenance,
      ...(request.benchmarkScore !== undefined ? { benchmarkScore: request.benchmarkScore } : {}),
      ...(request.benchmarkPassRate !== undefined ? { benchmarkPassRate: request.benchmarkPassRate } : {}),
      verified: request.verified ?? false,
      ...(request.verificationDetail !== undefined ? { verificationDetail: request.verificationDetail } : {}),
    } as SkillVersion;

    if (existing) {
      existing.versions.push(skillVersion);
      existing.currentVersion = version;
      existing.name = request.name;
      existing.description = request.description;
      if (request.tags) existing.tags = request.tags;
      if (request.triggers) existing.triggers = request.triggers;
      this.bank.upsert(existing);
      return { skill: existing, version, isNew: false };
    }

    const skill: Skill = {
      id: request.sop.id,
      name: request.name,
      description: request.description,
      tags: request.tags ?? this.options.defaultTags ?? [],
      currentVersion: version,
      versions: [skillVersion],
      status: "active",
      triggers: request.triggers,
      useCount: 0,
    };

    this.bank.upsert(skill);
    return { skill, version, isNew: true };
  }

  /**
   * Attempt to deposit from an evolution comparison result.
   * Only deposits if the recommendation is "accept" and benchmark thresholds are met.
   */
  depositFromEvolution(
    candidate: EvolutionCandidate,
    comparison: EvolutionComparison,
    sop: SOPSpec,
  ): DepositResult | null {
    if (comparison.recommendation !== "accept") return null;

    const minScoreDelta = this.options.minScoreDelta ?? 0;
    const minPassRate = this.options.minPassRate ?? 0;

    if (comparison.deltaScore < minScoreDelta) return null;
    if (comparison.deltaPassRate < minPassRate) return null;

    return this.deposit({
      sop,
      name: candidate.agent.name,
      description: candidate.description,
      tags: this.options.defaultTags ?? [],
      provenance: {
        source: "evolved",
        reason: `evolution candidate ${candidate.id} accepted: score Δ${comparison.deltaScore >= 0 ? "+" : ""}${comparison.deltaScore.toFixed(2)}, passRate Δ${comparison.deltaPassRate >= 0 ? "+" : ""}${(comparison.deltaPassRate * 100).toFixed(1)}%`,
        createdAt: Date.now(),
      },
      benchmarkScore: comparison.candidate.summary.totalScore,
      benchmarkPassRate: comparison.candidate.summary.passRate,
      verified: true,
    });
  }

  /**
   * Deposit from a completed SOP run that was verified as successful.
   */
  depositFromSuccessfulRun(
    sop: SOPSpec,
    name: string,
    description: string,
    options?: {
      sessionId?: string;
      taskId?: string;
      tags?: string[];
      triggers?: string[];
    },
  ): DepositResult {
    return this.deposit({
      sop,
      name,
      description,
      tags: options?.tags ?? this.options.defaultTags ?? [],
      triggers: options?.triggers,
      provenance: {
        source: "auto_extracted" as const,
        ...(options?.sessionId ? { originSessionId: options.sessionId } : {}),
        ...(options?.taskId ? { originTaskId: options.taskId } : {}),
        reason: "auto-deposited from successful SOP run",
        createdAt: Date.now(),
      },
      verified: true,
    });
  }
}

// ---- Helpers ----

function incrementVersion(current: string): string {
  const parts = current.split(".").map(Number);
  if (parts.length !== 3) return "1.0.0";
  return `${parts[0]}.${parts[1]! + 1}.0`;
}
