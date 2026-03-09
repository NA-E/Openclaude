/**
 * Master-Worker type definitions.
 *
 * Workers are Claude CLI processes spawned by the Master (Gateway) to
 * autonomously work on project directories. The Master reviews their output
 * and gates destructive actions (git push, deploy) behind user approval.
 */

export type WorkerState =
  | 'idle'             // Created, waiting for task
  | 'running'          // Executing a step
  | 'awaiting_review'  // Step completed, Master deciding next action
  | 'needs_approval'   // Worker ready to push/deploy — waiting for user
  | 'error'            // Step failed or worker stuck
  | 'done';            // Task complete

export type ApprovalAction = 'git_push' | 'deploy' | 'npm_publish' | 'destructive';

export interface WorkerConfig {
  id: string;
  accountId: string;   // 'acc2' | 'acc3' | 'acc1' (only if explicit)
  projectName: string;
  projectPath: string;
  createdAt: string;
}

export interface WorkerStep {
  id: string;
  workerId: string;
  stepNumber: number;
  prompt: string;
  output: string;
  status: 'running' | 'completed' | 'error' | 'timeout';
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface WorkerTask {
  id: string;
  workerId: string;
  mcTaskId: string | null;  // Optional link to Mission Control task
  title: string;
  description: string;
  steps: WorkerStep[];
  state: WorkerState;
  pendingApprovalId: string | null;
  assignedAt: string;
  completedAt: string | null;
}

export interface ApprovalRequest {
  id: string;
  workerId: string;
  taskId: string;
  action: ApprovalAction;
  description: string;    // Human-readable: "Push 3 commits to origin/main"
  details: string;        // Full context from worker output
  createdAt: string;
  resolvedAt: string | null;
  resolution: 'approved' | 'rejected' | null;
}

export interface WorkerSummary {
  id: string;
  accountId: string;
  projectName: string;
  state: WorkerState;
  taskTitle: string | null;
  stepCount: number;
  createdAt: string;
  pendingApprovalId: string | null;
}
