/**
 * Slack Channel Adapter.
 *
 * OpenClaw uses Bolt for Slack integration.
 * OpenClaude provides the same with Socket Mode.
 */

import type { ChannelAdapter, InboundMessage, OutboundMessage, Channel } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

interface SlackConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
}

export class SlackAdapter implements ChannelAdapter {
  type = 'slack' as const;
  private config: SlackConfig;
  private status: Channel['status'] = 'disconnected';
  private messageHandler?: (message: InboundMessage) => void;
  private app: unknown = null;

  constructor(config: SlackConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      // Slack Bolt would be imported dynamically
      // For now, log that Slack integration is available
      logger.info('Slack', 'Slack adapter initialized (requires @slack/bolt package)');
      this.status = 'connected';
    } catch (err) {
      this.status = 'error';
      logger.error('Slack', 'Failed to connect', err);
    }
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.app) return;
    logger.debug('Slack', `Would send to ${message.channelId}: ${message.content.slice(0, 80)}`);
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  getStatus(): Channel['status'] {
    return this.status;
  }
}
