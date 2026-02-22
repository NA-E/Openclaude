import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MissionControlDB } from '../src/mission-control/database.js';
import { initializeSquad, SQUAD_ROSTER } from '../src/mission-control/squad.js';
import { NotificationDaemon } from '../src/notifications/daemon.js';
import { DailyStandupGenerator } from '../src/standup/generator.js';
import { AgentMemoryStack } from '../src/mission-control/memory-stack.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MissionControlDB', () => {
  let db: MissionControlDB;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mc-test-'));
    db = new MissionControlDB(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create and retrieve agents', () => {
    const agent = db.createAgent({
      name: 'TestBot',
      role: 'Tester',
      sessionKey: 'agent:test:main',
      status: 'idle',
      level: 'specialist',
      currentTaskId: null,
      avatar: 'T',
      skills: ['testing'],
      heartbeatCron: '*/15 * * * *',
      lastHeartbeat: null,
    });

    expect(agent.id).toBeTruthy();
    expect(db.getAgent(agent.id)?.name).toBe('TestBot');
    expect(db.getAgentByName('TestBot')).toBeDefined();
    expect(db.getAgentBySessionKey('agent:test:main')).toBeDefined();
  });

  it('should create tasks with full lifecycle', () => {
    const agent = db.createAgent({
      name: 'Worker', role: 'Dev', sessionKey: 'agent:dev:main',
      status: 'idle', level: 'specialist', currentTaskId: null,
      avatar: 'W', skills: [], heartbeatCron: '*/15 * * * *', lastHeartbeat: null,
    });

    const task = db.createTask({
      title: 'Build feature X',
      description: 'Implement the new feature',
      status: 'inbox',
      priority: 'high',
      assigneeIds: [agent.id],
      creatorId: agent.id,
      parentTaskId: null,
      tags: ['feature'],
      dueDate: null,
    });

    expect(task.id).toBeTruthy();
    expect(task.status).toBe('inbox');

    // Update status
    const updated = db.updateTask(task.id, { status: 'in_progress' }, agent.id);
    expect(updated?.status).toBe('in_progress');

    // Check activities were logged
    const activities = db.getActivities(10);
    expect(activities.length).toBeGreaterThanOrEqual(2); // create + status change
  });

  it('should handle task board grouping', () => {
    const agent = db.createAgent({
      name: 'Worker', role: 'Dev', sessionKey: 'agent:dev:main',
      status: 'idle', level: 'specialist', currentTaskId: null,
      avatar: 'W', skills: [], heartbeatCron: '*/15 * * * *', lastHeartbeat: null,
    });

    db.createTask({ title: 'Task 1', description: '', status: 'inbox', priority: 'medium', assigneeIds: [], creatorId: agent.id, parentTaskId: null, tags: [], dueDate: null });
    db.createTask({ title: 'Task 2', description: '', status: 'in_progress', priority: 'high', assigneeIds: [agent.id], creatorId: agent.id, parentTaskId: null, tags: [], dueDate: null });
    db.createTask({ title: 'Task 3', description: '', status: 'done', priority: 'low', assigneeIds: [], creatorId: agent.id, parentTaskId: null, tags: [], dueDate: null });

    const grouped = db.getTasksByStatus();
    expect(grouped.inbox.length).toBe(1);
    expect(grouped.in_progress.length).toBe(1);
    expect(grouped.done.length).toBe(1);
  });

  it('should create messages with @mention notifications', () => {
    const agent1 = db.createAgent({
      name: 'Alice', role: 'Lead', sessionKey: 'agent:alice:main',
      status: 'idle', level: 'lead', currentTaskId: null,
      avatar: 'A', skills: [], heartbeatCron: '*/15 * * * *', lastHeartbeat: null,
    });
    const agent2 = db.createAgent({
      name: 'Bob', role: 'Dev', sessionKey: 'agent:bob:main',
      status: 'idle', level: 'specialist', currentTaskId: null,
      avatar: 'B', skills: [], heartbeatCron: '*/15 * * * *', lastHeartbeat: null,
    });

    const task = db.createTask({
      title: 'Review code', description: '', status: 'review', priority: 'medium',
      assigneeIds: [agent2.id], creatorId: agent1.id, parentTaskId: null, tags: [], dueDate: null,
    });

    const msg = db.createMessage({
      taskId: task.id,
      fromAgentId: agent1.id,
      content: '@Bob please review this code',
      attachments: [],
      mentions: [agent2.id],
    });

    expect(msg.id).toBeTruthy();

    // Should have created a notification for Bob
    const notifs = db.getUndeliveredNotifications(agent2.id);
    expect(notifs.length).toBeGreaterThanOrEqual(1);
  });

  it('should create and list documents', () => {
    const agent = db.createAgent({
      name: 'Writer', role: 'Content', sessionKey: 'agent:writer:main',
      status: 'idle', level: 'specialist', currentTaskId: null,
      avatar: 'W', skills: [], heartbeatCron: '*/15 * * * *', lastHeartbeat: null,
    });

    const doc = db.createDocument({
      title: 'Blog Post Draft',
      content: '# My Blog Post\n\nThis is the content.',
      type: 'draft',
      taskId: null,
      authorId: agent.id,
    });

    expect(doc.id).toBeTruthy();
    expect(doc.version).toBe(1);

    const docs = db.listDocuments({ type: 'draft' });
    expect(docs.length).toBe(1);
  });

  it('should return correct stats', () => {
    const agent = db.createAgent({
      name: 'Stat', role: 'Dev', sessionKey: 'agent:stat:main',
      status: 'active', level: 'specialist', currentTaskId: null,
      avatar: 'S', skills: [], heartbeatCron: '*/15 * * * *', lastHeartbeat: null,
    });

    db.createTask({ title: 'T1', description: '', status: 'inbox', priority: 'medium', assigneeIds: [], creatorId: agent.id, parentTaskId: null, tags: [], dueDate: null });
    db.createTask({ title: 'T2', description: '', status: 'in_progress', priority: 'high', assigneeIds: [agent.id], creatorId: agent.id, parentTaskId: null, tags: [], dueDate: null });

    const stats = db.getStats();
    expect(stats.totalAgents).toBe(1);
    expect(stats.activeAgents).toBe(1);
    expect(stats.totalTasks).toBe(2);
    expect(stats.tasksByStatus.inbox).toBe(1);
    expect(stats.tasksByStatus.in_progress).toBe(1);
  });
});

