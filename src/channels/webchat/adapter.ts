/**
 * WebChat Channel Adapter — Browser-based chat interface.
 *
 * OpenClaw serves WebChat directly from the Gateway.
 * OpenClaude does the same — messages come in via WebSocket.
 */

import type { ChannelAdapter, InboundMessage, OutboundMessage, Channel } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

export class WebChatAdapter implements ChannelAdapter {
  type = 'webchat' as const;
  private status: Channel['status'] = 'disconnected';
  private messageHandler?: (message: InboundMessage) => void;
  private pendingResponses: Map<string, (content: string) => void> = new Map();

  async connect(): Promise<void> {
    this.status = 'connected';
    logger.info('WebChat', 'WebChat adapter ready (served via Gateway WebSocket)');
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }

  async send(message: OutboundMessage): Promise<void> {
    // WebChat responses are sent back via the Gateway WebSocket broadcast
    // This is handled by the Gateway's broadcast mechanism
    const resolver = this.pendingResponses.get(message.recipientId);
    if (resolver) {
      resolver(message.content);
      this.pendingResponses.delete(message.recipientId);
    }
    logger.debug('WebChat', `Response sent to ${message.recipientId}`);
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  getStatus(): Channel['status'] {
    return this.status;
  }

  // Called by Gateway when a WebSocket message comes in from the dashboard
  handleWebSocketMessage(senderId: string, senderName: string, content: string) {
    if (!this.messageHandler) return;
    this.messageHandler({
      channelType: 'webchat',
      channelId: 'webchat',
      senderId,
      senderName,
      content,
    });
  }
}
