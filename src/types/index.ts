/**
 * Core type definitions for OpenClaude.
 * Translates OpenClaw's Gateway/Agent/Channel architecture into Claude-native types.
 */

// ─── Agent & Session ───────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  soulPath?: string;       // Path to SOUL.md personality file
  toolsPath?: string;      // Path to TOOLS.md capabilities file
  skills: string[];        // Enabled skill IDs
  maxTokens: number;
  temperature: number;
  memoryEnabled: boolean;
  sandboxed: boolean;
}

export interface Session {
  id: string;
  agentId: string;
  channelId: string;
  senderId: string;
  type: 'main' | 'group' | 'agent-to-agent';
  status: 'active' | 'idle' | 'paused';
  activationMode: 'mention' | 'always';
  messages: Message[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  channelId: string;
  senderId: string;
  senderName?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: Date;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
  isError: boolean;
}

// ─── Channels ──────────────────────────────────────────────────────

export type ChannelType = 'webchat' | 'discord' | 'telegram' | 'slack' | 'api';

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  config: Record<string, unknown>;
  status: 'connected' | 'disconnected' | 'error';
}

export interface InboundMessage {
  channelType: ChannelType;
  channelId: string;
  senderId: string;
  senderName: string;
  content: string;
  replyToId?: string;
  groupId?: string;
  attachments?: Attachment[];
  raw?: unknown;
}

export interface OutboundMessage {
  channelType: ChannelType;
  channelId: string;
  recipientId: string;
  content: string;
  replyToId?: string;
  attachments?: Attachment[];
}

export interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video';
  url?: string;
  data?: Buffer;
  mimeType: string;
  filename: string;
}

export interface ChannelAdapter {
  type: ChannelType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  onMessage(handler: (message: InboundMessage) => void): void;
  getStatus(): Channel['status'];
}

// ─── Skills ────────────────────────────────────────────────────────

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  tools: SkillTool[];
  promptInjection?: string;  // Additional system prompt for this skill
  configSchema?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface SkillTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<string>;
}

export interface ToolContext {
  sessionId: string;
  agentId: string;
  workspacePath: string;
  memoryStore: MemoryStore;
  sendMessage: (channelId: string, content: string) => Promise<void>;
}

// ─── Memory ────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  agentId: string;
  category: 'fact' | 'preference' | 'context' | 'conversation' | 'task';
  content: string;
  tags: string[];
  importance: number;  // 0-1 scale
  createdAt: Date;
  lastAccessedAt: Date;
  accessCount: number;
}

export interface MemoryStore {
  remember(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>): Promise<MemoryEntry>;
  recall(query: string, limit?: number): Promise<MemoryEntry[]>;
  forget(id: string): Promise<void>;
  getByCategory(category: MemoryEntry['category']): Promise<MemoryEntry[]>;
  getByTags(tags: string[]): Promise<MemoryEntry[]>;
  getAllForAgent(agentId: string): Promise<MemoryEntry[]>;
}

// ─── Scheduler ─────────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  agentId: string;
  name: string;
  cron: string;
  prompt: string;         // What the agent should do when triggered
  channelId?: string;     // Which channel to report results to
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  metadata?: Record<string, unknown>;
}

// ─── Gateway Events ────────────────────────────────────────────────

export type GatewayEvent =
  | { type: 'message.inbound'; data: InboundMessage }
  | { type: 'message.outbound'; data: OutboundMessage }
  | { type: 'session.created'; data: { session: Session } }
  | { type: 'session.updated'; data: { session: Session } }
  | { type: 'agent.thinking'; data: { agentId: string; sessionId: string } }
  | { type: 'agent.response'; data: { agentId: string; sessionId: string; content: string } }
  | { type: 'agent.tool_use'; data: { agentId: string; sessionId: string; tool: string; input: Record<string, unknown> } }
  | { type: 'agent.error'; data: { agentId: string; sessionId: string; error: string } }
  | { type: 'channel.status'; data: { channel: Channel } }
  | { type: 'scheduler.fired'; data: { task: ScheduledTask } }
  | { type: 'memory.updated'; data: { entry: MemoryEntry } }
  | { type: 'system.status'; data: SystemStatus };

export interface SystemStatus {
  uptime: number;
  agents: { id: string; name: string; status: string; sessions: number }[];
  channels: { type: ChannelType; status: string }[];
  scheduledTasks: number;
  memoryEntries: number;
}

// ─── Configuration ─────────────────────────────────────────────────

export interface OpenClaudeConfig {
  gateway: {
    host: string;
    port: number;
    secret: string;
  };
  agent: {
    defaultModel: string;
    maxTokens: number;
    temperature: number;
  };
  channels: {
    discord?: { token: string; allowedUsers: string[] };
    telegram?: { token: string; allowedUsers: string[] };
    slack?: { botToken: string; appToken: string; signingSecret: string };
    webchat?: { enabled: boolean };
  };
  memory: {
    dir: string;
    maxEntries: number;
  };
  scheduler: {
    heartbeatCron: string;
  };
  security: {
    dmPolicy: 'pairing' | 'open';
    sandboxMode: boolean;
  };
  browser: {
    headless: boolean;
    executablePath?: string;
  };
  workspace: string;
}
