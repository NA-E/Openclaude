/**
 * ProjectManager — auto-detects project directories and manages
 * per-project account assignments.
 *
 * Config persists to ~/.openclaude/project-accounts.json
 */

import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

export interface ProjectInfo {
  name: string;
  path: string;
  account: string | null;  // null = use gateway default
}

interface ProjectAccountMap {
  [projectName: string]: string;  // project name → account ID (e.g. "acc1")
}

const CONFIG_DIR = resolve(homedir(), '.openclaude');
const CONFIG_PATH = join(CONFIG_DIR, 'project-accounts.json');

export class ProjectManager {
  private projectsRoot: string;
  private assignments: ProjectAccountMap = {};

  constructor(projectsRoot: string) {
    this.projectsRoot = projectsRoot;
    this.load();
  }

  /** Scan the projects root for subdirectories */
  listProjects(): ProjectInfo[] {
    const projects: ProjectInfo[] = [];

    try {
      const entries = readdirSync(this.projectsRoot);
      for (const entry of entries) {
        const fullPath = join(this.projectsRoot, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            projects.push({
              name: entry,
              path: fullPath,
              account: this.assignments[entry] || null,
            });
          }
        } catch { /* skip unreadable entries */ }
      }
    } catch (err) {
      logger.error('ProjectManager', `Failed to scan ${this.projectsRoot}`, err);
    }

    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Assign an account to a project */
  assignAccount(projectName: string, accountId: string | null): void {
    if (accountId === null || accountId === '') {
      delete this.assignments[projectName];
      logger.info('ProjectManager', `Cleared account assignment for "${projectName}"`);
    } else {
      this.assignments[projectName] = accountId;
      logger.info('ProjectManager', `Assigned "${projectName}" → ${accountId}`);
    }
    this.save();
  }

  /** Get the account assigned to a project (null = use default) */
  getAccountForProject(projectName: string): string | null {
    return this.assignments[projectName] || null;
  }

  /** Get all assignments */
  getAssignments(): ProjectAccountMap {
    return { ...this.assignments };
  }

  private load(): void {
    try {
      if (existsSync(CONFIG_PATH)) {
        this.assignments = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
        logger.info('ProjectManager', `Loaded ${Object.keys(this.assignments).length} project-account assignments`);
      }
    } catch (err) {
      logger.warn('ProjectManager', `Failed to load config: ${err}`);
      this.assignments = {};
    }
  }

  private save(): void {
    try {
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }
      writeFileSync(CONFIG_PATH, JSON.stringify(this.assignments, null, 2), 'utf-8');
    } catch (err) {
      logger.error('ProjectManager', `Failed to save config`, err);
    }
  }
}
