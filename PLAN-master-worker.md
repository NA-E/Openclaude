# Master-Worker Architecture Plan

## What We're Building

OpenClaude becomes the **Master** that spawns Claude Code CLI instances (Workers) to autonomously work on your projects. Workers run `claude --dangerously-skip-permissions` in the project directory. Master reviews their output and asks your approval before any git push.

## Account Rules
- **acc2 + acc3** = worker accounts by default
- **acc1** = only used if you explicitly say so
- Master (gateway) continues using whichever account you select in the Runtime panel

## Worker Flow
```
You: "Fix the login bug in nourin-portfolio"
  → Master picks acc2 or acc3 (least busy)
  → Spawns Claude CLI in E:/1.Claude Code/nourin-portfolio/
  → Worker edits files, runs tests, commits
  → Worker says "READY_TO_PUSH"
  → Dashboard shows approval banner
  → You click Approve
  → Worker runs git push, reports result
  → Task marked done
```

## New Files

### `src/workers/types.ts`
Worker state machine types, ApprovalRequest, WorkerTask, WorkerStep, WorkerEvent.

### `src/workers/worker.ts`
Single Claude CLI wrapper. Key differences from SubprocessClient:
- Uses `--dangerously-skip-permissions` (workers need file access)
- `stdio: ['pipe', 'pipe', 'pipe']` (stdin open — fixes the hang)
- `cwd` = project directory
- 10-minute timeout per step (coding takes time)
- Real-time stdout streaming via EventEmitter

### `src/workers/pool.ts`
WorkerPool class:
- Allocates accounts (acc2/acc3 by default, acc1 only if forced)
- Max 1 active worker per account (rate limit safety)
- Tracks all workers + their state
- Forwards real-time output to Gateway via events

### `src/workers/orchestrator.ts`
WorkerOrchestrator class:
- Builds worker system prompts with rules (no push without approval)
- Detects READY_TO_PUSH / TASK_COMPLETE / NEEDS_HELP in output
- Chains steps: analyzes each output, decides next action
- Max 10 steps per task (safety limit)
- Builds post-approval steps ("user approved, run git push now")

### `src/workers/store.ts`
JSON file persistence at `~/.openclaude/workers/workers.json`
Stores: worker history, all tasks, all steps, all approval requests

## Gateway Changes (`src/gateway/server.ts`)
Add WorkerPool + WorkerOrchestrator to constructor.
Add new HTTP routes:

```
GET  /api/workers                     — list all workers + state
POST /api/workers                     — create worker for project
DELETE /api/workers/:id               — kill worker
POST /api/workers/dispatch            — HIGH LEVEL: give task, Master handles everything
POST /api/workers/:id/step            — execute next step manually
POST /api/workers/:id/continue        — auto-continue (Master decides next step)
GET  /api/workers/approvals           — pending approvals
POST /api/workers/approvals/:id/approve
POST /api/workers/approvals/:id/reject
GET  /api/workers/:id/logs            — full output log
```

Forward worker WebSocket events: `worker.spawned`, `worker.step_started`, `worker.step_output`, `worker.step_completed`, `worker.needs_approval`, `worker.done`, `worker.error`

## Type Changes (`src/types/index.ts`)
Add worker event types to GatewayEvent union.
Add `activeWorkers`, `pendingApprovals` to SystemStatus.

## Dashboard UI Changes (`ui/dashboard/index.html`)
1. **Workers panel** in right sidebar:
   - List of active workers with account badge, project, state, step count
   - Real-time output log (last 20 lines, auto-scroll)
   - "Dispatch Task" button → modal to pick project + describe task
   - Kill button per worker

2. **Approval banner** (fixed top, appears when push needed):
   - What the worker wants to push
   - Approve / Reject buttons
   - Summary of changes

3. **Topbar** shows pending approval count badge

## Worker Rules (injected into system prompt)
Workers are told:
- DO: edit files, run tests, install packages, create branches, commit
- DON'T: git push, deploy — say READY_TO_PUSH instead
- Say TASK_COMPLETE when done
- Say NEEDS_HELP: <description> if stuck

## Build Sequence
1. `src/workers/types.ts` + `src/workers/store.ts`
2. `src/workers/worker.ts` (test --dangerously-skip-permissions with stdin:pipe)
3. `src/workers/pool.ts`
4. `src/workers/orchestrator.ts`
5. Gateway integration + routes
6. Type extensions
7. Dashboard UI (workers panel + approval banner)
