/**
 * Agent Orchestrator — The Claude-powered AI brain.
 *
 * OpenClaw uses a "Pi agent runtime" with tool streaming.
 * OpenClaude uses the Anthropic SDK with native tool use,
 * extended thinking, and multi-agent coordination.
 */

import { v4 as uuid } from 'uuid';
import { readFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { SubprocessClient } from './subprocess-client.js';
import type {
  AgentConfig,
  Session,
  InboundMessage,
  Message,
  OpenClaudeConfig,
} from '../types/index.js';
import type { MemoryFileStore } from '../memory/store.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { MissionControlDB } from '../mission-control/database.js';
import { buildSystemPrompt } from './prompts.js';

export class AgentOrchestrator {
  private client: SubprocessClient;
  private config: OpenClaudeConfig;
  private agents: Map<string, AgentConfig> = new Map();
  private memory: MemoryFileStore;
  private skills: SkillRegistry;
  private mcDb: MissionControlDB | null = null;
  private projectContext: { name: string; path: string } | null = null;

  // Map session keys to agent configs for heartbeat support
  private sessionKeyToAgent: Map<string, AgentConfig> = new Map();

  constructor(config: OpenClaudeConfig, memory: MemoryFileStore, skills: SkillRegistry) {
    this.config = config;
    this.memory = memory;
    this.skills = skills;
    this.client = new SubprocessClient();

    // Create default agent
    this.createAgent({
      id: 'default',
      name: 'Claude',
      model: config.agent.defaultModel,
      systemPrompt: '',
      skills: [],
      maxTokens: config.agent.maxTokens,
      temperature: config.agent.temperature,
      memoryEnabled: true,
      sandboxed: config.security.sandboxMode,
    });
  }

  setMissionControlDB(db: MissionControlDB) {
    this.mcDb = db;
  }

  setProjectContext(project: { name: string; path: string } | null) {
    this.projectContext = project;
  }

  createAgent(agentConfig: AgentConfig) {
    this.agents.set(agentConfig.id, agentConfig);
    if (agentConfig.sessionKey) {
      this.sessionKeyToAgent.set(agentConfig.sessionKey, agentConfig);
    }
    logger.info('Orchestrator', `Agent registered: ${agentConfig.name} (${agentConfig.id})`);
  }

  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  async processMessage(session: Session, inbound: InboundMessage): Promise<string> {
    const agent = this.agents.get(session.agentId);
    if (!agent) throw new Error(`Agent ${session.agentId} not found`);

    // Add user message to session
    const userMessage: Message = {
      id: uuid(),
      sessionId: session.id,
      role: 'user',
      content: inbound.content,
      channelId: inbound.channelId,
      senderId: inbound.senderId,
      senderName: inbound.senderName,
      timestamp: new Date(),
    };
    session.messages.push(userMessage);

    // Build system prompt with personality, memory, and skills
    const systemPrompt = await this.buildFullSystemPrompt(agent, session);

    // Build tool definitions from skills + built-in tools
    const tools = this.buildToolDefinitions(agent);

    // Convert session messages to Anthropic format
    const messages = this.toAnthropicMessages(session);

    // Call Claude with tool use loop
    let response = '';
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      iterations++;

      const completion = await this.client.messages.create({
        model: agent.model,
        max_tokens: agent.maxTokens,
        system: systemPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      // Subprocess client only returns text blocks — no tool_use dispatch needed
      for (const block of completion.content) {
        if (block.type === 'text') {
          response = block.text;
        }
      }

      // Always break — subprocess handles one shot per call
      break;
    }

    // Store assistant response in session
    const assistantMessage: Message = {
      id: uuid(),
      sessionId: session.id,
      role: 'assistant',
      content: response,
      channelId: session.channelId,
      senderId: agent.id,
      senderName: agent.name,
      timestamp: new Date(),
    };
    session.messages.push(assistantMessage);

    // Auto-memory: let the agent decide what to remember
    if (agent.memoryEnabled) {
      await this.autoMemorize(agent, inbound, response);
    }

    return response;
  }

  private async buildFullSystemPrompt(agent: AgentConfig, session: Session): Promise<string> {
    const parts: string[] = [];

    // Base system prompt
    parts.push(buildSystemPrompt(agent.name));

    // SOUL.md personality (if exists)
    if (agent.soulPath && existsSync(agent.soulPath)) {
      parts.push(`\n## Personality\n${readFileSync(agent.soulPath, 'utf-8')}`);
    }

    // TOOLS.md capabilities (if exists)
    if (agent.toolsPath && existsSync(agent.toolsPath)) {
      parts.push(`\n## Tool Guidelines\n${readFileSync(agent.toolsPath, 'utf-8')}`);
    }

    // Relevant memories
    if (agent.memoryEnabled) {
      const memories = await this.memory.recall(session.messages.slice(-3).map((m) => m.content).join(' '), 10);
      if (memories.length > 0) {
        parts.push('\n## Relevant Memories');
        for (const mem of memories) {
          parts.push(`- [${mem.category}] ${mem.content}`);
        }
      }
    }

    // Project context (if a project is selected)
    if (this.projectContext) {
      parts.push(`\n## Active Project\nYou are working on project: "${this.projectContext.name}"\nProject path: ${this.projectContext.path}\nFocus your responses on this project's context.`);
    }

    // Skill prompt injections
    const skillPrompts = this.skills
      .getSkillsForAgent(agent.skills)
      .map((s) => s.promptInjection)
      .filter(Boolean);
    if (skillPrompts.length > 0) {
      parts.push('\n## Active Skills\n' + skillPrompts.join('\n'));
    }

    return parts.join('\n');
  }

  private buildToolDefinitions(_agent: AgentConfig): unknown[] {
    // Tool definitions are passed to the subprocess but not used for tool_use dispatch.
    // Kept for future MCP-based tool support.
    return [];
  }

  private toAnthropicMessages(session: Session): Array<{ role: 'user' | 'assistant'; content: string }> {
    // Take last 50 messages for context window management
    const recent = session.messages.slice(-50);
    return recent
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.role === 'user' && m.senderName
          ? `[${m.senderName}]: ${m.content}`
          : m.content,
      }));
  }

  private async autoMemorize(agent: AgentConfig, inbound: InboundMessage, response: string) {
    // Simple heuristic: if the user tells the agent something about themselves,
    // or the agent commits to something, store it.
    const keywords = ['remember', 'my name', 'i like', 'i prefer', 'i am', 'i work', 'always', 'never', 'don\'t forget'];
    const lowerContent = inbound.content.toLowerCase();
    if (keywords.some((kw) => lowerContent.includes(kw))) {
      await this.memory.remember({
        agentId: agent.id,
        category: 'preference',
        content: `User said: "${inbound.content}" | Agent responded: "${response.slice(0, 200)}"`,
        tags: ['auto-memorized'],
        importance: 0.6,
      });
    }
  }

  // ─── Multi-Agent: Send message between agents ──────────────────

  async sendAgentMessage(fromAgentId: string, toAgentId: string, content: string): Promise<string> {
    const toAgent = this.agents.get(toAgentId);
    if (!toAgent) throw new Error(`Target agent ${toAgentId} not found`);

    const session: Session = {
      id: uuid(),
      agentId: toAgentId,
      channelId: `agent:${fromAgentId}`,
      senderId: fromAgentId,
      type: 'agent-to-agent',
      status: 'active',
      activationMode: 'always',
      messages: [],
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const inbound: InboundMessage = {
      channelType: 'api',
      channelId: `agent:${fromAgentId}`,
      senderId: fromAgentId,
      senderName: this.agents.get(fromAgentId)?.name || fromAgentId,
      content,
    };

    return this.processMessage(session, inbound);
  }

  // ─── Heartbeat: Process heartbeat wakeup for an agent ──────────

  async processHeartbeat(sessionKey: string, prompt: string): Promise<string> {
    const agent = this.sessionKeyToAgent.get(sessionKey);
    if (!agent) {
      logger.warn('Orchestrator', `No agent found for session key: ${sessionKey}`);
      return 'HEARTBEAT_OK';
    }

    // Create an isolated session for the heartbeat (one-shot)
    const session: Session = {
      id: uuid(),
      agentId: agent.id,
      channelId: 'heartbeat',
      senderId: 'scheduler',
      type: 'main',
      status: 'active',
      activationMode: 'always',
      messages: [],
      metadata: { heartbeat: true, sessionKey },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const inbound: InboundMessage = {
      channelType: 'api',
      channelId: 'heartbeat',
      senderId: 'scheduler',
      senderName: 'Heartbeat System',
      content: prompt,
    };

    return this.processMessage(session, inbound);
  }
}
