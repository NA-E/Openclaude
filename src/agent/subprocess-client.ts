/**
 * SubprocessClient — replaces the Anthropic SDK by calling `claude -p` as a subprocess.
 *
 * Uses Claude Code's own authentication (OAuth via ~/.claude-acc1) so no API key needed.
 * Limitation: no custom tool_use; agents respond with text only. Mission Control tools
 * can be added later by exposing them as MCP servers passed via --mcp-config.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { logger } from '../utils/logger.js';
import { diagnostics } from '../utils/diagnostics.js';

export interface SubprocessMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export interface SubprocessCreateOptions {
  model: string;
  max_tokens: number;
  system: string;
  messages: SubprocessMessage[];
  tools?: unknown[];
}

/** Minimal response shaped like Anthropic SDK's Message */
export interface SubprocessResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  stop_reason: 'end_turn';
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

interface ClaudeJsonResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd: number;
}

let currentConfigDir = join(homedir(), '.claude-acc1');
const MAX_HISTORY_CHARS = 8000; // Keep history concise to avoid --append-system-prompt limits

/** Available Claude accounts (detected at startup) */
export function detectAccounts(): Array<{ id: string; dir: string; subscriptionType: string; expiresAt: number }> {
  const home = homedir();
  const accounts: Array<{ id: string; dir: string; subscriptionType: string; expiresAt: number }> = [];
  for (let i = 1; i <= 5; i++) {
    const dir = join(home, `.claude-acc${i}`);
    const credPath = join(dir, '.credentials.json');
    try {
      if (existsSync(credPath)) {
        const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
        const oauth = creds.claudeAiOauth;
        accounts.push({
          id: `acc${i}`,
          dir,
          subscriptionType: oauth?.subscriptionType || 'unknown',
          expiresAt: oauth?.expiresAt || 0,
        });
      }
    } catch { /* skip */ }
  }
  return accounts;
}

/** Get the current account ID */
export function getCurrentAccountId(): string {
  const match = currentConfigDir.match(/\.claude-acc(\d+)/);
  return match ? `acc${match[1]}` : 'acc1';
}

/** Switch to a different account */
export function setAccount(accountId: string): void {
  const home = homedir();
  const dir = join(home, `.claude-${accountId}`);
  if (!existsSync(join(dir, '.credentials.json'))) {
    throw new Error(`Account ${accountId} not found or has no credentials`);
  }
  currentConfigDir = dir;
  logger.info('SubprocessClient', `Switched to account: ${accountId} (${dir})`);
}

function extractText(content: SubprocessMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text as string)
    .join('');
}

function buildHistoryBlock(messages: SubprocessMessage[]): string {
  if (messages.length === 0) return '';
  const lines = messages.map((m) => `${m.role.toUpperCase()}: ${extractText(m.content)}`);
  const joined = lines.join('\n\n');
  // Truncate if too long, keeping the most recent messages
  if (joined.length > MAX_HISTORY_CHARS) {
    return joined.slice(-MAX_HISTORY_CHARS);
  }
  return joined;
}

const SUBPROCESS_TIMEOUT_MS = 300_000; // 5 minutes (--dangerously-skip-permissions needs more time)

function runClaude(opts: {
  message: string;
  systemPrompt: string;
  model: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', opts.message,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--no-session-persistence',
      '--model', opts.model,
    ];

    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    const env = { ...process.env, CLAUDE_CONFIG_DIR: currentConfigDir } as Record<string, string | undefined>;
    // Remove vars that block nested Claude Code execution — set to empty string
    // (delete doesn't always work on Windows due to case-insensitive env proxy)
    env['CLAUDECODE'] = '';
    env['ANTHROPIC_API_KEY'] = '';
    // Also handle any casing variants
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'CLAUDECODE') env[key] = '';
    }

    logger.info('SubprocessClient', `Calling claude -p (model: ${opts.model}, prompt: ${opts.systemPrompt.length} chars)`);
    const spawnedAt = Date.now();
    diagnostics.recordEvent('subprocess.start', { model: opts.model });

    const proc = spawn('claude', args, {
      env: env as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // Close stdin immediately — open pipe causes claude to wait for input on Windows
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      diagnostics.recordEvent('subprocess.timeout', { model: opts.model, afterMs: Date.now() - spawnedAt });
      reject(new Error(`claude subprocess timed out after ${SUBPROCESS_TIMEOUT_MS / 1000}s`));
    }, SUBPROCESS_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (stderr) {
        logger.warn('SubprocessClient', `stderr: ${stderr.slice(0, 500)}`);
      }
      const responseTimeMs = Date.now() - spawnedAt;
      logger.info('SubprocessClient', `claude exited code=${code}, stdout=${stdout.length} chars`);
      if (code !== 0 && !stdout) {
        diagnostics.recordEvent('subprocess.error', { model: opts.model, code, responseTimeMs, error: stderr.slice(0, 200) });
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
      try {
        const result = JSON.parse(stdout.trim()) as ClaudeJsonResult;
        if (result.is_error) {
          diagnostics.recordEvent('subprocess.error', { model: opts.model, responseTimeMs, error: result.result.slice(0, 200) });
          return reject(new Error(`Claude error: ${result.result}`));
        }
        diagnostics.recordEvent('subprocess.end', { model: opts.model, responseTimeMs });
        resolve(result.result);
      } catch {
        diagnostics.recordEvent('subprocess.end', { model: opts.model, responseTimeMs });
        resolve(stdout.trim() || 'No response');
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      diagnostics.recordEvent('subprocess.error', { model: opts.model, error: err.message });
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * Drop-in replacement for the Anthropic SDK client.
 * Only `messages.create()` is implemented; tool_use blocks are never returned.
 */
export class SubprocessClient {
  messages = {
    create: async (options: SubprocessCreateOptions): Promise<SubprocessResponse> => {
      // All messages except the last make up the history context
      const historyMessages = options.messages.slice(0, -1);
      const lastMessage = options.messages[options.messages.length - 1];
      const userText = lastMessage ? extractText(lastMessage.content) : '';

      const historyBlock = buildHistoryBlock(historyMessages);
      const systemWithHistory = historyBlock
        ? `${options.system}\n\n## Conversation History\n${historyBlock}`
        : options.system;

      const responseText = await runClaude({
        message: userText,
        systemPrompt: systemWithHistory,
        model: options.model,
      });

      return {
        id: `msg_subprocess_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
        model: options.model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  };
}
