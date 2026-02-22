/**
 * Agent Orchestrator — The Claude-powered AI brain.
 *
 * OpenClaw uses a "Pi agent runtime" with tool streaming.
 * OpenClaude uses the Anthropic SDK with native tool use,
 * extended thinking, and multi-agent coordination.
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuid } from 'uuid';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';
import type {
  AgentConfig,
  Session,
  InboundMessage,
  Message,
  OpenClaudeConfig,
  SkillTool,
  ToolContext,
} from '../types/index.js';
import type { MemoryFileStore } from '../memory/store.js';
import type { SkillRegistry } from '../skills/registry.js';
import { buildSystemPrompt } from './prompts.js';
import { buildTools, executeToolCall } from '../tools/executor.js';

export class AgentOrchestrator {
  private client: Anthropic;
  private config: OpenClaudeConfig;
  private agents: Map<string, AgentConfig> = new Map();
  private memory: MemoryFileStore;
  private skills: SkillRegistry;

  constructor(config: OpenClaudeConfig, memory: MemoryFileStore, skills: SkillRegistry) {
    this.config = config;
    this.memory = memory;
    this.skills = skills;
    this.client = new Anthropic();

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

  createAgent(agentConfig: AgentConfig) {
    this.agents.set(agentConfig.id, agentConfig);
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

      // Process the response
      let hasToolUse = false;
      const assistantContent: Anthropic.Messages.ContentBlock[] = [];

      for (const block of completion.content) {
        assistantContent.push(block);

        if (block.type === 'text') {
          response = block.text;
        } else if (block.type === 'tool_use') {
          hasToolUse = true;
          logger.info('Orchestrator', `Tool call: ${block.name}`, block.input);

          // Execute the tool
          const toolContext: ToolContext = {
            sessionId: session.id,
            agentId: agent.id,
            workspacePath: this.config.workspace,
            memoryStore: this.memory,
            sendMessage: async () => {},
          };

          const result = await executeToolCall(
            block.name,
            block.input as Record<string, unknown>,
            toolContext,
            this.skills,
            agent.sandboxed,
          );

          // Add assistant message with tool use
          messages.push({ role: 'assistant', content: assistantContent });
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: block.id,
                content: result,
              },
            ],
          });
        }
      }

      // If no tool use, we're done
      if (!hasToolUse) {
        break;
      }
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

  private buildToolDefinitions(agent: AgentConfig): Anthropic.Messages.Tool[] {
    const tools: Anthropic.Messages.Tool[] = [];

    // Built-in tools
    for (const tool of buildTools(agent.sandboxed)) {
      tools.push(tool);
    }

    // Skill tools
    const skillTools = this.skills.getToolsForAgent(agent.skills);
    for (const tool of skillTools) {
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
      });
    }

    return tools;
  }

  private toAnthropicMessages(session: Session): Anthropic.Messages.MessageParam[] {
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
}
