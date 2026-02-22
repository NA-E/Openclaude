import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SkillRegistry } from '../src/skills/registry.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SkillRegistry', () => {
  let registry: SkillRegistry;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'openclaude-skills-'));
    registry = new SkillRegistry(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load skills from workspace', async () => {
    const skillDir = join(tempDir, 'skills', 'test-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `# Test Skill\n\n## Description\nA test skill.\n\n- **Version**: 1.0.0\n- **Author**: Test\n\n## Prompt\nYou can test things.`,
    );

    await registry.loadAll();
    const skills = registry.listSkills();
    // May include bundled skills from cwd/skills/ as well
    expect(skills.length).toBeGreaterThanOrEqual(1);
    const testSkill = skills.find((s) => s.id === 'test-skill');
    expect(testSkill).toBeDefined();
    expect(testSkill!.name).toBe('Test Skill');
    expect(testSkill!.version).toBe('1.0.0');
  });

  it('should return empty list when no skills directory', async () => {
    const emptyRegistry = new SkillRegistry('/nonexistent/path');
    await emptyRegistry.loadAll();
    expect(emptyRegistry.listSkills().length).toBe(0);
  });

  it('should register skills programmatically', () => {
    registry.registerSkill({
      id: 'custom',
      name: 'Custom Skill',
      description: 'A custom skill',
      version: '1.0.0',
      tools: [],
    });

    expect(registry.getSkill('custom')).toBeDefined();
    expect(registry.getSkill('custom')?.name).toBe('Custom Skill');
  });

  it('should get skills for agent', () => {
    registry.registerSkill({
      id: 'skill-a',
      name: 'Skill A',
      description: 'A',
      version: '1.0.0',
      tools: [],
    });
    registry.registerSkill({
      id: 'skill-b',
      name: 'Skill B',
      description: 'B',
      version: '1.0.0',
      tools: [],
    });

    const agentSkills = registry.getSkillsForAgent(['skill-a']);
    expect(agentSkills.length).toBe(1);
    expect(agentSkills[0].id).toBe('skill-a');
  });

  it('should return all skills when agent has no specific skills', () => {
    registry.registerSkill({
      id: 'skill-a',
      name: 'Skill A',
      description: 'A',
      version: '1.0.0',
      tools: [],
    });

    const agentSkills = registry.getSkillsForAgent([]);
    expect(agentSkills.length).toBe(1);
  });
});
