/**
 * Session Manager — Manages isolated agent sessions.
 *
 * OpenClaw routes each DM/group into an isolated session.
 * Sessions support main chats, group isolation, and agent-to-agent comms.
 */

import { v4 as uuid } from 'uuid';
import type { Session, ChannelType, Message } from '../types/index.js';
import { logger } from '../utils/logger.js';

interface GetOrCreateParams {
  channelId: string;
  senderId: string;
  channelType: ChannelType | 'api';
  groupId?: string;
  agentId?: string;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private senderToSession: Map<string, string> = new Map();
  private approvedSenders: Set<string> = new Set();
  private pairingCodes: Map<string, string> = new Map(); // code -> senderId

  getOrCreate(params: GetOrCreateParams): Session {
    const key = params.groupId
      ? `group:${params.channelType}:${params.groupId}`
      : `dm:${params.channelType}:${params.senderId}`;

    const existingId = this.senderToSession.get(key);
    if (existingId) {
      const session = this.sessions.get(existingId);
      if (session) {
        session.updatedAt = new Date();
        return session;
      }
    }

    const session: Session = {
      id: uuid(),
      agentId: params.agentId || 'default',
      channelId: params.channelId,
      senderId: params.senderId,
      type: params.groupId ? 'group' : 'main',
      status: 'active',
      activationMode: params.groupId ? 'mention' : 'always',
      messages: [],
      metadata: { channelType: params.channelType, groupId: params.groupId },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.sessions.set(session.id, session);
    this.senderToSession.set(key, session.id);
    logger.info('Sessions', `Created session ${session.id} for ${key}`);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listAll(): Session[] {
    return Array.from(this.sessions.values());
  }

  listForAgent(agentId: string): Session[] {
    return this.listAll().filter((s) => s.agentId === agentId);
  }

  addMessage(sessionId: string, message: Message) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push(message);
    session.updatedAt = new Date();

    // Keep last 200 messages per session to manage memory
    if (session.messages.length > 200) {
      session.messages = session.messages.slice(-200);
    }
  }

  // ─── DM Pairing Security ──────────────────────────────────────

  isSenderApproved(senderId: string): boolean {
    return this.approvedSenders.has(senderId);
  }

  approveSender(senderId: string) {
    this.approvedSenders.add(senderId);
  }

  generatePairingCode(senderId: string): string {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    this.pairingCodes.set(code, senderId);
    return code;
  }

  approvePairingCode(code: string): boolean {
    const senderId = this.pairingCodes.get(code);
    if (!senderId) return false;
    this.approvedSenders.add(senderId);
    this.pairingCodes.delete(code);
    logger.info('Sessions', `Approved sender ${senderId} via pairing code ${code}`);
    return true;
  }

  // ─── Agent-to-Agent Communication ─────────────────────────────

  createAgentSession(fromAgentId: string, toAgentId: string): Session {
    const session: Session = {
      id: uuid(),
      agentId: toAgentId,
      channelId: `agent:${fromAgentId}`,
      senderId: fromAgentId,
      type: 'agent-to-agent',
      status: 'active',
      activationMode: 'always',
      messages: [],
      metadata: { fromAgent: fromAgentId, toAgent: toAgentId },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(session.id, session);
    return session;
  }
}
