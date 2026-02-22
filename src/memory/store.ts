/**
 * Memory Store — Persistent file-based memory.
 *
 * OpenClaw stores memory as Markdown files on disk (local-first).
 * OpenClaude does the same: each memory is a JSON entry in a file,
 * with simple keyword-based recall (upgradeable to embeddings).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { v4 as uuid } from 'uuid';
import type { MemoryEntry, MemoryStore } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class MemoryFileStore implements MemoryStore {
  private entries: MemoryEntry[] = [];
  private storePath: string;

  constructor(memoryDir: string) {
    const dir = memoryDir.replace('~', process.env.HOME || '');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.storePath = resolve(dir, 'memories.json');
    this.load();
  }

  private load() {
    if (existsSync(this.storePath)) {
      try {
        const raw = readFileSync(this.storePath, 'utf-8');
        const data = JSON.parse(raw);
        this.entries = data.map((e: Record<string, unknown>) => ({
          ...e,
          createdAt: new Date(e.createdAt as string),
          lastAccessedAt: new Date(e.lastAccessedAt as string),
        }));
        logger.info('Memory', `Loaded ${this.entries.length} memories from disk`);
      } catch (err) {
        logger.error('Memory', 'Failed to load memories', err);
        this.entries = [];
      }
    }
  }

  private save() {
    try {
      writeFileSync(this.storePath, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch (err) {
      logger.error('Memory', 'Failed to save memories', err);
    }
  }

  async remember(
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>,
  ): Promise<MemoryEntry> {
    const memory: MemoryEntry = {
      ...entry,
      id: uuid(),
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      accessCount: 0,
    };
    this.entries.push(memory);
    this.save();
    logger.debug('Memory', `Remembered: ${memory.content.slice(0, 60)}`, { id: memory.id });
    return memory;
  }

  async recall(query: string, limit = 10): Promise<MemoryEntry[]> {
    const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (queryWords.length === 0) return [];

    // Simple keyword relevance scoring
    const scored = this.entries.map((entry) => {
      const content = entry.content.toLowerCase();
      const tags = entry.tags.map((t) => t.toLowerCase());

      let score = 0;
      for (const word of queryWords) {
        if (content.includes(word)) score += 1;
        if (tags.some((t) => t.includes(word))) score += 2;
      }

      // Boost by importance
      score *= entry.importance;

      // Recency boost
      const ageHours = (Date.now() - entry.createdAt.getTime()) / (1000 * 60 * 60);
      if (ageHours < 24) score *= 1.5;
      else if (ageHours < 168) score *= 1.2;

      return { entry, score };
    });

    const results = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => {
        s.entry.lastAccessedAt = new Date();
        s.entry.accessCount++;
        return s.entry;
      });

    if (results.length > 0) this.save();
    return results;
  }

  async forget(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.save();
  }

  async getByCategory(category: MemoryEntry['category']): Promise<MemoryEntry[]> {
    return this.entries.filter((e) => e.category === category);
  }

  async getByTags(tags: string[]): Promise<MemoryEntry[]> {
    return this.entries.filter((e) => e.tags.some((t) => tags.includes(t)));
  }

  async getAllForAgent(agentId: string): Promise<MemoryEntry[]> {
    return this.entries.filter((e) => e.agentId === agentId);
  }
}
