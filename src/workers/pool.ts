/**
 * WorkerPool — manages all active Worker processes.
 *
 * Account rules:
 * - acc2 and acc3 are the default worker accounts
 * - acc1 is only used when explicitly specified by the user
 * - Max 1 concurrent worker per account (rate limit safety)
 */

import { v4 as uuid } from 'uuid';
import { EventEmitter } from 'events';
import { Worker } from './worker.js';
import { WorkerStore } from './store.js';
import { detectAccounts } from '../agent/subprocess-client.js';
import { logger } from '../utils/logger.js';
import type {
  WorkerConfig, WorkerTask, WorkerStep,
  ApprovalRequest, WorkerState, WorkerSummary, ApprovalAction,
} from './types.js';

const MAX_WORKERS_PER_ACCOUNT = 1; // Claude Pro rate limit safety
const DEFAULT_WORKER_ACCOUNTS = ['acc2', 'acc3']; // acc1 excluded by default

export class WorkerPool extends EventEmitter {
  private workers: Map<string, {
    config: WorkerConfig;
    worker: Worker;
    task: WorkerTask | null;
  }> = new Map();

  private store: WorkerStore;
  private availableAccounts: string[];

  constructor(store: WorkerStore) {
    super();
    this.store = store;

    // Only use accounts that actually have credentials
    const detected = detectAccounts().map(a => a.id);
    this.availableAccounts = DEFAULT_WORKER_ACCOUNTS.filter(id => detected.includes(id));

    if (this.availableAccounts.length === 0) {
      logger.warn('WorkerPool', 'No worker accounts (acc2/acc3) found — workers will require explicit account');
    } else {
      logger.info('WorkerPool', `Worker accounts available: ${this.availableAccounts.join(', ')}`);
    }
  }

  // ─── Account Allocation ───────────────────────────────────────

  /**
   * Pick the least-busy worker account.
   * forceAccount bypasses the default list (allows acc1 when explicitly requested).
   */
  allocateAccount(forceAccount?: string): string | null {
    if (forceAccount) {
      const detected = detectAccounts().map(a => a.id);
      return detected.includes(forceAccount) ? forceAccount : null;
    }

    const usage: Record<string, number> = {};
    for (const acc of this.availableAccounts) usage[acc] = 0;

    for (const [, entry] of this.workers) {
      if (entry.worker.isRunning) {
        const acc = entry.config.accountId;
        usage[acc] = (usage[acc] || 0) + 1;
      }
    }

    // Return account with fewest workers under the limit
    for (const acc of this.availableAccounts) {
      if ((usage[acc] || 0) < MAX_WORKERS_PER_ACCOUNT) return acc;
    }

    return null; // All accounts at capacity
  }

  // ─── Worker Lifecycle ─────────────────────────────────────────

  createWorker(projectName: string, projectPath: string, forceAccount?: string): WorkerConfig | null {
    const accountId = this.allocateAccount(forceAccount);
    if (!accountId) {
      logger.warn('WorkerPool', `No available account for "${projectName}"`);
      return null;
    }

    const config: WorkerConfig = {
      id: uuid(),
      accountId,
      projectName,
      projectPath,
      createdAt: new Date().toISOString(),
    };

    const worker = new Worker(config.id, accountId, projectPath);

    // Stream stdout chunks to gateway listeners
    worker.on('output', (data: { workerId: string; chunk: string }) => {
      this.emit('worker.output', { ...data, projectName, accountId });
    });

    this.workers.set(config.id, { config, worker, task: null });
    this.store.saveWorker(config);

    this.emit('worker.event', {
      type: 'worker.spawned',
      data: { workerId: config.id, accountId, projectName, state: 'idle' as WorkerState },
    });

    logger.info('WorkerPool', `Worker ${config.id.slice(0, 8)} → "${projectName}" on ${accountId}`);
    return config;
  }

  killWorker(workerId: string): void {
    const entry = this.workers.get(workerId);
    if (!entry) return;
    entry.worker.kill();
    this.workers.delete(workerId);

    this.emit('worker.event', {
      type: 'worker.killed',
      data: { workerId, accountId: entry.config.accountId, projectName: entry.config.projectName, state: 'done' as WorkerState },
    });
  }

  // ─── Task Management ──────────────────────────────────────────

  assignTask(workerId: string, title: string, description: string, mcTaskId?: string): WorkerTask {
    const entry = this.workers.get(workerId);
    if (!entry) throw new Error(`Worker ${workerId} not found`);

    const task: WorkerTask = {
      id: uuid(),
      workerId,
      mcTaskId: mcTaskId || null,
      title,
      description,
      steps: [],
      state: 'idle',
      pendingApprovalId: null,
      assignedAt: new Date().toISOString(),
      completedAt: null,
    };

    entry.task = task;
    this.store.saveTask(task);
    return task;
  }

