/**
 * Discord Channel Adapter.
 *
 * OpenClaw uses discord.js for Discord integration.
 * OpenClaude does the same with allowlist-based security.
 */

import type { ChannelAdapter, InboundMessage, OutboundMessage, Channel } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

interface DiscordConfig {
  token: string;
  allowedUsers: string[];
}

export class DiscordAdapter implements ChannelAdapter {
  type = 'discord' as const;
  private config: DiscordConfig;
  private status: Channel['status'] = 'disconnected';
  private messageHandler?: (message: InboundMessage) => void;
  private client: unknown = null;

  constructor(config: DiscordConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      // Dynamic import to avoid requiring discord.js if not used
      const { Client, GatewayIntentBits, Events } = await import('discord.js');

      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
      });

      client.on(Events.MessageCreate, (message) => {
        // Ignore bot messages
        if (message.author.bot) return;

        // Check allowlist
        if (
          this.config.allowedUsers.length > 0 &&
          !this.config.allowedUsers.includes(message.author.id)
        ) {
          return;
        }

        const inbound: InboundMessage = {
          channelType: 'discord',
          channelId: message.channelId,
          senderId: message.author.id,
          senderName: message.author.displayName || message.author.username,
          content: message.content,
          groupId: message.guild ? message.channelId : undefined,
        };

        this.messageHandler?.(inbound);
      });

      await client.login(this.config.token);
      this.client = client;
      this.status = 'connected';
      logger.success('Discord', `Connected as ${client.user?.tag}`);
    } catch (err) {
      this.status = 'error';
      logger.error('Discord', 'Failed to connect', err);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      (this.client as { destroy(): void }).destroy();
    }
    this.status = 'disconnected';
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.client) return;
    try {
      const client = this.client as { channels: { fetch(id: string): Promise<{ send(content: string): Promise<void> }> } };
      const channel = await client.channels.fetch(message.channelId);
      if (channel) {
        // Chunk long messages (Discord 2000 char limit)
        const chunks = chunkMessage(message.content, 2000);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
    } catch (err) {
      logger.error('Discord', 'Failed to send message', err);
    }
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  getStatus(): Channel['status'] {
    return this.status;
  }
}

function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to break at newline
    let breakPoint = remaining.lastIndexOf('\n', maxLen);
    if (breakPoint <= 0) breakPoint = maxLen;
    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint);
  }
  return chunks;
}
