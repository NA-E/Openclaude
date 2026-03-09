/**
 * WorkerOrchestrator — task decomposition brain for the Master-Worker system.
 *
 * Responsibilities:
 * - Build system prompts that instruct workers on the READY_TO_PUSH protocol
 * - Analyze worker output to detect signals (READY_TO_PUSH, TASK_COMPLETE, NEEDS_HELP)
 * - Build initial steps and continuation steps
 * - Bridge between WorkerPool and Gateway (coordinate approvals + follow-up steps)
 */

import { WorkerPool } from './pool.js';
import { logger } from '../utils/logger.js';
import type { WorkerTask, WorkerStep, ApprovalAction } from './types.js';

// Signals the worker can emit in its output
export type WorkerSignal =
  | { type: 'ready_to_push'; action: ApprovalAction; details: string }
  | { type: 'task_complete'; summary: string }
  | { type: 'needs_help'; question: string }
  | { type: 'in_progress'; summary: string };

const SIGNAL_PATTERNS = {
  READY_TO_PUSH: /READY_TO_PUSH(?:\[(\w+)\])?[:\s]+(.+?)(?:\n|$)/i,
  TASK_COMPLETE: /TASK_COMPLETE[:\s]+(.+?)(?:\n|$)/i,
  NEEDS_HELP: /NEEDS_HELP[:\s]+(.+?)(?:\n|$)/i,
};

export class WorkerOrchestrator {
  private pool: WorkerPool;

  constructor(pool: WorkerPool) {
    this.pool = pool;
  }

  // ─── System Prompt ────────────────────────────────────────────

  buildWorkerSystemPrompt(projectName: string, taskTitle: string): string {
    return `You are a worker agent assigned to a coding task in the project "${projectName}".

## Your Role
Task: ${taskTitle}

You have full file system access via --dangerously-skip-permissions. Work autonomously to complete the task.

## Communication Protocol (CRITICAL)
You MUST use these exact signals when appropriate:

**READY_TO_PUSH[action]: description**
Use this BEFORE any git push, deploy, npm publish, or destructive operation.
The action type must be one of: git_push, deploy, npm_publish, destructive
Wait for human approval before proceeding. Do NOT actually push/deploy until approved.

Examples:
  READY_TO_PUSH[git_push]: Completed feature X, ready to push to origin/main
  READY_TO_PUSH[deploy]: Docker image built, ready to deploy to production
  READY_TO_PUSH[destructive]: About to drop table users, requires approval

**TASK_COMPLETE: summary**
Use this when the task is fully done (no push needed).
Example: TASK_COMPLETE: Refactored auth module, all tests pass

**NEEDS_HELP: question**
Use this if you're blocked and need human input.
Example: NEEDS_HELP: The API endpoint returns 403 — do you have credentials?

## Rules
- Write clean, working code
- Run tests if available (npm test, npx vitest, etc.)
- Do NOT git push, deploy, or run destructive commands without signaling first
- Be concise in your output — focus on what you did and what's next
- If unsure about scope, ask via NEEDS_HELP rather than guessing`;
  }

  // ─── Step Builders ────────────────────────────────────────────

  buildInitialStep(taskDescription: string): string {
    return `${taskDescription}

Start by reading the relevant files to understand the current state, then proceed with the implementation. When you're done with the coding work and ready to push/deploy, signal READY_TO_PUSH. If you complete everything without a push, signal TASK_COMPLETE.`;
  }

  buildContinuationStep(previousOutput: string, instruction: string): string {
    return `Previous step output:
---
${previousOutput.slice(0, 2000)}
---

Continue: ${instruction}`;
  }

  buildPostApprovalStep(action: ApprovalAction): string {
    const instructions: Record<ApprovalAction, string> = {
      git_push: 'You have been approved to push. Run git push now and confirm it succeeded.',
      deploy: 'You have been approved to deploy. Proceed with the deployment and confirm the result.',
      npm_publish: 'You have been approved to publish. Run npm publish and confirm it succeeded.',
      destructive: 'You have been approved to proceed with the destructive operation. Run it carefully and confirm the result.',
    };
    return instructions[action];
  }

  // ─── Output Analysis ──────────────────────────────────────────

