/**
 * SkillBank implementation backed by a JSON file on disk.
 */

import type { Skill, SkillBank, SkillStatus } from "./types.js";

export interface FileSkillBankOptions {
  path: string;
  /** Auto-save on every mutation. Default: true */
  autoSave?: boolean;
}

export class FileSkillBank implements SkillBank {
  private skills = new Map<string, Skill>();
  private readonly filePath: string;
  private readonly autoSave: boolean;

  constructor(options: FileSkillBankOptions) {
    this.filePath = options.path;
    this.autoSave = options.autoSave ?? true;
  }

  async init(): Promise<void> {
    try {
      const fs = await import("node:fs/promises");
      const data = await fs.readFile(this.filePath, "utf-8");
      this.load(data);
    } catch {
      // File doesn't exist yet — start empty
    }
  }

  list(filter?: { status?: SkillStatus; tags?: string[] }): Skill[] {
    let result = Array.from(this.skills.values());
    if (filter?.status) result = result.filter((s) => s.status === filter.status);
    if (filter?.tags && filter.tags.length > 0) {
      const tagSet = new Set(filter.tags);
      result = result.filter((s) => s.tags.some((t) => tagSet.has(t)));
    }
    return result;
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  search(query: string, limit = 5): Skill[] {
    const lowerQuery = query.toLowerCase();
    const scored: Array<{ skill: Skill; score: number }> = [];

    for (const skill of this.skills.values()) {
      if (skill.status === "deprecated" || skill.status === "superseded") continue;
      let score = 0;
      if (skill.name.toLowerCase().includes(lowerQuery)) score += 3;
      if (skill.description.toLowerCase().includes(lowerQuery)) score += 2;
      if (skill.tags.some((t) => lowerQuery.includes(t.toLowerCase()))) score += 1;
      if (skill.triggers?.some((t) => lowerQuery.includes(t.toLowerCase()))) score += 2;
      if (score > 0) scored.push({ skill, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.skill);
  }

  upsert(skill: Skill): void {
    this.skills.set(skill.id, skill);
    if (this.autoSave) void this.save();
  }

  deprecate(id: string, reason?: string): void {
    const skill = this.skills.get(id);
    if (!skill) return;
    skill.status = "deprecated";
    if (reason) skill.metadata = { ...skill.metadata, deprecationReason: reason };
    if (this.autoSave) void this.save();
  }

  supersede(oldId: string, newId: string): void {
    const oldSkill = this.skills.get(oldId);
    if (oldSkill) {
      oldSkill.status = "superseded";
      oldSkill.metadata = { ...oldSkill.metadata, supersededBy: newId };
    }
    if (this.autoSave) void this.save();
  }

  serialize(): string {
    const data = Array.from(this.skills.values());
    return JSON.stringify(data, null, 2);
  }

  load(data: string): void {
    const parsed = JSON.parse(data) as Skill[];
    this.skills.clear();
    for (const skill of parsed) {
      this.skills.set(skill.id, skill);
    }
  }

  private async save(): Promise<void> {
    const fs = await import("node:fs/promises");
    const dir = this.filePath.replace(/[/\\][^/\\]+$/, "");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, this.serialize(), "utf-8");
  }
}

/**
 * In-memory SkillBank for testing / ephemeral use.
 */
export class MemorySkillBank implements SkillBank {
  private skills = new Map<string, Skill>();

  list(filter?: { status?: SkillStatus; tags?: string[] }): Skill[] {
    let result = Array.from(this.skills.values());
    if (filter?.status) result = result.filter((s) => s.status === filter.status);
    if (filter?.tags && filter.tags.length > 0) {
      const tagSet = new Set(filter.tags);
      result = result.filter((s) => s.tags.some((t) => tagSet.has(t)));
    }
    return result;
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  search(query: string, limit = 5): Skill[] {
    const lowerQuery = query.toLowerCase();
    const scored: Array<{ skill: Skill; score: number }> = [];
    for (const skill of this.skills.values()) {
      if (skill.status === "deprecated" || skill.status === "superseded") continue;
      let score = 0;
      if (skill.name.toLowerCase().includes(lowerQuery)) score += 3;
      if (skill.description.toLowerCase().includes(lowerQuery)) score += 2;
      if (skill.tags.some((t) => lowerQuery.includes(t.toLowerCase()))) score += 1;
      if (skill.triggers?.some((t) => lowerQuery.includes(t.toLowerCase()))) score += 2;
      if (score > 0) scored.push({ skill, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.skill);
  }

  upsert(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  deprecate(id: string): void {
    const skill = this.skills.get(id);
    if (skill) skill.status = "deprecated";
  }

  supersede(oldId: string, newId: string): void {
    const oldSkill = this.skills.get(oldId);
    if (oldSkill) {
      oldSkill.status = "superseded";
      oldSkill.metadata = { ...oldSkill.metadata, supersededBy: newId };
    }
  }

  serialize(): string {
    return JSON.stringify(Array.from(this.skills.values()), null, 2);
  }

  load(data: string): void {
    const parsed = JSON.parse(data) as Skill[];
    this.skills.clear();
    for (const skill of parsed) this.skills.set(skill.id, skill);
  }
}
