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
  private startTime: number = Date.now();

  constructor(config: OpenClaudeConfig) {
    this.config = config;
    this.app = express();
    this.app.use(express.json());
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    // Initialize subsystems
    this.memory = new MemoryFileStore(config.memory.dir);
    this.skills = new SkillRegistry(config.workspace);
    this.sessions = new SessionManager();
    this.orchestrator = new AgentOrchestrator(config, this.memory, this.skills);
    this.router = new ChannelRouter(config, this.handleInbound.bind(this));
    this.scheduler = new TaskScheduler(config, this.orchestrator, this);

    this.setupWebSocket();
    this.setupHTTPRoutes();
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

  public broadcast(event: GatewayEvent) {
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

    // Find or create session
    const session = this.sessions.getOrCreate({
      channelId: message.channelId,
      senderId: message.senderId,
      channelType: message.channelType,
      groupId: message.groupId,
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
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Gateway', `Agent error in session ${session.id}`, err);
      this.broadcast({
        type: 'agent.error',
        data: { agentId: session.agentId, sessionId: session.id, error: errorMsg },
      });
    }
  }

  // ─── HTTP Routes ──────────────────────────────────────────────

  private setupHTTPRoutes() {
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', uptime: Date.now() - this.startTime });
    });

    // System status
    this.app.get('/api/status', (_req, res) => {
      res.json(this.getStatus());
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
      const { content, channelType = 'api', senderId = 'api-user', senderName = 'API' } = req.body;
      if (!content) return res.status(400).json({ error: 'content required' });

      const message: InboundMessage = {
        channelType,
        channelId: 'api',
        senderId,
        senderName,
        content,
      };

      try {
        const session = this.sessions.getOrCreate({
          channelId: 'api',
          senderId,
          channelType: 'api',
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
  }

  // ─── Status ───────────────────────────────────────────────────

  public getStatus(): SystemStatus {
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
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  async start() {
    // Load skills
    await this.skills.loadAll();
    logger.info('Gateway', `Loaded ${this.skills.listSkills().length} skills`);

    // Connect channels
    await this.router.connectAll();

    // Start scheduler
    this.scheduler.start();

    // Start HTTP + WS server
    const { host, port } = this.config.gateway;
    this.server.listen(port, host, () => {
      logger.success('Gateway', `OpenClaude Gateway running on http://${host}:${port}`);
      logger.info('Gateway', `WebSocket available on ws://${host}:${port}`);
      logger.info('Gateway', `Dashboard at http://${host}:${port}`);
    });
  }

  async stop() {
    logger.info('Gateway', 'Shutting down...');
    this.scheduler.stop();
    await this.router.disconnectAll();
    this.wss.close();
    this.server.close();
    logger.info('Gateway', 'Shutdown complete');
  }
}