describe('Squad Initialization', () => {
  it('should initialize all 10 agents', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'squad-test-'));
    const db = new MissionControlDB(tempDir);
    const agents = initializeSquad(db);

    expect(agents.length).toBe(10);
    expect(agents.map((a) => a.name).sort()).toEqual(
      ['Friday', 'Fury', 'Jarvis', 'Loki', 'Pepper', 'Quill', 'Shuri', 'Vision', 'Wanda', 'Wong'],
    );

    // Idempotent — running again shouldn't duplicate
    const agents2 = initializeSquad(db);
    expect(agents2.length).toBe(10);
    expect(db.listAgents().length).toBe(10);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should have correct squad roster', () => {
    expect(SQUAD_ROSTER.length).toBe(10);
    expect(SQUAD_ROSTER.find((m) => m.name === 'Jarvis')?.level).toBe('lead');
    expect(SQUAD_ROSTER.find((m) => m.name === 'Jarvis')?.sessionKey).toBe('agent:main:main');
  });
});

describe('NotificationDaemon', () => {
  it('should parse @mentions from content', () => {
    const names = ['Jarvis', 'Shuri', 'Fury', 'Vision'];

    expect(NotificationDaemon.parseMentions('@Shuri please review', names)).toEqual(['Shuri']);
    expect(NotificationDaemon.parseMentions('@all team meeting', names)).toEqual(names);
    expect(NotificationDaemon.parseMentions('no mentions here', names)).toEqual([]);
    expect(NotificationDaemon.parseMentions('@Fury and @Vision collab', names)).toEqual(['Fury', 'Vision']);
  });
});

describe('AgentMemoryStack', () => {
  let stack: AgentMemoryStack;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memstack-test-'));
    stack = new AgentMemoryStack(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should read/write working memory', () => {
    stack.setWorkingMemory('agent:test:main', '# Current Task\nDoing stuff');
    const wm = stack.getWorkingMemory('agent:test:main');
    expect(wm).toContain('Current Task');
  });

  it('should append daily notes', () => {
    stack.appendDailyNote('agent:test:main', 'Did thing 1');
    stack.appendDailyNote('agent:test:main', 'Did thing 2');
    const notes = stack.getTodayNotes('agent:test:main');
    expect(notes).toContain('Did thing 1');
    expect(notes).toContain('Did thing 2');
  });

  it('should manage long-term memory', () => {
    stack.appendLongTermMemory('agent:test:main', 'Important lesson learned');
    const ltm = stack.getLongTermMemory('agent:test:main');
    expect(ltm).toContain('Important lesson learned');
  });

  it('should get full context', () => {
    stack.setWorkingMemory('agent:test:main', 'Working on X');
    stack.appendDailyNote('agent:test:main', 'Started X');
    stack.appendLongTermMemory('agent:test:main', 'Key fact');

    const ctx = stack.getFullContext('agent:test:main');
    expect(ctx).toContain('Working on X');
    expect(ctx).toContain('Started X');
    expect(ctx).toContain('Key fact');
  });

  it('should generate default heartbeat checklist', () => {
    const checklist = stack.getHeartbeatChecklist('agent:test:main');
    expect(checklist).toContain('On Wake');
    expect(checklist).toContain('WORKING.md');
  });
});

describe('DailyStandupGenerator', () => {
  it('should generate a standup report', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'standup-test-'));
    const db = new MissionControlDB(tempDir);
    initializeSquad(db);

    // Create some tasks
    const jarvis = db.getAgentByName('Jarvis')!;
    const loki = db.getAgentByName('Loki')!;

    db.createTask({
      title: 'Write blog post', description: 'SEO optimized', status: 'in_progress',
      priority: 'high', assigneeIds: [loki.id], creatorId: jarvis.id,
      parentTaskId: null, tags: ['content'], dueDate: null,
    });

    db.createTask({
      title: 'Review homepage', description: 'Check UX', status: 'review',
      priority: 'medium', assigneeIds: [jarvis.id], creatorId: jarvis.id,
      parentTaskId: null, tags: [], dueDate: null,
    });

    // Generate standup (without gateway, just the text)
    const generator = new DailyStandupGenerator(db, { broadcast: () => {} } as any);
    const standup = generator.generate();

    expect(standup).toContain('DAILY STANDUP');
    expect(standup).toContain('IN PROGRESS');
    expect(standup).toContain('NEEDS REVIEW');
    expect(standup).toContain('AGENT STATUS');
    expect(standup).toContain('Jarvis');
    expect(standup).toContain('Loki');

    rmSync(tempDir, { recursive: true, force: true });
  });
});
