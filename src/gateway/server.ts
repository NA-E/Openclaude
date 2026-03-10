/**
 * Gateway Server — The WebSocket + HTTP control plane.
 *
 * OpenClaw's Gateway manages sessions, channels, tools, and events.
 * OpenClaude mirrors this: a single Gateway orchestrates everything.
 *
 * - WebSocket on ws://host:port for real-time agent/channel events
 * - HTTP REST API for management, health, and dashboard serving
 */

import { createServer, type IncomingMessage, type Server } from 'http';
import express, { type Express } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import { logger } from '../utils/logger.js';
import { diagnostics } from '../utils/diagnostics.js';
import type {
  GatewayEvent,
  InboundMessage,
  SystemStatus,
  OpenClaudeConfig,
  Session,
} from '../types/index.js';
import { SessionManager } from './sessions.js';
import { ChannelRouter } from './router.js';
import { AgentOrchestrator } from '../agent/orchestrator.js';
import { MemoryFileStore } from '../memory/store.js';
import { SkillRegistry } from '../skills/registry.js';
import { TaskScheduler } from '../scheduler/scheduler.js';
import { MissionControlDB } from '../mission-control/database.js';
import { initializeSquad, SQUAD_ROSTER, SQUAD_LEAD_SESSION_KEY } from '../mission-control/squad.js';
import { HeartbeatSystem } from '../mission-control/heartbeat.js';
import { AgentMemoryStack } from '../mission-control/memory-stack.js';
import { NotificationDaemon } from '../notifications/daemon.js';
import { DailyStandupGenerator } from '../standup/generator.js';
import { resolve } from 'path';
import { detectAccounts, getCurrentAccountId, setAccount } from '../agent/subprocess-client.js';
import { ProjectManager } from '../projects/manager.js';
import { WorkerPool } from '../workers/pool.js';
import { WorkerStore } from '../workers/store.js';
import { WorkerOrchestrator } from '../workers/orchestrator.js';
import { homedir } from 'os';
import type { WorkerSummary, ApprovalRequest } from '../workers/types.js';

/**
 * Resolve which agent should handle a message based on channel type and context.
 * Telegram DMs (no groupId) route to the Jarvis agent (squad lead).
 * All other channels use the default agent.
 */
export function resolveAgentForChannel(
  channelType: string,
  groupId: string | undefined,
  mcDb: { getAgentBySessionKey(key: string): { id: string } | undefined },
): string | undefined {
  if (channelType === 'telegram' && !groupId) {
    const jarvis = mcDb.getAgentBySessionKey(SQUAD_LEAD_SESSION_KEY);
    if (jarvis) return jarvis.id;
  }
  return undefined;
}

export class Gateway {
  private app: Express;
  private server: Server;
  private wss: WebSocketServer;
  private clients: Map<string, WebSocket> = new Map();
  private config: OpenClaudeConfig;

  public sessions: SessionManager;
  public router: ChannelRouter;
  public orchestrator: AgentOrchestrator;
  public memory: MemoryFileStore;
  public skills: SkillRegistry;
  public scheduler: TaskScheduler;

  // Mission Control subsystems
  public mcDb: MissionControlDB;
  public heartbeat: HeartbeatSystem;
  public memoryStack: AgentMemoryStack;
  public notificationDaemon: NotificationDaemon;
  public standupGenerator: DailyStandupGenerator;
  public projectManager: ProjectManager;

  // Worker subsystems (Master-Worker)
  public workerStore: WorkerStore;
  public workerPool: WorkerPool;
  public workerOrchestrator: WorkerOrchestrator;

  private startTime: number = Date.now();
  private activeProject: string | null = null;

