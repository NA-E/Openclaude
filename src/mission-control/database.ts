/**
 * Mission Control Database — The shared brain.
 *
 * From the article: "All agents read and write to the same database.
 * When Fury posts a comment, everyone can see it."
 *
 * Six tables power everything: agents, tasks, messages, activities,
 * documents, notifications. We use a local JSON file store
 * (swappable for Convex/Postgres in production).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { v4 as uuid } from 'uuid';
import { logger } from '../utils/logger.js';

// ─── Schema ──────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'active' | 'blocked';
export type AgentLevel = 'intern' | 'specialist' | 'lead';
export type TaskStatus = 'inbox' | 'assigned' | 'in_progress' | 'review' | 'done' | 'blocked';
export type DocumentType = 'deliverable' | 'research' | 'protocol' | 'reference' | 'draft';
export type ActivityType =
  | 'task_created'
  | 'task_updated'
  | 'task_assigned'
  | 'task_status_changed'
  | 'message_sent'
  | 'document_created'
  | 'agent_heartbeat'
  | 'agent_woke_up'
  | 'mention';

export interface MCAgent {
  id: string;
  name: string;
  role: string;
  sessionKey: string;
  status: AgentStatus;
  level: AgentLevel;
  currentTaskId: string | null;
  avatar: string;
  skills: string[];
  heartbeatCron: string;
  lastHeartbeat: string | null;
  createdAt: string;
}

export interface MCTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assigneeIds: string[];
  creatorId: string;
  parentTaskId: string | null;
  tags: string[];
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MCMessage {
  id: string;
  taskId: string;
  fromAgentId: string;
  content: string;
  attachments: string[];  // document IDs
  mentions: string[];     // agent IDs mentioned with @
  createdAt: string;
}

export interface MCActivity {
  id: string;
  type: ActivityType;
  agentId: string;
  taskId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MCDocument {
  id: string;
  title: string;
  content: string;
  type: DocumentType;
  taskId: string | null;
  authorId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MCNotification {
  id: string;
  mentionedAgentId: string;
  fromAgentId: string;
  taskId: string | null;
  content: string;
  delivered: boolean;
  createdAt: string;
}

interface MCDatabase {
  agents: MCAgent[];
  tasks: MCTask[];
  messages: MCMessage[];
  activities: MCActivity[];
  documents: MCDocument[];
  notifications: MCNotification[];
}

// ─── Store ───────────────────────────────────────────────────────

export class MissionControlDB {
  private db: MCDatabase;
  private dbPath: string;
  private subscribers: Map<string, ((event: { table: string; action: string; data: unknown }) => void)[]> = new Map();

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.dbPath = resolve(dataDir, 'mission-control.json');
    this.db = this.load();
  }

  private load(): MCDatabase {
    if (existsSync(this.dbPath)) {
      try {
        return JSON.parse(readFileSync(this.dbPath, 'utf-8'));
      } catch {
        logger.warn('MissionControlDB', 'Corrupted DB file, starting fresh');
      }
    }
    return { agents: [], tasks: [], messages: [], activities: [], documents: [], notifications: [] };
  }

  private save() {
    writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2), 'utf-8');
  }

  private emit(table: string, action: string, data: unknown) {
    const handlers = this.subscribers.get('*') || [];
    const tableHandlers = this.subscribers.get(table) || [];
    for (const handler of [...handlers, ...tableHandlers]) {
      handler({ table, action, data });
    }
  }

  subscribe(table: string, handler: (event: { table: string; action: string; data: unknown }) => void) {
    const existing = this.subscribers.get(table) || [];
    existing.push(handler);
    this.subscribers.set(table, existing);
  }

  // ─── Agents ─────────────────────────────────────────────────

  createAgent(agent: Omit<MCAgent, 'id' | 'createdAt'>): MCAgent {
    const record: MCAgent = { ...agent, id: uuid(), createdAt: new Date().toISOString() };
    this.db.agents.push(record);
    this.save();
    this.emit('agents', 'created', record);
    logger.info('MissionControlDB', `Agent created: ${record.name} (${record.role})`);
    return record;
  }

  getAgent(id: string): MCAgent | undefined {
    return this.db.agents.find((a) => a.id === id);
  }

  getAgentByName(name: string): MCAgent | undefined {
    return this.db.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  }

  getAgentBySessionKey(key: string): MCAgent | undefined {
    return this.db.agents.find((a) => a.sessionKey === key);
  }

  listAgents(): MCAgent[] {
    return [...this.db.agents];
  }

  updateAgent(id: string, updates: Partial<MCAgent>): MCAgent | undefined {
    const idx = this.db.agents.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;
    this.db.agents[idx] = { ...this.db.agents[idx], ...updates };
    this.save();
    this.emit('agents', 'updated', this.db.agents[idx]);
    return this.db.agents[idx];
  }

  // ─── Tasks ──────────────────────────────────────────────────

  createTask(task: Omit<MCTask, 'id' | 'createdAt' | 'updatedAt'>): MCTask {
    const now = new Date().toISOString();
    const record: MCTask = { ...task, id: uuid(), createdAt: now, updatedAt: now };
    this.db.tasks.push(record);
    this.save();

    this.logActivity({
      type: 'task_created',
      agentId: task.creatorId,
      taskId: record.id,
      message: `Created task: ${task.title}`,
      metadata: {},
    });

    this.emit('tasks', 'created', record);
    return record;
  }

  getTask(id: string): MCTask | undefined {
    return this.db.tasks.find((t) => t.id === id);
  }

  listTasks(filter?: { status?: TaskStatus; assigneeId?: string }): MCTask[] {
    let tasks = [...this.db.tasks];
    if (filter?.status) tasks = tasks.filter((t) => t.status === filter.status);
    if (filter?.assigneeId) tasks = tasks.filter((t) => t.assigneeIds.includes(filter.assigneeId!));
    return tasks;
  }

  updateTask(id: string, updates: Partial<MCTask>, actorId?: string): MCTask | undefined {
    const idx = this.db.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return undefined;

    const oldTask = this.db.tasks[idx];
    this.db.tasks[idx] = { ...oldTask, ...updates, updatedAt: new Date().toISOString() };
    this.save();

    // Log status changes
    if (updates.status && updates.status !== oldTask.status) {
      this.logActivity({
        type: 'task_status_changed',
        agentId: actorId || 'system',
        taskId: id,
        message: `Task "${oldTask.title}" moved from ${oldTask.status} to ${updates.status}`,
        metadata: { from: oldTask.status, to: updates.status },
      });
    }

    // Log assignments
    if (updates.assigneeIds) {
      const newAssignees = updates.assigneeIds.filter((a) => !oldTask.assigneeIds.includes(a));
      for (const assigneeId of newAssignees) {
        const agent = this.getAgent(assigneeId);
        this.logActivity({
          type: 'task_assigned',
          agentId: actorId || 'system',
          taskId: id,
          message: `Assigned ${agent?.name || assigneeId} to "${oldTask.title}"`,
          metadata: { assigneeId },
        });
      }
    }

    this.emit('tasks', 'updated', this.db.tasks[idx]);
    return this.db.tasks[idx];
  }

  getTasksByStatus(): Record<TaskStatus, MCTask[]> {
    const grouped: Record<TaskStatus, MCTask[]> = {
      inbox: [], assigned: [], in_progress: [], review: [], done: [], blocked: [],
    };
    for (const task of this.db.tasks) {
      grouped[task.status].push(task);
    }
    return grouped;
  }

  // ─── Messages (Task Comments) ───────────────────────────────

  createMessage(msg: Omit<MCMessage, 'id' | 'createdAt'>): MCMessage {
    const record: MCMessage = { ...msg, id: uuid(), createdAt: new Date().toISOString() };
    this.db.messages.push(record);
    this.save();

    const agent = this.getAgent(msg.fromAgentId);
    const task = this.getTask(msg.taskId);
    this.logActivity({
      type: 'message_sent',
      agentId: msg.fromAgentId,
      taskId: msg.taskId,
      message: `${agent?.name || msg.fromAgentId} commented on "${task?.title || msg.taskId}"`,
      metadata: { preview: msg.content.slice(0, 100) },
    });

    // Create notifications for @mentions
    for (const mentionedId of msg.mentions) {
      this.createNotification({
        mentionedAgentId: mentionedId,
        fromAgentId: msg.fromAgentId,
        taskId: msg.taskId,
        content: `${agent?.name || 'Someone'} mentioned you in "${task?.title || 'a task'}": ${msg.content.slice(0, 200)}`,
        delivered: false,
      });
    }

    // Create notifications for thread subscribers (agents who've commented on this task)
    const threadParticipants = new Set(
      this.db.messages
        .filter((m) => m.taskId === msg.taskId && m.fromAgentId !== msg.fromAgentId)
        .map((m) => m.fromAgentId),
    );
    // Also include assignees
    if (task) {
      for (const id of task.assigneeIds) threadParticipants.add(id);
    }
    // Remove already-mentioned agents and the sender
    for (const mentionedId of msg.mentions) threadParticipants.delete(mentionedId);
    threadParticipants.delete(msg.fromAgentId);

    for (const participantId of threadParticipants) {
      this.createNotification({
        mentionedAgentId: participantId,
        fromAgentId: msg.fromAgentId,
        taskId: msg.taskId,
        content: `${agent?.name || 'Someone'} posted in "${task?.title || 'a task'}" (subscribed): ${msg.content.slice(0, 200)}`,
        delivered: false,
      });
    }

    this.emit('messages', 'created', record);
    return record;
  }

  getMessages(taskId: string): MCMessage[] {
    return this.db.messages.filter((m) => m.taskId === taskId).sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  // ─── Activities ─────────────────────────────────────────────

  logActivity(activity: Omit<MCActivity, 'id' | 'createdAt'>): MCActivity {
    const record: MCActivity = { ...activity, id: uuid(), createdAt: new Date().toISOString() };
    this.db.activities.push(record);
    // Keep last 1000 activities
    if (this.db.activities.length > 1000) {
      this.db.activities = this.db.activities.slice(-1000);
    }
    this.save();
    this.emit('activities', 'created', record);
    return record;
  }

  getActivities(limit = 50, since?: string): MCActivity[] {
    let activities = [...this.db.activities];
    if (since) {
      const sinceDate = new Date(since).getTime();
      activities = activities.filter((a) => new Date(a.createdAt).getTime() > sinceDate);
    }
    return activities.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ).slice(0, limit);
  }

  getActivitiesForAgent(agentId: string, limit = 20): MCActivity[] {
    return this.db.activities
      .filter((a) => a.agentId === agentId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  // ─── Documents ──────────────────────────────────────────────

  createDocument(doc: Omit<MCDocument, 'id' | 'createdAt' | 'updatedAt' | 'version'>): MCDocument {
    const now = new Date().toISOString();
    const record: MCDocument = { ...doc, id: uuid(), version: 1, createdAt: now, updatedAt: now };
    this.db.documents.push(record);
    this.save();

    const agent = this.getAgent(doc.authorId);
    this.logActivity({
      type: 'document_created',
      agentId: doc.authorId,
      taskId: doc.taskId,
      message: `${agent?.name || doc.authorId} created document: ${doc.title}`,
      metadata: { type: doc.type },
    });

    this.emit('documents', 'created', record);
    return record;
  }

  getDocument(id: string): MCDocument | undefined {
    return this.db.documents.find((d) => d.id === id);
  }

  listDocuments(filter?: { taskId?: string; type?: DocumentType; authorId?: string }): MCDocument[] {
    let docs = [...this.db.documents];
    if (filter?.taskId) docs = docs.filter((d) => d.taskId === filter.taskId);
    if (filter?.type) docs = docs.filter((d) => d.type === filter.type);
    if (filter?.authorId) docs = docs.filter((d) => d.authorId === filter.authorId);
    return docs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  updateDocument(id: string, updates: Partial<MCDocument>): MCDocument | undefined {
    const idx = this.db.documents.findIndex((d) => d.id === id);
    if (idx === -1) return undefined;
    this.db.documents[idx] = {
      ...this.db.documents[idx],
      ...updates,
      version: this.db.documents[idx].version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    this.emit('documents', 'updated', this.db.documents[idx]);
    return this.db.documents[idx];
  }

  // ─── Notifications ──────────────────────────────────────────

  createNotification(notif: Omit<MCNotification, 'id' | 'createdAt'>): MCNotification {
    const record: MCNotification = { ...notif, id: uuid(), createdAt: new Date().toISOString() };
    this.db.notifications.push(record);
    this.save();
    this.emit('notifications', 'created', record);
    return record;
  }

  getUndeliveredNotifications(agentId?: string): MCNotification[] {
    let notifs = this.db.notifications.filter((n) => !n.delivered);
    if (agentId) notifs = notifs.filter((n) => n.mentionedAgentId === agentId);
    return notifs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  markNotificationDelivered(id: string) {
    const idx = this.db.notifications.findIndex((n) => n.id === id);
    if (idx !== -1) {
      this.db.notifications[idx].delivered = true;
      this.save();
    }
  }

  // ─── Summary / Stats ───────────────────────────────────────

  getStats() {
    const tasks = this.getTasksByStatus();
    return {
      totalAgents: this.db.agents.length,
      activeAgents: this.db.agents.filter((a) => a.status === 'active').length,
      totalTasks: this.db.tasks.length,
      tasksByStatus: {
        inbox: tasks.inbox.length,
        assigned: tasks.assigned.length,
        in_progress: tasks.in_progress.length,
        review: tasks.review.length,
        done: tasks.done.length,
        blocked: tasks.blocked.length,
      },
      totalMessages: this.db.messages.length,
      totalDocuments: this.db.documents.length,
      pendingNotifications: this.db.notifications.filter((n) => !n.delivered).length,
      recentActivities: this.getActivities(10),
    };
  }
}