  analyzeOutput(output: string): WorkerSignal {
    const pushMatch = output.match(SIGNAL_PATTERNS.READY_TO_PUSH);
    if (pushMatch) {
      const rawAction = (pushMatch[1] || 'git_push').toLowerCase();
      const action = this.normalizeAction(rawAction);
      return { type: 'ready_to_push', action, details: pushMatch[2]?.trim() || 'Awaiting approval' };
    }

    const completeMatch = output.match(SIGNAL_PATTERNS.TASK_COMPLETE);
    if (completeMatch) {
      return { type: 'task_complete', summary: completeMatch[1]?.trim() || 'Task finished' };
    }

    const helpMatch = output.match(SIGNAL_PATTERNS.NEEDS_HELP);
    if (helpMatch) {
      return { type: 'needs_help', question: helpMatch[1]?.trim() || 'Worker needs input' };
    }

    // No signal — still working
    const lastLine = output.trim().split('\n').pop() || '';
    return { type: 'in_progress', summary: lastLine.slice(0, 200) };
  }

  private normalizeAction(raw: string): ApprovalAction {
    if (raw.includes('deploy')) return 'deploy';
    if (raw.includes('publish')) return 'npm_publish';
    if (raw.includes('destruct') || raw.includes('drop') || raw.includes('delete')) return 'destructive';
    return 'git_push';
  }

  // ─── High-Level Task Dispatch ─────────────────────────────────

  /**
   * Dispatch a task to a worker and execute the first step.
   * The caller (Gateway) should listen to pool events for subsequent steps.
   *
   * Returns the first WorkerStep. Gateway picks it up and handles
   * signal routing (approval requests, done events, etc.).
   */
  async dispatch(
    workerId: string,
    title: string,
    description: string,
    projectName: string,
    mcTaskId?: string,
  ): Promise<{ task: WorkerTask; step: WorkerStep; signal: WorkerSignal }> {
    const task = this.pool.assignTask(workerId, title, description, mcTaskId);
    logger.info('WorkerOrchestrator', `Dispatched task "${title}" → worker ${workerId.slice(0, 8)}`);

    const systemPrompt = this.buildWorkerSystemPrompt(projectName, title);
    const prompt = this.buildInitialStep(description);

    const step = await this.pool.executeStep(workerId, prompt, systemPrompt);
    const signal = this.analyzeOutput(step.output);

    logger.info('WorkerOrchestrator', `Step 1 signal: ${signal.type} — ${workerId.slice(0, 8)}`);

    // Handle terminal signals immediately
    if (signal.type === 'task_complete') {
      this.pool.markDone(workerId);
    } else if (signal.type === 'ready_to_push') {
      this.pool.createApproval(
        workerId,
        signal.action,
        `Worker ready to ${signal.action.replace('_', ' ')} on "${projectName}"`,
        signal.details,
      );
    }

    return { task, step, signal };
  }

  /**
   * Continue a worker after a step (non-terminal signal or manual instruction).
   */
  async continueWorker(
    workerId: string,
    previousOutput: string,
    instruction: string,
    projectName: string,
    taskTitle: string,
  ): Promise<{ step: WorkerStep; signal: WorkerSignal }> {
    const systemPrompt = this.buildWorkerSystemPrompt(projectName, taskTitle);
    const prompt = this.buildContinuationStep(previousOutput, instruction);

    const step = await this.pool.executeStep(workerId, prompt, systemPrompt);
    const signal = this.analyzeOutput(step.output);

    logger.info('WorkerOrchestrator', `Continue step signal: ${signal.type} — ${workerId.slice(0, 8)}`);

    if (signal.type === 'task_complete') {
      this.pool.markDone(workerId);
    } else if (signal.type === 'ready_to_push') {
      this.pool.createApproval(
        workerId,
        signal.action,
        `Worker ready to ${signal.action.replace('_', ' ')} on "${projectName}"`,
        signal.details,
      );
    }

    return { step, signal };
  }

  /**
   * Execute the post-approval step after user approves an action.
   */
  async proceedAfterApproval(
    workerId: string,
    approvalId: string,
    action: ApprovalAction,
    projectName: string,
    taskTitle: string,
  ): Promise<{ step: WorkerStep; signal: WorkerSignal }> {
    this.pool.resolveApproval(approvalId, 'approved');

    const systemPrompt = this.buildWorkerSystemPrompt(projectName, taskTitle);
    const prompt = this.buildPostApprovalStep(action);

    const step = await this.pool.executeStep(workerId, prompt, systemPrompt);
    const signal = this.analyzeOutput(step.output);

    if (signal.type === 'task_complete' || signal.type === 'in_progress') {
      this.pool.markDone(workerId);
    }

    return { step, signal };
  }
}
