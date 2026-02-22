/**
 * Heartbeat System — Staggered cron wakeups for agents.
 *
 * From the article:
 * "Each agent wakes up every 15 minutes via cron job.
 *  The schedule is staggered so agents don't all wake at once."
 *
 * What happens during a heartbeat:
 * 1. Load context (WORKING.md, daily notes, session memory)
 * 2. Check for urgent items (@mentions, assigned tasks)
 * 3. Scan activity feed for relevant discussions
 * 4. Take action or report HEARTBEAT_OK
 */

import { Cron } from 'croner';
import { logger } from '../utils/logger.js';
import type { MissionControlDB, MCAgent } from './database.js';
import type { AgentOrchestrator } from '../agent/orchestrator.js';
import type { AgentMemoryStack } from './memory-stack.js';

export class HeartbeatSystem {
  private db: MissionControlDB;
  private orchestrator: AgentOrchestrator;
  private memoryStack: AgentMemoryStack;
  private cronJobs: Map<string, Cron> = new Map();
  private running = false;

  constructor(db: MissionControlDB, orchestrator: AgentOrchestrator, memoryStack: AgentMemoryStack) {
    this.db = db;
    this.orchestrator = orchestrator;
    this.memoryStack = memoryStack;
  }

  start() {
    if (this.running) return;
    this.running = true;

    const agents = this.db.listAgents();
    for (const agent of agents) {
      this.scheduleHeartbeat(agent);
    }

    logger.success('Heartbeat', `Scheduled heartbeats for ${agents.length} agents`);
  }

  stop() {
    this.running = false;
    for (const [, job] of this.cronJobs) {
      job.stop();
    }
    this.cronJobs.clear();
    logger.info('Heartbeat', 'All heartbeats stopped');
  }

  private scheduleHeartbeat(agent: MCAgent) {
    const job = new Cron(agent.heartbeatCron, async () => {
      await this.executeHeartbeat(agent);
    });
    this.cronJobs.set(agent.id, job);
    logger.debug('Heartbeat', `Scheduled ${agent.name} at ${agent.heartbeatCron}`);
  }

  private async executeHeartbeat(agent: MCAgent) {
    logger.info('Heartbeat', `${agent.name} waking up...`);

    // Update agent status
    this.db.updateAgent(agent.id, { status: 'active', lastHeartbeat: new Date().toISOString() });
    this.db.logActivity({
      type: 'agent_woke_up',
      agentId: agent.id,
      taskId: null,
      message: `${agent.name} heartbeat fired`,
      metadata: {},
    });

    try {
      // 1. Load context
      const workingMemory = this.memoryStack.getWorkingMemory(agent.sessionKey);
      const dailyNotes = this.memoryStack.getTodayNotes(agent.sessionKey);

      // 2. Check for notifications
      const notifications = this.db.getUndeliveredNotifications(agent.id);

      // 3. Check assigned tasks
      const assignedTasks = this.db.listTasks({ assigneeId: agent.id })
        .filter((t) => t.status !== 'done');

      // 4. Recent activity
      const recentActivity = this.db.getActivities(10);

      // Build heartbeat prompt
      const prompt = this.buildHeartbeatPrompt(agent, {
        workingMemory,
        dailyNotes,
        notifications: notifications.map((n) => n.content),
        assignedTasks: assignedTasks.map((t) => `[${t.status}] ${t.title}: ${t.description.slice(0, 100)}`),
        recentActivity: recentActivity.map((a) => `${a.message} (${a.createdAt})`),
      });

      // Run the agent
      const response = await this.orchestrator.processHeartbeat(agent.sessionKey, prompt);

      // Mark notifications as delivered
      for (const notif of notifications) {
        this.db.markNotificationDelivered(notif.id);
      }

      // Update working memory with response
      if (response && !response.includes('HEARTBEAT_OK')) {
        this.memoryStack.appendDailyNote(agent.sessionKey, response.slice(0, 500));
      }

      logger.info('Heartbeat', `${agent.name}: ${response?.slice(0, 100) || 'HEARTBEAT_OK'}`);
    } catch (err) {
      logger.error('Heartbeat', `${agent.name} heartbeat failed`, err);
    } finally {
      // Return to idle
      this.db.updateAgent(agent.id, { status: 'idle' });
    }
  }

  private buildHeartbeatPrompt(
    agent: MCAgent,
    context: {
      workingMemory: string;
      dailyNotes: string;
      notifications: string[];
      assignedTasks: string[];
      recentActivity: string[];
    },
  ): string {
    const parts = [
      `You are ${agent.name}, the ${agent.role}. This is your periodic heartbeat check.`,
      '',
      '## Heartbeat Protocol',
      '1. Check your working memory for ongoing tasks',
      '2. Check for @mentions and notifications',
      '3. Check assigned tasks',
      '4. Scan activity feed for relevant discussions',
      '5. Take action if needed, otherwise reply HEARTBEAT_OK',
      '',
    ];

    if (context.workingMemory) {
      parts.push('## Current Working Memory', context.workingMemory, '');
    }

    if (context.notifications.length > 0) {
      parts.push('## Notifications (Unread)', ...context.notifications.map((n) => `- ${n}`), '');
    }

    if (context.assignedTasks.length > 0) {
      parts.push('## Your Assigned Tasks', ...context.assignedTasks.map((t) => `- ${t}`), '');
    }

    if (context.recentActivity.length > 0) {
      parts.push('## Recent Activity Feed', ...context.recentActivity.map((a) => `- ${a}`), '');
    }

    if (context.dailyNotes) {
      parts.push('## Today\'s Notes', context.dailyNotes, '');
    }

    parts.push(
      '',
      '## Instructions',
      'If you have work to do, do it now. Use Mission Control tools to update tasks, post comments, and create documents.',
      'If there\'s nothing to do, simply respond with HEARTBEAT_OK.',
      'Do NOT make up work. Only act on real tasks and notifications.',
    );

    return parts.join('\n');
  }

  getSchedule(): { agentName: string; cron: string; nextRun: Date | null }[] {
    return this.db.listAgents().map((agent) => {
      const job = this.cronJobs.get(agent.id);
      return {
        agentName: agent.name,
        cron: agent.heartbeatCron,
        nextRun: job?.nextRun() || null,
      };
    });
  }
}
