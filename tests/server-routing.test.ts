import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveAgentForChannel } from '../src/gateway/server.js';
import { MissionControlDB } from '../src/mission-control/database.js';
import { initializeSquad } from '../src/mission-control/squad.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('resolveAgentForChannel', () => {
  let db: MissionControlDB;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'routing-test-'));
    db = new MissionControlDB(tempDir);
    initializeSquad(db);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return Jarvis agent ID for Telegram DMs', () => {
    const jarvis = db.getAgentBySessionKey('agent:main:main');
    expect(jarvis).toBeDefined();

    const agentId = resolveAgentForChannel('telegram', undefined, db);
    expect(agentId).toBe(jarvis!.id);
  });

  it('should return undefined for Telegram group messages', () => {
    const agentId = resolveAgentForChannel('telegram', 'group-123', db);
    expect(agentId).toBeUndefined();
  });

  it('should return undefined for non-Telegram channels', () => {
    expect(resolveAgentForChannel('discord', undefined, db)).toBeUndefined();
    expect(resolveAgentForChannel('webchat', undefined, db)).toBeUndefined();
    expect(resolveAgentForChannel('slack', undefined, db)).toBeUndefined();
  });

  it('should return undefined when Jarvis not found in DB', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'routing-empty-'));
    const emptyDb = new MissionControlDB(emptyDir);

    const agentId = resolveAgentForChannel('telegram', undefined, emptyDb);
    expect(agentId).toBeUndefined();

    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('should return undefined for api channel type', () => {
    const agentId = resolveAgentForChannel('api', undefined, db);
    expect(agentId).toBeUndefined();
  });
});
