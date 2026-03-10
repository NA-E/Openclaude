/**
 * Worker — wraps a single `claude --dangerously-skip-permissions` subprocess.
 *
 * Key differences from SubprocessClient:
 * - Uses --dangerously-skip-permissions (workers need real file access)
 * - stdio: ['pipe', 'pipe', 'pipe'] — stdin kept OPEN (fixes the hang with that flag)
 * - cwd set to project directory (workers work IN the project)
 * - 10-minute timeout per step (coding tasks take time)
 * - Emits 'output' events for real-time dashboard streaming
 */

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';

const STEP_TIMEOUT_MS = 600_000; // 10 minutes per step

interface ClaudeJsonResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd: number;
}

export interface StepResult {
  result: string;
  raw: string;
  durationMs: number;
}

export class Worker extends EventEmitter {
  readonly id: string;
  readonly accountId: string;
  readonly projectPath: string;
  private configDir: string;
  private currentProcess: ChildProcess | null = null;

  constructor(id: string, accountId: string, projectPath: string) {
    super();
    this.id = id;
    this.accountId = accountId;
    this.projectPath = projectPath;
    this.configDir = join(homedir(), `.claude-${accountId}`);
  }

  /**
   * Execute one step of work in the project directory.
   * Emits 'output' events as stdout arrives (for real-time dashboard streaming).
   */
  async executeStep(prompt: string, systemPrompt?: string): Promise<StepResult> {
    const startTime = Date.now();

    const args = [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--no-session-persistence',
      '--model', 'claude-sonnet-4-6',
    ];

    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    const env = { ...process.env, CLAUDE_CONFIG_DIR: this.configDir } as Record<string, string | undefined>;
    // Set to empty string instead of delete — delete doesn't always work on Windows
    // due to case-insensitive env proxy (see CLAUDE.md subprocess rules)
    env['CLAUDECODE'] = '';
    env['ANTHROPIC_API_KEY'] = '';
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'CLAUDECODE') env[key] = '';
    }

    logger.info('Worker', `[${this.id.slice(0, 8)}] Step starting in ${this.projectPath}`);

    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, {
        env,
        cwd: this.projectPath,          // Run IN the project directory
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'], // stdin=pipe (open but unused) — fixes the hang
      });

      this.currentProcess = proc;
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        reject(new Error(`Step timed out after ${STEP_TIMEOUT_MS / 1000}s`));
      }, STEP_TIMEOUT_MS);

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        // Emit for real-time dashboard streaming
        this.emit('output', { workerId: this.id, chunk: text });
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProcess = null;
        if (timedOut) return;

        const durationMs = Date.now() - startTime;
        logger.info('Worker', `[${this.id.slice(0, 8)}] Step done in ${Math.round(durationMs / 1000)}s (exit ${code})`);

        if (code !== 0 && !stdout) {
          return reject(new Error(`Worker exited ${code}: ${stderr.slice(0, 500)}`));
        }

        // Try to parse as JSON result from --output-format json
        let result = stdout.trim();
        try {
          const parsed = JSON.parse(stdout.trim()) as ClaudeJsonResult;
          if (parsed.is_error) {
            return reject(new Error(`Claude error: ${parsed.result}`));
          }
          result = parsed.result || result;
        } catch {
          // Not JSON — use raw stdout (some claude versions output plain text)
        }

        resolve({ result, raw: stdout, durationMs });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.currentProcess = null;
        reject(new Error(`Failed to spawn worker: ${err.message}`));
      });
    });
  }

  kill(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
      logger.info('Worker', `[${this.id.slice(0, 8)}] Killed`);
    }
  }

  get isRunning(): boolean {
    return this.currentProcess !== null;
  }
}
