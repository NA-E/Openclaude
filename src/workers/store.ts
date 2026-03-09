/**
 * WorkerStore — JSON file persistence for worker history, tasks, steps, approvals.
 * Mirrors the MissionControlDB pattern: local JSON file, no external dependencies.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';
import type { WorkerConfig, WorkerTask, WorkerStep, ApprovalRequest } from './types.js';

interface WorkerDatabase {
  workers: WorkerConfig[];
  tasks: WorkerTask[];
  steps: WorkerStep[];
  approvals: ApprovalRequest[];
}

export class WorkerStore {
  private db: WorkerDatabase;
  private dbPath: string;

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.dbPath = resolve(dataDir, 'workers.json');
    this.db = this.load();
    logger.info('WorkerStore', `Loaded ${this.db.workers.length} workers, ${this.db.approvals.filter(a => !a.resolution).length} pending approvals`);
  }

  private load(): WorkerDatabase {
    if (existsSync(this.dbPath)) {
      try { return JSON.parse(readFileSync(this.dbPath, 'utf-8')); }
      catch { /* start fresh */ }
    }
    return { workers: [], tasks: [], steps: [], approvals: [] };
  }

  private save(): void {
    try {
      writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2), 'utf-8');
    } catch (err) {
      logger.error('WorkerStore', 'Failed to save', err);
    }
  }

  // ─── Workers ─────────────────────────────────────────────────

  saveWorker(config: WorkerConfig): void {
    const idx = this.db.workers.findIndex(w => w.id === config.id);
    if (idx >= 0) this.db.workers[idx] = config;
    else this.db.workers.push(config);
    this.save();
  }

  getWorkerHistory(limit = 100): WorkerConfig[] {
    return this.db.workers.slice(-limit);
  }

  // ─── Tasks ───────────────────────────────────────────────────

  saveTask(task: WorkerTask): void {
    const idx = this.db.tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) this.db.tasks[idx] = task;
    else this.db.tasks.push(task);
    this.save();
  }

  getTask(id: string): WorkerTask | undefined {
    return this.db.tasks.find(t => t.id === id);
  }

  getTasksForWorker(workerId: string): WorkerTask[] {
    return this.db.tasks.filter(t => t.workerId === workerId);
  }

  // ─── Steps ───────────────────────────────────────────────────

  saveStep(step: WorkerStep): void {
    const idx = this.db.steps.findIndex(s => s.id === step.id);
    if (idx >= 0) this.db.steps[idx] = step;
    else this.db.steps.push(step);
    this.save();
  }

  getStepsForWorker(workerId: string): WorkerStep[] {
    return this.db.steps.filter(s => s.workerId === workerId);
  }

  // ─── Approvals ───────────────────────────────────────────────

  saveApproval(approval: ApprovalRequest): void {
    const idx = this.db.approvals.findIndex(a => a.id === approval.id);
    if (idx >= 0) this.db.approvals[idx] = approval;
    else this.db.approvals.push(approval);
    this.save();
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.db.approvals.find(a => a.id === id);
  }

  getPendingApprovals(): ApprovalRequest[] {
    return this.db.approvals.filter(a => a.resolution === null);
  }

  getAllApprovals(limit = 50): ApprovalRequest[] {
    return this.db.approvals.slice(-limit);
  }
}
