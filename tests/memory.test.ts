import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryFileStore } from '../src/memory/store.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MemoryFileStore', () => {
  let store: MemoryFileStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'openclaude-test-'));
    store = new MemoryFileStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should remember and recall entries', async () => {
    await store.remember({
      agentId: 'test',
      category: 'fact',
      content: 'The user likes TypeScript',
      tags: ['language', 'preference'],
      importance: 0.8,
    });

    const results = await store.recall('TypeScript language');
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('should return empty for unrelated queries', async () => {
    await store.remember({
      agentId: 'test',
      category: 'fact',
      content: 'The user likes TypeScript',
      tags: ['language'],
      importance: 0.8,
    });

    const results = await store.recall('xyz');
    expect(results.length).toBe(0);
  });

  it('should forget entries', async () => {
    const entry = await store.remember({
      agentId: 'test',
      category: 'fact',
      content: 'Something to forget',
      tags: [],
      importance: 0.5,
    });

    await store.forget(entry.id);
    const results = await store.recall('forget');
    expect(results.length).toBe(0);
  });

  it('should filter by category', async () => {
    await store.remember({
      agentId: 'test',
      category: 'fact',
      content: 'A fact',
      tags: [],
      importance: 0.5,
    });

    await store.remember({
      agentId: 'test',
      category: 'preference',
      content: 'A preference',
      tags: [],
      importance: 0.5,
    });

    const facts = await store.getByCategory('fact');
    expect(facts.length).toBe(1);
    expect(facts[0].content).toBe('A fact');
  });

  it('should filter by tags', async () => {
    await store.remember({
      agentId: 'test',
      category: 'fact',
      content: 'Tagged entry',
      tags: ['important', 'user-info'],
      importance: 0.5,
    });

    await store.remember({
      agentId: 'test',
      category: 'fact',
      content: 'Untagged entry',
      tags: ['other'],
      importance: 0.5,
    });

    const results = await store.getByTags(['important']);
    expect(results.length).toBe(1);
    expect(results[0].content).toBe('Tagged entry');
  });

  it('should filter by agent ID', async () => {
    await store.remember({
      agentId: 'agent-1',
      category: 'fact',
      content: 'Agent 1 memory',
      tags: [],
      importance: 0.5,
    });

    await store.remember({
      agentId: 'agent-2',
      category: 'fact',
      content: 'Agent 2 memory',
      tags: [],
      importance: 0.5,
    });

    const results = await store.getAllForAgent('agent-1');
    expect(results.length).toBe(1);
    expect(results[0].agentId).toBe('agent-1');
  });
});
