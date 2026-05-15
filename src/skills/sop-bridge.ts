/**
 * SOP ↔ Skill Bridge
 *
 * Converts between SOPSpec and Skill types, and provides bulk import
 * from SOP YAML directories into a SkillBank.
 */

import { loadSopSpecsFromDirectory } from "../sop/loader.js";
import type { SOPSpec } from "../sop/types.js";
import { FileSkillBank } from "./store.js";
import type { Skill, SkillBank, SkillProvenance, SkillVersion } from "./types.js";

export interface SopToSkillOptions {
  tags?: string[];
  triggers?: string[];
  provenance?: Partial<SkillProvenance>;
}

export function sopToSkill(spec: SOPSpec, options: SopToSkillOptions = {}): Skill {
  const version: SkillVersion = {
    version: spec.version,
    sop: spec,
    provenance: {
      source: "imported",
      reason: "imported from SOP directory",
      createdAt: Date.now(),
      ...options.provenance,
    },
    benchmarkScore: undefined,
    benchmarkPassRate: undefined,
    verified: true,
    verificationDetail: undefined,
  };

  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    tags: options.tags ?? [],
    currentVersion: version.version,
    versions: [version],
    status: "active",
    triggers: options.triggers ?? [spec.id, spec.name],
    useCount: 0,
  };
}

export async function depositSopDirectoryToSkillBank(
  sopDir: string,
  bank: SkillBank,
  options: { tags?: string[]; force?: boolean } = {},
): Promise<Skill[]> {
  const specs = await loadSopSpecsFromDirectory(sopDir);
  const skills: Skill[] = [];

  for (const spec of specs) {
    const existing = bank.get(spec.id);
    if (existing && !options.force) {
      skills.push(existing);
      continue;
    }

    const skill = sopToSkill(spec, { ...(options.tags ? { tags: options.tags } : {}) });
    bank.upsert(skill);
    skills.push(skill);
  }

  return skills;
}

export async function createOrLoadSkillBank(skillBankPath: string): Promise<FileSkillBank> {
  const bank = new FileSkillBank({ path: skillBankPath });
  await bank.init();
  return bank;
}
