/**
 * Daily Standup Generator.
 *
 * From the article:
 * "Every day at 11:30 PM IST, a cron fires that checks all agent sessions,
 *  gathers recent activity, compiles a summary, and sends it to my Telegram."
 *
 * Format:
 * - COMPLETED TODAY
 * - IN PROGRESS
 * - BLOCKED
 * - NEEDS REVIEW
 * - KEY DECISIONS
 */

import { Cron } from 'croner';
import { logger } from '../utils/logger.js';
import type { MissionControlDB } from '../mission-control/database.js';
import type { Gateway } from '../gateway/server.js';

export class DailyStandupGenerator {
  private db: MissionControlDB;
  private gateway: Gateway;
  private cron: Cron | null = null;
  private cronSchedule: string;

  constructor(db: MissionControlDB, gateway: Gateway, cronSchedule = '0 18 * * *') {
    this.db = db;
    this.gateway = gateway;
    this.cronSchedule = cronSchedule;
  }

  start() {
    this.cron = new Cron(this.cronSchedule, () => {
      this.generateAndSend();
    });
    logger.info('Standup', `Daily standup scheduled: ${this.cronSchedule}`);
  }

  stop() {
    this.cron?.stop();
  }

  async generateAndSend() {
    const standup = this.generate();
    logger.info('Standup', 'Generated daily standup');

    // Broadcast to all connected clients
    this.gateway.broadcast({
      type: 'agent.response',
      data: {
        agentId: 'system',
        sessionId: 'standup',
        content: standup,
      },
    });

    return standup;
  }

  generate(): string {
    const today = new Date().toISOString().slice(0, 10);
    const agents = this.db.listAgents();
    const tasks = this.db.getTasksByStatus();

    // Get today's activities
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const activities = this.db.getActivities(200, todayStart.toISOString());

    // Completed today
    const completedToday = tasks.done.filter((t) =>
      t.updatedAt.startsWith(today),
    );

    // In progress
    const inProgress = tasks.in_progress;

    // Blocked
    const blocked = tasks.blocked;

    // Needs review
    const needsReview = tasks.review;

    // Key decisions from activities
    const keyActivities = activities
      .filter((a) => ['task_status_changed', 'document_created', 'task_created'].includes(a.type))
      .slice(0, 10);

    // Build standup
    const lines: string[] = [
      `DAILY STANDUP — ${today}`,
      '',
    ];

    // Completed
    lines.push('COMPLETED TODAY');
    if (completedToday.length === 0) {
      lines.push('  (none)');
    } else {
      for (const task of completedToday) {
        const assignees = task.assigneeIds
          .map((id) => agents.find((a) => a.id === id)?.name || id)
          .join(', ');
        lines.push(`  * ${assignees}: ${task.title}`);
      }
    }
    lines.push('');

    // In progress
    lines.push('IN PROGRESS');
    if (inProgress.length === 0) {
      lines.push('  (none)');
    } else {
      for (const task of inProgress) {
        const assignees = task.assigneeIds
          .map((id) => agents.find((a) => a.id === id)?.name || id)
          .join(', ');
        lines.push(`  * ${assignees}: ${task.title}`);
      }
    }
    lines.push('');

    // Blocked
    lines.push('BLOCKED');
    if (blocked.length === 0) {
      lines.push('  (none)');
    } else {
      for (const task of blocked) {
        const assignees = task.assigneeIds
          .map((id) => agents.find((a) => a.id === id)?.name || id)
          .join(', ');
        lines.push(`  * ${assignees}: ${task.title}`);
      }
    }
    lines.push('');

    // Needs review
    lines.push('NEEDS REVIEW');
    if (needsReview.length === 0) {
      lines.push('  (none)');
    } else {
      for (const task of needsReview) {
        const assignees = task.assigneeIds
          .map((id) => agents.find((a) => a.id === id)?.name || id)
          .join(', ');
        lines.push(`  * ${assignees}: ${task.title}`);
      }
    }
    lines.push('');

    // Key activities
    lines.push('KEY ACTIVITIES');
    if (keyActivities.length === 0) {
      lines.push('  (quiet day)');
    } else {
      for (const activity of keyActivities) {
        lines.push(`  * ${activity.message}`);
      }
    }
    lines.push('');

    // Agent status summary
    lines.push('AGENT STATUS');
    for (const agent of agents) {
      const agentTasks = this.db.listTasks({ assigneeId: agent.id })
        .filter((t) => t.status !== 'done');
      const lastHB = agent.lastHeartbeat
        ? new Date(agent.lastHeartbeat).toISOString().slice(11, 16)
        : 'never';
      lines.push(`  ${agent.name} (${agent.role}): ${agentTasks.length} tasks, last heartbeat: ${lastHB}`);
    }

    return lines.join('\n');
  }
}
