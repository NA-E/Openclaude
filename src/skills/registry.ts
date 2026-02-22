/**
 * Skill Registry — Extensible plugin system.
 *
 * OpenClaw uses SKILL.md files in workspace/skills/<skill>/.
 * Skills define tools, prompt injections, and config schemas.
 * OpenClaude mirrors this with markdown-defined skills.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { logger } from '../utils/logger.js';
import type { Skill, SkillTool, ToolContext } from '../types/index.js';

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  async loadAll(): Promise<void> {
    // Load from workspace/skills/
    const skillsDir = resolve(this.workspacePath, 'skills');
    if (!existsSync(skillsDir)) return;

    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = join(skillsDir, entry.name);
      const skillMdPath = join(skillDir, 'SKILL.md');

      if (existsSync(skillMdPath)) {
        try {
          const skill = this.parseSkillMd(entry.name, skillMdPath, skillDir);
          this.skills.set(skill.id, skill);
          logger.info('Skills', `Loaded skill: ${skill.name} (${skill.id})`);
        } catch (err) {
          logger.error('Skills', `Failed to load skill ${entry.name}`, err);
        }
      }
    }

    // Load bundled skills
    const bundledDir = resolve(process.cwd(), 'skills');
    if (existsSync(bundledDir)) {
      const bundled = readdirSync(bundledDir, { withFileTypes: true });
      for (const entry of bundled) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(bundledDir, entry.name, 'SKILL.md');
        if (existsSync(skillMdPath) && !this.skills.has(entry.name)) {
          try {
            const skill = this.parseSkillMd(entry.name, skillMdPath, join(bundledDir, entry.name));
            this.skills.set(skill.id, skill);
            logger.info('Skills', `Loaded bundled skill: ${skill.name}`);
          } catch (err) {
            logger.error('Skills', `Failed to load bundled skill ${entry.name}`, err);
          }
        }
      }
    }
  }

  private parseSkillMd(id: string, mdPath: string, skillDir: string): Skill {
    const content = readFileSync(mdPath, 'utf-8');
    const lines = content.split('\n');

    let name = id;
    let description = '';
    let version = '1.0.0';
    let author: string | undefined;
    let promptInjection = '';
    const tools: SkillTool[] = [];

    let section = '';
    const sectionContent: string[] = [];

    for (const line of lines) {
      if (line.startsWith('# ')) {
        name = line.slice(2).trim();
      } else if (line.startsWith('## ')) {
        // Save previous section
        if (section === 'Description') description = sectionContent.join('\n').trim();
        if (section === 'Prompt') promptInjection = sectionContent.join('\n').trim();

        section = line.slice(3).trim();
        sectionContent.length = 0;
      } else if (line.startsWith('- **Version**:')) {
        version = line.split(':')[1]?.trim() || version;
      } else if (line.startsWith('- **Author**:')) {
        author = line.split(':')[1]?.trim();
      } else {
        sectionContent.push(line);
      }
    }

    // Save last section
    if (section === 'Description') description = sectionContent.join('\n').trim();
    if (section === 'Prompt') promptInjection = sectionContent.join('\n').trim();

    // Load tool implementations if handler.ts exists
    const handlerPath = join(skillDir, 'handler.ts');
    if (existsSync(handlerPath)) {
      // In production, this would dynamically import the handler
      // For now, register a placeholder
      tools.push({
        name: `${id}_execute`,
        description: `Execute the ${name} skill`,
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input for the skill' },
          },
          required: ['input'],
        },
        execute: async (input: Record<string, unknown>, _context: ToolContext) => {
          return `Skill ${name} executed with input: ${JSON.stringify(input)}`;
        },
      });
    }

    return { id, name, description, version, author, tools, promptInjection };
  }

  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  getSkillsForAgent(skillIds: string[]): Skill[] {
    if (skillIds.length === 0) {
      // Return all skills if none specified
      return this.listSkills();
    }
    return skillIds.map((id) => this.skills.get(id)).filter(Boolean) as Skill[];
  }

  getToolsForAgent(skillIds: string[]): SkillTool[] {
    return this.getSkillsForAgent(skillIds).flatMap((s) => s.tools);
  }

  findTool(name: string): SkillTool | undefined {
    for (const skill of this.skills.values()) {
      const tool = skill.tools.find((t) => t.name === name);
      if (tool) return tool;
    }
    return undefined;
  }

  registerSkill(skill: Skill) {
    this.skills.set(skill.id, skill);
  }
}