  constructor(config: OpenClaudeConfig) {
    this.config = config;
    this.app = express();
    this.app.use(express.json());
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    // Initialize core subsystems
    this.memory = new MemoryFileStore(config.memory.dir);
    this.skills = new SkillRegistry(config.workspace);
    this.sessions = new SessionManager();
    this.orchestrator = new AgentOrchestrator(config, this.memory, this.skills);
    this.router = new ChannelRouter(config, this.handleInbound.bind(this));
    this.scheduler = new TaskScheduler(config, this.orchestrator, this);

    // Initialize project manager (scans parent directory for project folders)
    const projectsRoot = process.env.PROJECTS_ROOT || resolve(process.cwd(), '..');
    this.projectManager = new ProjectManager(projectsRoot);

    // Initialize Master-Worker subsystems
    const workerDataDir = resolve(homedir(), '.openclaude', 'workers');
    this.workerStore = new WorkerStore(workerDataDir);
    this.workerPool = new WorkerPool(this.workerStore);
    this.workerOrchestrator = new WorkerOrchestrator(this.workerPool);

    // Forward worker pool events to WebSocket clients
    this.workerPool.on('worker.event', (event: { type: string; data: unknown }) => {
      this.broadcast({ type: event.type as GatewayEvent['type'], data: event.data } as GatewayEvent);
    });
    this.workerPool.on('worker.output', (data: { workerId: string; projectName: string; accountId: string; chunk: string }) => {
      this.broadcast({ type: 'worker.output', data });
    });

    // Initialize Mission Control subsystems
    const mcDataDir = resolve(config.workspace, '..', 'mission-control');
    this.mcDb = new MissionControlDB(mcDataDir);
    this.memoryStack = new AgentMemoryStack(config.workspace);
    this.orchestrator.setMissionControlDB(this.mcDb);
    this.heartbeat = new HeartbeatSystem(this.mcDb, this.orchestrator, this.memoryStack);
    this.notificationDaemon = new NotificationDaemon(this.mcDb, this.orchestrator);
    this.standupGenerator = new DailyStandupGenerator(this.mcDb, this);

    this.setupWebSocket();
    this.setupHTTPRoutes();
    this.setupMissionControlRoutes();
  }

  // ─── WebSocket ─────────────────────────────────────────────────

