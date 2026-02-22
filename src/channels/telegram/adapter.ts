/**
 * Telegram Channel Adapter.
 *
 * OpenClaw uses grammY for Telegram integration.
 * OpenClaude does the same.
 */

import type { ChannelAdapter, InboundMessage, OutboundMessage, Channel } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

interface TelegramConfig {
  token: string;
  allowedUsers: string[];
}

export class TelegramAdapter implements ChannelAdapter {
  type = 'telegram' as const;
  private config: TelegramConfig;
  private status: Channel['status'] = 'disconnected';
  private messageHandler?: (message: InboundMessage) => void;
  private bot: unknown = null;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      const { Bot } = await import('grammy');
      const bot = new Bot(this.config.token);

      bot.on('message:text', (ctx) => {
        const senderId = String(ctx.from.id);

        // Check allowlist
        if (
          this.config.allowedUsers.length > 0 &&
          !this.config.allowedUsers.includes(senderId)
        ) {
          return;
        }

        const inbound: InboundMessage = {
          channelType: 'telegram',
          channelId: String(ctx.chat.id),
          senderId,
          senderName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
          content: ctx.message.text,
          groupId: ctx.chat.type !== 'private' ? String(ctx.chat.id) : undefined,
        };

        this.messageHandler?.(inbound);
      });

      bot.start();
      this.bot = bot;
      this.status = 'connected';
      logger.success('Telegram', 'Bot connected and polling');
    } catch (err) {
      this.status = 'error';
      logger.error('Telegram', 'Failed to connect', err);
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      (this.bot as { stop(): void }).stop();
    }
    this.status = 'disconnected';
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.bot) return;
    try {
      const bot = this.bot as { api: { sendMessage(chatId: string, text: string, opts?: unknown): Promise<void> } };
      // Chunk long messages (Telegram 4096 char limit)
      const chunks = chunkMessage(message.content, 4096);
      for (const chunk of chunks) {
        await bot.api.sendMessage(message.channelId, chunk, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      logger.error('Telegram', 'Failed to send message', err);
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
    let breakPoint = remaining.lastIndexOf('\n', maxLen);
    if (breakPoint <= 0) breakPoint = maxLen;
    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint);
  }
  return chunks;
}