  async executeStep(workerId: string, prompt: string, systemPrompt?: string): Promise<WorkerStep> {
    const entry = this.workers.get(workerId);
    if (!entry) throw new Error(`Worker ${workerId} not found`);
    if (!entry.task) throw new Error(`Worker ${workerId} has no task assigned`);

    const task = entry.task;
    task.state = 'running';

    const step: WorkerStep = {
      id: uuid(),
      workerId,
      stepNumber: task.steps.length + 1,
      prompt,
      output: '',
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationMs: null,
    };

    task.steps.push(step);
    this.store.saveTask(task);

    this.emit('worker.event', {
      type: 'worker.step_started',
      data: {
        workerId,
        accountId: entry.config.accountId,
        projectName: entry.config.projectName,
        state: 'running' as WorkerState,
        stepNumber: step.stepNumber,
        taskTitle: task.title,
      },
    });

    try {
      const result = await entry.worker.executeStep(prompt, systemPrompt);

      step.output = result.result;
      step.status = 'completed';
      step.completedAt = new Date().toISOString();
      step.durationMs = result.durationMs;
      task.state = 'awaiting_review';

      this.store.saveStep(step);
      this.store.saveTask(task);

      this.emit('worker.event', {
        type: 'worker.step_completed',
        data: {
          workerId,
          accountId: entry.config.accountId,
          projectName: entry.config.projectName,
          state: 'awaiting_review' as WorkerState,
          stepNumber: step.stepNumber,
          output: result.result.slice(0, 3000),
          durationMs: result.durationMs,
          taskTitle: task.title,
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      step.status = 'error';
      step.output = errorMsg;
      step.completedAt = new Date().toISOString();
      task.state = 'error';

      this.store.saveStep(step);
      this.store.saveTask(task);

      this.emit('worker.event', {
        type: 'worker.error',
        data: {
          workerId,
          accountId: entry.config.accountId,
          projectName: entry.config.projectName,
          state: 'error' as WorkerState,
          error: errorMsg,
          taskTitle: task.title,
        },
      });
    }

    return step;
  }

  // ─── Approvals ────────────────────────────────────────────────

  createApproval(workerId: string, action: ApprovalAction, description: string, details: string): ApprovalRequest {
    const entry = this.workers.get(workerId);
    if (!entry || !entry.task) throw new Error(`Worker ${workerId} has no active task`);

    const approval: ApprovalRequest = {
      id: uuid(),
      workerId,
      taskId: entry.task.id,
      action,
      description,
      details,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolution: null,
    };

    entry.task.state = 'needs_approval';
    entry.task.pendingApprovalId = approval.id;
    this.store.saveApproval(approval);
    this.store.saveTask(entry.task);

    this.emit('worker.event', {
      type: 'worker.needs_approval',
      data: {
        workerId,
        accountId: entry.config.accountId,
        projectName: entry.config.projectName,
        state: 'needs_approval' as WorkerState,
        approvalId: approval.id,
        action,
        description,
        details: details.slice(0, 1000),
        taskTitle: entry.task.title,
      },
    });

    return approval;
  }

  resolveApproval(approvalId: string, resolution: 'approved' | 'rejected'): ApprovalRequest {
    const approval = this.store.getApproval(approvalId);
    if (!approval) throw new Error(`Approval ${approvalId} not found`);
    if (approval.resolution) throw new Error(`Approval already resolved: ${approval.resolution}`);

    approval.resolvedAt = new Date().toISOString();
    approval.resolution = resolution;
    this.store.saveApproval(approval);

    const entry = this.workers.get(approval.workerId);
    if (entry && entry.task) {
      entry.task.pendingApprovalId = null;
      if (resolution === 'rejected') {
        entry.task.state = 'done';
        entry.task.completedAt = new Date().toISOString();
      } else {
        entry.task.state = 'awaiting_review'; // will be moved to running when next step fires
      }
      this.store.saveTask(entry.task);
    }

    this.emit('worker.event', {
      type: resolution === 'approved' ? 'worker.approved' : 'worker.rejected',
      data: {
        workerId: approval.workerId,
        accountId: entry?.config.accountId || '',
        projectName: entry?.config.projectName || '',
        state: (resolution === 'approved' ? 'running' : 'done') as WorkerState,
        approvalId,
        resolution,
      },
    });

    return approval;
  }

  markDone(workerId: string): void {
    const entry = this.workers.get(workerId);
    if (!entry || !entry.task) return;
    entry.task.state = 'done';
    entry.task.completedAt = new Date().toISOString();
    this.store.saveTask(entry.task);

    this.emit('worker.event', {
      type: 'worker.done',
      data: {
        workerId,
        accountId: entry.config.accountId,
        projectName: entry.config.projectName,
        state: 'done' as WorkerState,
        taskTitle: entry.task.title,
      },
    });
  }

  // ─── Queries ──────────────────────────────────────────────────

  getWorkerEntry(id: string) { return this.workers.get(id); }

  listWorkers(): WorkerSummary[] {
    return Array.from(this.workers.values()).map(e => ({
      id: e.config.id,
      accountId: e.config.accountId,
      projectName: e.config.projectName,
      state: e.task?.state || 'idle',
      taskTitle: e.task?.title || null,
      stepCount: e.task?.steps.length || 0,
      createdAt: e.config.createdAt,
      pendingApprovalId: e.task?.pendingApprovalId || null,
    }));
  }

  getPendingApprovals(): ApprovalRequest[] {
    return this.store.getPendingApprovals();
  }

  getWorkerLogs(workerId: string): WorkerStep[] {
    return this.store.getStepsForWorker(workerId);
  }
}
