/**
 * Notification Daemon — Delivers @mentions and thread subscriptions.
 *
 * From the article:
 * "A daemon process polls every 2 seconds for undelivered notifications.
 *  If an agent is asleep, the notification stays queued."
 *
 * Thread Subscriptions:
 * "When you interact with a task, you're subscribed.
 *  Comment → subscribed. @mentioned → subscribed. Assigned → subscribed."
 */

import { logger } from '../utils/logger.js';
import type { MissionControlDB, MCNotification } from '../mission-control/database.js';
import type { AgentOrchestrator } from '../agent/orchestrator.js';

export class NotificationDaemon {
  private db: MissionControlDB;
  private orchestrator: AgentOrchestrator;
  private interval: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private running = false;

  constructor(db: MissionControlDB, orchestrator: AgentOrchestrator, pollIntervalMs = 2000) {
    this.db = db;
    this.orchestrator = orchestrator;
    this.pollIntervalMs = pollIntervalMs;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.interval = setInterval(() => this.poll(), this.pollIntervalMs);
    logger.info('NotificationDaemon', `Polling every ${this.pollIntervalMs}ms`);
  }

  stop() {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info('NotificationDaemon', 'Stopped');
  }

  private async poll() {
    const undelivered = this.db.getUndeliveredNotifications();
    if (undelivered.length === 0) return;

    for (const notification of undelivered) {
      await this.deliver(notification);
    }
  }

  private async deliver(notification: MCNotification) {
    const agent = this.db.getAgent(notification.mentionedAgentId);
    if (!agent) {
      // Agent doesn't exist, mark as delivered to stop retrying
      this.db.markNotificationDelivered(notification.id);
      return;
    }

    // Only deliver if agent has an active session
    if (agent.status !== 'active') {
      // Agent is asleep — notification stays queued until next heartbeat
      return;
    }

    try {
      // Send notification to agent's session
      await this.orchestrator.sendAgentMessage(
        'system',
        agent.sessionKey,
        `📬 Notification: ${notification.content}`,
      );

      this.db.markNotificationDelivered(notification.id);
      logger.debug('NotificationDaemon', `Delivered to ${agent.name}: ${notification.content.slice(0, 60)}`);
    } catch {
      // Delivery failed — will retry next poll
      logger.debug('NotificationDaemon', `Failed to deliver to ${agent.name} (will retry)`);
    }
  }

  /**
   * Parse @mentions from message content.
   * Returns array of agent names mentioned.
   */
  static parseMentions(content: string, agentNames: string[]): string[] {
    const mentions: string[] = [];
    const lowerContent = content.toLowerCase();

    // Check for @all
    if (lowerContent.includes('@all')) {
      return agentNames;
    }

    // Check for individual @mentions
    for (const name of agentNames) {
      if (lowerContent.includes(`@${name.toLowerCase()}`)) {
        mentions.push(name);
      }
    }

    return mentions;
  }
}
