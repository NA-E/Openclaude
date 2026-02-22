/**
 * Task Scheduler — Cron-based autonomous task execution.
 *
 * OpenClaw has a heartbeat scheduler that wakes the agent at configurable intervals.
 * OpenClaude mirrors this with croner for cron scheduling.
 * Agents can create their own scheduled tasks for proactive behavior.
 */

import { Cron } from 'croner';
import { v4 as uuid } from 'uuid';
import { logger } from '../utils/logger.js';
import type { ScheduledTask, OpenClaudeConfig } from '../types/index.js';
import type { AgentOrchestrator } from '../agent/orchestrator.js';

export class TaskScheduler {
  private config: OpenClaudeConfig;
  private orchestrator: AgentOrchestrator;
  private gateway: { broadcast: (event: { type: string; data: unknown }) => void };
  private tasks: Map<string, ScheduledTask> = new Map();
  private cronJobs: Map<string, Cron> = new Map();
  private heartbeat: Cron | null = null;

  constructor(
    config: OpenClaudeConfig,
    orchestrator: AgentOrchestrator,
    gateway: { broadcast: (event: { type: string; data: unknown }) => void },
  ) {
    this.config = config;
    this.orchestrator = orchestrator;
    this.gateway = gateway;
  }

  start() {
    // Start heartbeat — the agent wakes up periodically
    this.heartbeat = new Cron(this.config.scheduler.heartbeatCron, () => {
      this.onHeartbeat();
    });
    logger.info('Scheduler', `Heartbeat started: ${this.config.scheduler.heartbeatCron}`);

    // Start all enabled tasks
    for (const [id, task] of this.tasks) {
      if (task.enabled) {
        this.scheduleTask(id, task);
      }
    }
  }

  stop() {
    this.heartbeat?.stop();
    for (const [, job] of this.cronJobs) {
      job.stop();
    }
    this.cronJobs.clear();
    logger.info('Scheduler', 'All scheduled tasks stopped');
  }

  addTask(taskDef: Omit<ScheduledTask, 'id'>): ScheduledTask {
    const task: ScheduledTask = {
      ...taskDef,
      id: uuid(),
    };
    this.tasks.set(task.id, task);

    if (task.enabled) {
      this.scheduleTask(task.id, task);
    }

    logger.info('Scheduler', `Task added: ${task.name} (${task.cron})`);
    return task;
  }

  removeTask(id: string) {
    const job = this.cronJobs.get(id);
    if (job) {
      job.stop();
      this.cronJobs.delete(id);
    }
    this.tasks.delete(id);
  }

  listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values()).map((task) => {
      const job = this.cronJobs.get(task.id);
      return {
        ...task,
        nextRun: job?.nextRun() || undefined,
      };
    });
  }

  private scheduleTask(id: string, task: ScheduledTask) {
    const job = new Cron(task.cron, async () => {
      await this.executeTask(task);
    });
    this.cronJobs.set(id, job);
  }

  private async executeTask(task: ScheduledTask) {
    logger.info('Scheduler', `Executing task: ${task.name}`);
    task.lastRun = new Date();

    this.gateway.broadcast({
      type: 'scheduler.fired',
      data: { task },
    });

    try {
      const response = await this.orchestrator.processMessage(
        {
          id: `scheduled:${task.id}`,
          agentId: task.agentId,
          channelId: task.channelId || 'scheduler',
          senderId: 'scheduler',
          type: 'main',
          status: 'active',
          activationMode: 'always',
          messages: [],
          metadata: { scheduledTask: task.id },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          channelType: 'api',
          channelId: 'scheduler',
          senderId: 'scheduler',
          senderName: 'Scheduler',
          content: task.prompt,
        },
      );

      logger.info('Scheduler', `Task ${task.name} completed: ${response.slice(0, 100)}`);
    } catch (err) {
      logger.error('Scheduler', `Task ${task.name} failed`, err);
    }
  }

  private async onHeartbeat() {
    logger.debug('Scheduler', 'Heartbeat tick');
    // The heartbeat is an opportunity for the agent to proactively do things:
    // - Check pending tasks
    // - Review memories
    // - Send proactive messages
    // This could be expanded to call the orchestrator with a "check in" prompt
  }
}
