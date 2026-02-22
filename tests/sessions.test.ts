import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/gateway/sessions.js';

describe('SessionManager', () => {
  it('should create sessions for new senders', () => {
    const manager = new SessionManager();
    const session = manager.getOrCreate({
      channelId: 'test-channel',
      senderId: 'user-1',
      channelType: 'webchat',
    });

    expect(session).toBeDefined();
    expect(session.senderId).toBe('user-1');
    expect(session.type).toBe('main');
    expect(session.status).toBe('active');
  });

  it('should return same session for same sender', () => {
    const manager = new SessionManager();
    const session1 = manager.getOrCreate({
      channelId: 'test-channel',
      senderId: 'user-1',
      channelType: 'webchat',
    });
    const session2 = manager.getOrCreate({
      channelId: 'test-channel',
      senderId: 'user-1',
      channelType: 'webchat',
    });

    expect(session1.id).toBe(session2.id);
  });

  it('should create separate sessions per channel type', () => {
    const manager = new SessionManager();
    const session1 = manager.getOrCreate({
      channelId: 'ch-1',
      senderId: 'user-1',
      channelType: 'webchat',
    });
    const session2 = manager.getOrCreate({
      channelId: 'ch-2',
      senderId: 'user-1',
      channelType: 'discord',
    });

    expect(session1.id).not.toBe(session2.id);
  });

  it('should create group sessions', () => {
    const manager = new SessionManager();
    const session = manager.getOrCreate({
      channelId: 'group-ch',
      senderId: 'user-1',
      channelType: 'discord',
      groupId: 'group-123',
    });

    expect(session.type).toBe('group');
    expect(session.activationMode).toBe('mention');
  });

  it('should handle pairing codes', () => {
    const manager = new SessionManager();

    expect(manager.isSenderApproved('user-1')).toBe(false);

    const code = manager.generatePairingCode('user-1');
    expect(code).toBeTruthy();
    expect(code.length).toBe(6);

    const approved = manager.approvePairingCode(code);
    expect(approved).toBe(true);
    expect(manager.isSenderApproved('user-1')).toBe(true);
  });

  it('should reject invalid pairing codes', () => {
    const manager = new SessionManager();
    const approved = manager.approvePairingCode('INVALID');
    expect(approved).toBe(false);
  });

  it('should create agent-to-agent sessions', () => {
    const manager = new SessionManager();
    const session = manager.createAgentSession('agent-1', 'agent-2');

    expect(session.type).toBe('agent-to-agent');
    expect(session.agentId).toBe('agent-2');
    expect(session.senderId).toBe('agent-1');
  });

  it('should list all sessions', () => {
    const manager = new SessionManager();
    manager.getOrCreate({ channelId: 'ch-1', senderId: 'user-1', channelType: 'webchat' });
    manager.getOrCreate({ channelId: 'ch-2', senderId: 'user-2', channelType: 'discord' });

    const all = manager.listAll();
    expect(all.length).toBe(2);
  });

  it('should list sessions for specific agent', () => {
    const manager = new SessionManager();
    manager.getOrCreate({ channelId: 'ch-1', senderId: 'user-1', channelType: 'webchat' });
    manager.getOrCreate({ channelId: 'ch-2', senderId: 'user-2', channelType: 'discord' });

    const defaultSessions = manager.listForAgent('default');
    expect(defaultSessions.length).toBe(2);
  });
});