  private setupWebSocket() {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const clientId = uuid();
      this.clients.set(clientId, ws);
      logger.info('Gateway', `Client connected: ${clientId} from ${req.socket.remoteAddress}`);

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleWSMessage(clientId, msg);
        } catch {
          logger.warn('Gateway', `Invalid message from ${clientId}`);
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        logger.info('Gateway', `Client disconnected: ${clientId}`);
      });

      // Send initial status
      this.broadcast({ type: 'system.status', data: this.getStatus() });
    });
  }

  private handleWSMessage(clientId: string, msg: { type: string; data?: unknown }) {
    switch (msg.type) {
      case 'message.send': {
        const data = msg.data as InboundMessage;
        this.handleInbound(data);
        break;
      }
      case 'session.list':
        this.sendTo(clientId, {
          type: 'session.updated',
          data: { session: {} as Session },
        });
        break;
      case 'system.status':
        this.sendTo(clientId, { type: 'system.status', data: this.getStatus() });
        break;
      default:
        logger.debug('Gateway', `Unknown WS message type: ${msg.type}`);
    }
  }

  public broadcast(event: GatewayEvent | { type: string; data: unknown }) {
    const payload = JSON.stringify(event);
    for (const [, ws] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  private sendTo(clientId: string, event: GatewayEvent) {
    const ws = this.clients.get(clientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  // ─── Inbound Message Handler ──────────────────────────────────

  private async handleInbound(message: InboundMessage) {
    logger.info('Gateway', `Inbound from ${message.channelType}/${message.senderId}: ${message.content.slice(0, 80)}`);
    diagnostics.recordEvent('message.in', { channelType: message.channelType, senderId: message.senderId });

    // Security: DM policy check
    if (this.config.security.dmPolicy === 'pairing' && !message.groupId) {
      if (!this.sessions.isSenderApproved(message.senderId)) {
        const code = this.sessions.generatePairingCode(message.senderId);
        await this.router.sendToChannel(message.channelType, {
          channelType: message.channelType,
          channelId: message.channelId,
          recipientId: message.senderId,
          content: `🔒 Pairing required. Your code: ${code}\nAsk the owner to approve with: /approve ${code}`,
        });
        return;
      }
    }

    this.broadcast({ type: 'message.inbound', data: message });

    // Route Telegram DMs to Jarvis (Squad Lead) instead of generic default agent
    const agentId = resolveAgentForChannel(message.channelType, message.groupId, this.mcDb);

    // Find or create session
    const session = this.sessions.getOrCreate({
      channelId: message.channelId,
      senderId: message.senderId,
      channelType: message.channelType,
      groupId: message.groupId,
      agentId,
    });

    this.broadcast({ type: 'agent.thinking', data: { agentId: session.agentId, sessionId: session.id } });

    // Run through Claude agent
    try {
      const response = await this.orchestrator.processMessage(session, message);

      this.broadcast({
        type: 'agent.response',
        data: { agentId: session.agentId, sessionId: session.id, content: response },
      });

      // Send response back through the originating channel
      await this.router.sendToChannel(message.channelType, {
        channelType: message.channelType,
        channelId: message.channelId,
        recipientId: message.senderId,
        content: response,
        replyToId: message.replyToId,
      });

      diagnostics.recordEvent('message.out', { channelType: message.channelType, sessionId: session.id });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Gateway', `Agent error in session ${session.id}`, err);
      diagnostics.recordEvent('error', { sessionId: session.id, error: errorMsg });
      this.broadcast({
        type: 'agent.error',
        data: { agentId: session.agentId, sessionId: session.id, error: errorMsg },
      });

      // Send a user-friendly error message back through the originating channel
      // so the user doesn't get complete silence (e.g. on subprocess timeout)
      try {
        await this.router.sendToChannel(message.channelType, {
          channelType: message.channelType,
          channelId: message.channelId,
          recipientId: message.senderId,
          content: 'Sorry, I ran into an issue and couldn\'t respond. Please try again.',
        });
      } catch (sendErr) {
        logger.error('Gateway', `Failed to send error message to ${message.channelType}`, sendErr);
      }
    }
  }

  // ─── HTTP Routes ──────────────────────────────────────────────

  private setupHTTPRoutes() {
    // Static UI serving
    const uiDir = resolve(process.cwd(), 'ui');
    this.app.get('/dashboard', (_req, res) => {
      res.sendFile(resolve(uiDir, 'dashboard', 'index.html'));
    });
    this.app.get('/mission-control', (_req, res) => {
      res.sendFile(resolve(uiDir, 'mission-control', 'index.html'));
    });

    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', uptime: Date.now() - this.startTime });
    });

    // System status
    this.app.get('/api/status', (_req, res) => {
      res.json(this.getStatus());
    });

    // Diagnostics
    this.app.get('/api/diagnostics', (_req, res) => {
      res.json({
        stats: diagnostics.getStats(),
        recentErrors: diagnostics.getErrors(20),
        recentEvents: diagnostics.getRecent(50),
      });
    });

    // Sessions
    this.app.get('/api/sessions', (_req, res) => {
      res.json(this.sessions.listAll());
    });

    this.app.get('/api/sessions/:id', (req, res) => {
      const session = this.sessions.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    });

    this.app.get('/api/sessions/:id/messages', (req, res) => {
      const session = this.sessions.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session.messages);
    });

    // Send message via API
    this.app.post('/api/message', async (req, res) => {
      const { content, channelType = 'api', channelId = 'api', senderId = 'api-user', senderName = 'API', groupId } = req.body;
      if (!content) return res.status(400).json({ error: 'content required' });

      const message: InboundMessage = {
        channelType,
        channelId,
        senderId,
        senderName,
        content,
        groupId,
      };

      try {
        const agentId = resolveAgentForChannel(channelType, groupId, this.mcDb);

        const session = this.sessions.getOrCreate({
          channelId,
          senderId,
          channelType,
          groupId,
          agentId,
        });
        const response = await this.orchestrator.processMessage(session, message);
        res.json({ response, sessionId: session.id });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
      }
    });

    // Agents
    this.app.get('/api/agents', (_req, res) => {
      res.json(this.orchestrator.listAgents());
    });

    // Skills
    this.app.get('/api/skills', (_req, res) => {
      res.json(this.skills.listSkills());
    });

    // Memory
    this.app.get('/api/memory', async (_req, res) => {
      const entries = await this.memory.getAllForAgent('default');
      res.json(entries);
    });

    // Scheduled tasks
    this.app.get('/api/tasks', (_req, res) => {
      res.json(this.scheduler.listTasks());
    });

    this.app.post('/api/tasks', (req, res) => {
      const task = this.scheduler.addTask(req.body);
      res.json(task);
    });

    // Approve pairing
    this.app.post('/api/approve/:code', (req, res) => {
      const ok = this.sessions.approvePairingCode(req.params.code);
      res.json({ approved: ok });
    });

    // Channels
    this.app.get('/api/channels', (_req, res) => {
      res.json(this.router.getChannelStatuses());
    });

    // Runtime config (model + account switching)
    this.app.get('/api/runtime', (_req, res) => {
      const accounts = detectAccounts();
      const currentAccount = getCurrentAccountId();
      const currentModel = this.config.agent.defaultModel;
      const availableModels = [
        { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', description: 'Fast, balanced' },
        { id: 'claude-opus-4-6', name: 'Opus 4.6', description: 'Most capable' },
        { id: 'claude-haiku-4-5', name: 'Haiku 4.5', description: 'Fastest, cheapest' },
      ];
      res.json({ currentAccount, currentModel, accounts, availableModels });
    });

    this.app.post('/api/runtime', (req, res) => {
      const { account, model } = req.body;
      const changes: string[] = [];

      if (account && account !== getCurrentAccountId()) {
        try {
          setAccount(account);
          changes.push(`account → ${account}`);
        } catch (err) {
          return res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to switch account' });
        }
      }

      if (model && model !== this.config.agent.defaultModel) {
        this.config.agent.defaultModel = model;
        changes.push(`model → ${model}`);
        logger.info('Gateway', `Model switched to: ${model}`);
      }

      if (changes.length === 0) {
        return res.json({ message: 'No changes', currentAccount: getCurrentAccountId(), currentModel: this.config.agent.defaultModel });
      }

      // Broadcast the change to all connected WS clients
      this.broadcast({
        type: 'system.status',
        data: this.getStatus(),
      });

      res.json({
        message: `Switched: ${changes.join(', ')}`,
        currentAccount: getCurrentAccountId(),
        currentModel: this.config.agent.defaultModel,
      });
    });

    // Projects — list all detected projects with account assignments
    this.app.get('/api/projects', (_req, res) => {
      const projects = this.projectManager.listProjects();
      res.json({ projects, activeProject: this.activeProject });
    });

    // Assign account to a project
    this.app.post('/api/projects/:name/account', (req, res) => {
      const { name } = req.params;
      const { account } = req.body;  // account ID or null to clear
      this.projectManager.assignAccount(name, account || null);
      res.json({ project: name, account: account || null });
    });

    // ─── Workers (Master-Worker) ───────────────────────────────

    // List all active workers
    this.app.get('/api/workers', (_req, res) => {
      const workers: WorkerSummary[] = this.workerPool.listWorkers();
      const approvals: ApprovalRequest[] = this.workerPool.getPendingApprovals();
      res.json({ workers, pendingApprovals: approvals });
    });

    // Spawn a worker for a project (no task yet)
    this.app.post('/api/workers', (req, res) => {
      const { projectName, projectPath, account } = req.body;
      if (!projectName || !projectPath) {
        return res.status(400).json({ error: 'projectName and projectPath required' });
      }
      const config = this.workerPool.createWorker(projectName, projectPath, account);
      if (!config) {
        return res.status(503).json({ error: 'No worker accounts available (acc2/acc3 both busy)' });
      }
      res.json(config);
    });

    // Dispatch a task to an existing worker (or spawn + dispatch in one call)
    this.app.post('/api/workers/dispatch', async (req, res) => {
      const { projectName, projectPath, title, description, account, mcTaskId } = req.body;
      if (!projectName || !projectPath || !title || !description) {
        return res.status(400).json({ error: 'projectName, projectPath, title, description required' });
      }

      const config = this.workerPool.createWorker(projectName, projectPath, account);
      if (!config) {
        return res.status(503).json({ error: 'No worker accounts available (acc2/acc3 both busy)' });
      }

      try {
        const result = await this.workerOrchestrator.dispatch(
          config.id, title, description, projectName, mcTaskId,
        );
        res.json({
          workerId: config.id,
          accountId: config.accountId,
          task: result.task,
          step: result.step,
          signal: result.signal,
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Dispatch failed' });
      }
    });

    // Continue a worker with a follow-up instruction
    this.app.post('/api/workers/:id/continue', async (req, res) => {
      const entry = this.workerPool.getWorkerEntry(req.params.id);
      if (!entry) return res.status(404).json({ error: 'Worker not found' });

      const { instruction } = req.body;
      if (!instruction) return res.status(400).json({ error: 'instruction required' });

      const lastStep = (entry.task?.steps || []).at(-1);
      const previousOutput = lastStep?.output || '';

      try {
        const result = await this.workerOrchestrator.continueWorker(
          req.params.id,
          previousOutput,
          instruction,
          entry.config.projectName,
          entry.task?.title || 'Task',
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Continue failed' });
      }
    });

    // Get worker logs
    this.app.get('/api/workers/:id/logs', (req, res) => {
      const steps = this.workerPool.getWorkerLogs(req.params.id);
      res.json(steps);
    });

    // Kill a worker
    this.app.delete('/api/workers/:id', (req, res) => {
      this.workerPool.killWorker(req.params.id);
      res.json({ killed: req.params.id });
    });

    // List pending approvals
    this.app.get('/api/workers/approvals', (_req, res) => {
      res.json(this.workerPool.getPendingApprovals());
    });

    // Approve
    this.app.post('/api/workers/approvals/:approvalId/approve', async (req, res) => {
      const { approvalId } = req.params;
      const approvals = this.workerPool.getPendingApprovals();
      const approval = approvals.find(a => a.id === approvalId);
      if (!approval) return res.status(404).json({ error: 'Approval not found' });

      const entry = this.workerPool.getWorkerEntry(approval.workerId);

      try {
        const result = await this.workerOrchestrator.proceedAfterApproval(
          approval.workerId,
          approvalId,
          approval.action,
          entry?.config.projectName || 'unknown',
          entry?.task?.title || 'Task',
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Post-approval step failed' });
      }
    });

    // Reject
    this.app.post('/api/workers/approvals/:approvalId/reject', (req, res) => {
      try {
        const approval = this.workerPool.resolveApproval(req.params.approvalId, 'rejected');
        res.json({ rejected: approval.id });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Reject failed' });
      }
    });

    // Select active project — auto-switches account
    this.app.post('/api/projects/:name/select', (req, res) => {
      const { name } = req.params;
      const projects = this.projectManager.listProjects();
      const project = projects.find(p => p.name === name);
      if (!project) {
        return res.status(404).json({ error: `Project "${name}" not found` });
      }

      this.activeProject = name;
      this.orchestrator.setProjectContext({ name: project.name, path: project.path });
      const changes: string[] = [`project → ${name}`];

      // Auto-switch account if project has one assigned
      if (project.account && project.account !== getCurrentAccountId()) {
        try {
          setAccount(project.account);
          changes.push(`account → ${project.account}`);
        } catch (err) {
          logger.warn('Gateway', `Failed to switch account for project ${name}: ${err}`);
        }
      }

      this.broadcast({ type: 'system.status', data: this.getStatus() });

      res.json({
        message: `Activated: ${changes.join(', ')}`,
        activeProject: name,
        currentAccount: getCurrentAccountId(),
      });
    });
  }

  // ─── Mission Control HTTP Routes ──────────────────────────────

  private setupMissionControlRoutes() {
    // Stats
    this.app.get('/api/mc/stats', (_req, res) => {
      res.json(this.mcDb.getStats());
    });

    // Agents
    this.app.get('/api/mc/agents', (_req, res) => {
      res.json(this.mcDb.listAgents());
    });

    // Tasks
    this.app.get('/api/mc/tasks', (req, res) => {
      const status = req.query.status as string | undefined;
      const assignee = req.query.assignee as string | undefined;
      let assigneeId: string | undefined;
      if (assignee) {
        const agent = this.mcDb.getAgentByName(assignee);
        assigneeId = agent?.id;
      }
      res.json(this.mcDb.listTasks({
        status: status as 'inbox' | 'assigned' | 'in_progress' | 'review' | 'done' | 'blocked' | undefined,
        assigneeId,
      }));
    });

    this.app.post('/api/mc/tasks', (req, res) => {
      const task = this.mcDb.createTask(req.body);
      res.json(task);
    });

    this.app.patch('/api/mc/tasks/:id', (req, res) => {
      const task = this.mcDb.updateTask(req.params.id, req.body);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json(task);
    });

    // Task messages (comments)
    this.app.get('/api/mc/tasks/:id/messages', (req, res) => {
      res.json(this.mcDb.getMessages(req.params.id));
    });

    this.app.post('/api/mc/tasks/:id/messages', (req, res) => {
      const msg = this.mcDb.createMessage({
        taskId: req.params.id,
        fromAgentId: req.body.fromAgentId || 'user',
        content: req.body.content,
        attachments: req.body.attachments || [],
        mentions: req.body.mentions || [],
      });
      res.json(msg);
    });

    // Activities
    this.app.get('/api/mc/activities', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 50;
      res.json(this.mcDb.getActivities(limit));
    });

    // Documents
    this.app.get('/api/mc/documents', (req, res) => {
      res.json(this.mcDb.listDocuments({
        taskId: req.query.taskId as string | undefined,
        type: req.query.type as 'deliverable' | 'research' | 'protocol' | 'reference' | 'draft' | undefined,
      }));
    });

    this.app.post('/api/mc/documents', (req, res) => {
      const doc = this.mcDb.createDocument(req.body);
      res.json(doc);
    });

    // Notifications
    this.app.get('/api/mc/notifications', (req, res) => {
      const agentId = req.query.agentId as string | undefined;
      res.json(this.mcDb.getUndeliveredNotifications(agentId));
    });

    // Heartbeat schedule
    this.app.get('/api/mc/heartbeat', (_req, res) => {
      res.json(this.heartbeat.getSchedule());
    });

    // Daily standup (trigger manually)
    this.app.post('/api/mc/standup', async (_req, res) => {
      const standup = this.standupGenerator.generate();
      res.json({ standup });
    });
  }

  // ─── Status ───────────────────────────────────────────────────

  public getStatus(): SystemStatus {
    const workers = this.workerPool.listWorkers();
    return {
      uptime: Date.now() - this.startTime,
      agents: this.orchestrator.listAgents().map((a) => ({
        id: a.id,
        name: a.name,
        status: 'active',
        sessions: this.sessions.listForAgent(a.id).length,
      })),
      channels: this.router.getChannelStatuses().map((c) => ({
        type: c.type,
        status: c.status,
      })),
      scheduledTasks: this.scheduler.listTasks().length,
      memoryEntries: 0,
      currentModel: this.config.agent.defaultModel,
      currentAccount: getCurrentAccountId(),
      activeWorkers: workers.filter(w => w.state === 'running' || w.state === 'awaiting_review').length,
      pendingApprovals: this.workerPool.getPendingApprovals().length,
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  async start() {
    // Load skills
    await this.skills.loadAll();
    logger.info('Gateway', `Loaded ${this.skills.listSkills().length} skills`);

    // Initialize the 10-agent squad in Mission Control
    const squad = initializeSquad(this.mcDb);
    logger.info('Gateway', `Squad: ${squad.map((a) => a.name).join(', ')}`);

    // Register squad agents with the orchestrator
    for (const member of SQUAD_ROSTER) {
      const mcAgent = this.mcDb.getAgentBySessionKey(member.sessionKey);
      if (mcAgent) {
        this.orchestrator.createAgent({
          id: mcAgent.id,
          name: member.name,
          model: this.config.agent.defaultModel,
          systemPrompt: '',
          sessionKey: member.sessionKey,
          soulPath: resolve(process.cwd(), 'agents', member.name.toLowerCase(), 'SOUL.md'),
          skills: member.skills,
          maxTokens: this.config.agent.maxTokens,
          temperature: this.config.agent.temperature,
          memoryEnabled: true,
          sandboxed: this.config.security.sandboxMode,
        });
      }
    }

    // Connect channels
    await this.router.connectAll();

    // Start scheduler
    this.scheduler.start();

    // Mission Control subsystems — heartbeats DISABLED until usage-aware throttling is built
    // this.heartbeat.start();
    this.notificationDaemon.start();
    this.standupGenerator.start();
    logger.warn('Gateway', 'Heartbeats DISABLED — enable manually when ready');

    // Start HTTP + WS server
    const { host, port } = this.config.gateway;
    this.server.listen(port, host, () => {
      logger.success('Gateway', `OpenClaude Gateway running on http://${host}:${port}`);
      logger.info('Gateway', `WebSocket available on ws://${host}:${port}`);
      logger.info('Gateway', `Dashboard at http://${host}:${port}/dashboard`);
      logger.info('Gateway', `Mission Control at http://${host}:${port}/mission-control`);
    });
  }

  async stop() {
    logger.info('Gateway', 'Shutting down...');
    this.scheduler.stop();
    this.heartbeat.stop();
    this.notificationDaemon.stop();
    this.standupGenerator.stop();
    await this.router.disconnectAll();
    this.wss.close();
    this.server.close();
    logger.info('Gateway', 'Shutdown complete');
  }
}
