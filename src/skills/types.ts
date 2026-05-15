/**
 * Skill Types
 *
 * A Skill wraps an SOP with metadata, provenance, and versioning.
 * Skills are the unit of knowledge deposition — they are executable,
 * verifiable, and reusable.
 */

import type { SOPSpec } from "../sop/types.js";

export type SkillStatus = "draft" | "active" | "deprecated" | "superseded";

export interface SkillProvenance {
  /** How was this skill created? */
  source: "manual" | "auto_extracted" | "evolved" | "imported";
  /** Which session/task produced this skill? */
  originSessionId?: string | undefined;
  originTaskId?: string | undefined;
  /** Evolution lineage */
  parentSkillId?: string | undefined;
  /** Human-readable reason for creation */
  reason?: string | undefined;
  /** Timestamp of creation */
  createdAt: number;
}

export interface SkillVersion {
  version: string;
  sop: SOPSpec;
  provenance: SkillProvenance;
  /** Benchmark results that validated this version */
  benchmarkScore: number | undefined;
  benchmarkPassRate: number | undefined;
  /** Verification result */
  verified: boolean;
  verificationDetail: string | undefined;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** Current active version */
  currentVersion: string;
  /** All versions including current */
  versions: SkillVersion[];
  status: SkillStatus;
  /** Trigger keywords/patterns for automatic skill selection */
  triggers?: string[] | undefined;
  /** When was this skill last successfully used? */
  lastUsedAt?: number | undefined;
  /** Usage count */
  useCount?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * The core interface for querying the skill bank.
 */
export interface SkillBank {
  /** List all skills (optionally filtered) */
  list(filter?: { status?: SkillStatus; tags?: string[] }): Skill[];
  /** Get a skill by id */
  get(id: string): Skill | undefined;
  /** Find skills matching a query */
  search(query: string, limit?: number): Skill[];
  /** Add or update a skill */
  upsert(skill: Skill): void;
  /** Deprecate a skill */
  deprecate(id: string, reason?: string): void;
  /** Supersede oldSkill with newSkill */
  supersede(oldId: string, newId: string): void;
  /** Serialize the entire bank */
  serialize(): string;
  /** Load from serialized form */
  load(data: string): void;
}

/**
 * Skill selection result: which skill matches a given task/context.
 */
export interface SkillMatch {
  skill: Skill;
  confidence: number;
  reason: string;
}

export interface SkillSelector {
  select(prompt: string, context?: Record<string, unknown>): Promise<SkillMatch[]>;
}
