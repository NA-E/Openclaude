/**
 * Channel Router — Routes messages between channels and the Gateway.
 *
 * OpenClaw supports WhatsApp, Telegram, Discord, Slack, Signal, iMessage, etc.
 * OpenClaude mirrors this with a pluggable channel adapter system.
 */

import type {
  ChannelAdapter,
  ChannelType,
  Channel,
  InboundMessage,
  OutboundMessage,
  OpenClaudeConfig,
} from '../types/index.js';
import { WebChatAdapter } from '../channels/webchat/adapter.js';
import { DiscordAdapter } from '../channels/discord/adapter.js';
import { TelegramAdapter } from '../channels/telegram/adapter.js';
import { SlackAdapter } from '../channels/slack/adapter.js';
import { logger } from '../utils/logger.js';

export class ChannelRouter {
  private adapters: Map<ChannelType, ChannelAdapter> = new Map();
  private config: OpenClaudeConfig;
  private onInbound: (message: InboundMessage) => void;

  constructor(config: OpenClaudeConfig, onInbound: (message: InboundMessage) => void) {
    this.config = config;
    this.onInbound = onInbound;
    this.registerAdapters();
  }

  private registerAdapters() {
    // WebChat is always available
    if (this.config.channels.webchat?.enabled !== false) {
      this.adapters.set('webchat', new WebChatAdapter());
    }

    // Discord
    if (this.config.channels.discord) {
      this.adapters.set('discord', new DiscordAdapter(this.config.channels.discord));
    }

    // Telegram
    if (this.config.channels.telegram) {
      this.adapters.set('telegram', new TelegramAdapter(this.config.channels.telegram));
    }

    // Slack
    if (this.config.channels.slack) {
      this.adapters.set('slack', new SlackAdapter(this.config.channels.slack));
    }
  }

  async connectAll() {
    for (const [type, adapter] of this.adapters) {
      try {
        adapter.onMessage(this.onInbound);
        await adapter.connect();
        logger.success('Router', `Channel ${type} connected`);
      } catch (err) {
        logger.error('Router', `Failed to connect channel ${type}`, err);
      }
    }
  }

  async disconnectAll() {
    for (const [type, adapter] of this.adapters) {
      try {
        await adapter.disconnect();
        logger.info('Router', `Channel ${type} disconnected`);
      } catch (err) {
        logger.error('Router', `Failed to disconnect channel ${type}`, err);
      }
    }
  }

  async sendToChannel(channelType: ChannelType | 'api', message: OutboundMessage) {
    if (channelType === 'api') return; // API responses handled directly
    const adapter = this.adapters.get(channelType as ChannelType);
    if (!adapter) {
      logger.warn('Router', `No adapter for channel ${channelType}`);
      return;
    }
    await adapter.send(message);
  }

  getChannelStatuses(): Channel[] {
    const statuses: Channel[] = [];
    for (const [type, adapter] of this.adapters) {
      statuses.push({
        id: type,
        type,
        name: type.charAt(0).toUpperCase() + type.slice(1),
        config: {},
        status: adapter.getStatus(),
      });
    }
    return statuses;
  }

  getAdapter(type: ChannelType): ChannelAdapter | undefined {
    return this.adapters.get(type);
  }
}
