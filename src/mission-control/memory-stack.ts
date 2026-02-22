/**
 * Agent Memory Stack — Persistent memory across sessions.
 *
 * From the article:
 * "The Golden Rule: If you want to remember something, write it to a file."
 *
 * Memory layers:
 * 1. Session Memory — Clawdbot built-in conversation history (JSONL)
 * 2. Working Memory — WORKING.md (current task state, updated constantly)
 * 3. Daily Notes — YYYY-MM-DD.md (raw logs of what happened each day)
 * 4. Long-term Memory — MEMORY.md (curated important stuff)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { logger } from '../utils/logger.js';

export class AgentMemoryStack {
  private baseDir: string;

  constructor(workspaceDir: string) {
    this.baseDir = resolve(workspaceDir, 'memory');
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
  }

  private agentDir(sessionKey: string): string {
    // Convert session key to safe directory name
    const safeName = sessionKey.replace(/:/g, '-');
    const dir = join(this.baseDir, safeName);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ─── Working Memory (WORKING.md) ──────────────────────────

  getWorkingMemory(sessionKey: string): string {
    const path = join(this.agentDir(sessionKey), 'WORKING.md');
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  setWorkingMemory(sessionKey: string, content: string): void {
    const path = join(this.agentDir(sessionKey), 'WORKING.md');
    writeFileSync(path, content, 'utf-8');
    logger.debug('MemoryStack', `Updated WORKING.md for ${sessionKey}`);
  }

  // ─── Daily Notes (YYYY-MM-DD.md) ─────────────────────────

  private todayFile(sessionKey: string): string {
    const date = new Date().toISOString().slice(0, 10);
    return join(this.agentDir(sessionKey), `${date}.md`);
  }

  getTodayNotes(sessionKey: string): string {
    const path = this.todayFile(sessionKey);
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  appendDailyNote(sessionKey: string, note: string): void {
    const path = this.todayFile(sessionKey);
    const time = new Date().toISOString().slice(11, 16);
    const entry = `\n## ${time} UTC\n${note}\n`;

    let existing = '';
    if (existsSync(path)) {
      existing = readFileSync(path, 'utf-8');
    } else {
      const date = new Date().toISOString().slice(0, 10);
      existing = `# ${date}\n`;
    }

    writeFileSync(path, existing + entry, 'utf-8');
  }

  getDailyNotes(sessionKey: string, date: string): string {
    const path = join(this.agentDir(sessionKey), `${date}.md`);
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  listDailyNotes(sessionKey: string): string[] {
    const dir = this.agentDir(sessionKey);
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace('.md', ''))
      .sort()
      .reverse();
  }

  // ─── Long-term Memory (MEMORY.md) ────────────────────────

  getLongTermMemory(sessionKey: string): string {
    const path = join(this.agentDir(sessionKey), 'MEMORY.md');
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  }

  appendLongTermMemory(sessionKey: string, content: string): void {
    const path = join(this.agentDir(sessionKey), 'MEMORY.md');
    let existing = '';
    if (existsSync(path)) {
      existing = readFileSync(path, 'utf-8');
    } else {
      existing = '# Long-Term Memory\n\nCurated important information, lessons learned, key decisions.\n';
    }
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(path, existing + `\n## ${date}\n${content}\n`, 'utf-8');
  }

  // ─── HEARTBEAT.md ────────────────────────────────────────

  getHeartbeatChecklist(sessionKey: string): string {
    const path = join(this.agentDir(sessionKey), 'HEARTBEAT.md');
    if (existsSync(path)) return readFileSync(path, 'utf-8');

    // Generate default heartbeat checklist
    const defaultChecklist = `# Heartbeat Protocol

## On Wake
- [ ] Check memory/WORKING.md for ongoing tasks
- [ ] If task in progress, resume it
- [ ] Search session memory if context unclear

## Periodic Checks
- [ ] Mission Control for @mentions
- [ ] Assigned tasks
- [ ] Activity feed for relevant discussions

## Before Sleep
- [ ] Update WORKING.md with current state
- [ ] Log significant actions to daily notes
`;
    writeFileSync(path, defaultChecklist, 'utf-8');
    return defaultChecklist;
  }

  // ─── Full Context (for agent startup) ───────────────────

  getFullContext(sessionKey: string): string {
    const parts: string[] = [];

    const working = this.getWorkingMemory(sessionKey);
    if (working) {
      parts.push('## Working Memory (Current State)', working);
    }

    const today = this.getTodayNotes(sessionKey);
    if (today) {
      parts.push("## Today's Notes", today);
    }

    const longTerm = this.getLongTermMemory(sessionKey);
    if (longTerm) {
      parts.push('## Long-Term Memory', longTerm.slice(-2000)); // Last 2000 chars
    }

    return parts.join('\n\n');
  }
}
